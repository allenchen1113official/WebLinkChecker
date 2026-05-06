#!/usr/bin/env python3
"""
Website Link Checker
Crawls all pages under a given website and reports broken links.
"""

import sys
import time
import argparse
import csv
import json
import threading
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from colorama import Fore, Style, init

init(autoreset=True)

BROKEN_STATUS_THRESHOLD = 400


@dataclass
class LinkResult:
    url: str
    status_code: Optional[int]
    error: Optional[str]
    found_on: list[str] = field(default_factory=list)
    link_text: str = ""

    @property
    def is_broken(self) -> bool:
        if self.error:
            return True
        return self.status_code is not None and self.status_code >= BROKEN_STATUS_THRESHOLD

    @property
    def status_label(self) -> str:
        if self.error:
            return f"ERROR: {self.error}"
        return str(self.status_code)


def build_session(timeout: int, user_agent: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})
    session.max_redirects = 10
    return session


def get_base_domain(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def is_same_domain(url: str, base: str) -> bool:
    return urlparse(url).netloc == urlparse(base).netloc


def is_under_start_path(url: str, start_url: str) -> bool:
    """True if url is on the same domain AND under start_url's directory path."""
    pu = urlparse(url)
    ps = urlparse(start_url)
    if pu.netloc != ps.netloc:
        return False
    base_path = ps.path if ps.path.endswith("/") else ps.path.rsplit("/", 1)[0] + "/"
    return pu.path.startswith(base_path)


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(fragment="").geturl()


def _extract_links_with_text(html: str, page_url: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    links = []
    for tag in soup.find_all("a", href=True):
        href = tag["href"].strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = normalize_url(urljoin(page_url, href))
        links.append((absolute, tag.get_text(strip=True)))
    return links


def extract_links(html: str, page_url: str) -> list[str]:
    return [url for url, _ in _extract_links_with_text(html, page_url)]


def _parse_sitemap_urls(
    session: requests.Session,
    sitemap_url: str,
    base_origin: str,
    timeout: int,
    depth: int = 0,
) -> list[str]:
    """Recursively parse a sitemap (or sitemap index) and return same-domain URLs."""
    if depth > 3:
        return []
    urls: list[str] = []
    try:
        resp = session.get(sitemap_url, timeout=timeout, allow_redirects=True)
        if resp.status_code != 200:
            return urls
        root = ET.fromstring(resp.content)
        ns = (root.tag.split("}")[0].lstrip("{") + "}") if "}" in root.tag else ""
        tag_local = root.tag.replace(ns, "") if ns else root.tag
        if tag_local == "sitemapindex":
            for loc in root.findall(f"{ns}sitemap/{ns}loc"):
                if loc.text:
                    urls.extend(_parse_sitemap_urls(
                        session, loc.text.strip(), base_origin, timeout, depth + 1
                    ))
        else:
            for loc in root.findall(f"{ns}url/{ns}loc"):
                if loc.text:
                    u = normalize_url(loc.text.strip())
                    if u.startswith(base_origin):
                        urls.append(u)
    except Exception:
        pass
    return urls


def _load_sitemap(
    session: requests.Session,
    start_url: str,
    timeout: int,
) -> list[str]:
    """Discover all pages via sitemap.xml (robots.txt Sitemap: directive as fallback)."""
    parsed = urlparse(start_url)
    base_origin = f"{parsed.scheme}://{parsed.netloc}"
    sitemap_url = base_origin + "/sitemap.xml"
    try:
        resp = session.get(base_origin + "/robots.txt", timeout=timeout, allow_redirects=True)
        if resp.status_code == 200:
            for line in resp.text.splitlines():
                if line.lower().startswith("sitemap:"):
                    sitemap_url = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass
    return _parse_sitemap_urls(session, sitemap_url, base_origin, timeout)


def check_url(
    session: requests.Session, url: str, timeout: int
) -> tuple[Optional[int], Optional[str]]:
    try:
        resp = session.head(url, timeout=timeout, allow_redirects=True)
        if resp.status_code in (405, 501):
            resp = session.get(url, timeout=timeout, allow_redirects=True, stream=True)
            resp.close()
        return resp.status_code, None
    except requests.exceptions.TooManyRedirects:
        return None, "Too many redirects"
    except requests.exceptions.SSLError as e:
        return None, f"SSL error: {e}"
    except requests.exceptions.ConnectionError:
        return None, "Connection error"
    except requests.exceptions.Timeout:
        return None, "Timeout"
    except requests.exceptions.RequestException as e:
        return None, str(e)


def crawl(
    start_url: str,
    session: requests.Session,
    timeout: int,
    delay: float,
    max_pages: int,
    verbose: bool,
    on_result: Optional[Callable[[LinkResult], None]] = None,
    on_status: Optional[Callable[[str], None]] = None,
    stop_event: Optional[threading.Event] = None,
) -> dict[str, LinkResult]:
    base = get_base_domain(start_url)
    pages_to_crawl: list[str] = [normalize_url(start_url)]
    queued: set[str] = {normalize_url(start_url)}   # O(1) membership check
    crawled: set[str] = set()
    results: dict[str, LinkResult] = {}
    pages_crawled = 0

    def _status(msg: str) -> None:
        if on_status:
            on_status(msg)
        if verbose:
            print(f"  {Fore.BLUE}{msg}{Style.RESET_ALL}")

    def _ensure(url: str) -> LinkResult:
        if url not in results:
            results[url] = LinkResult(url=url, status_code=None, error=None)
        return results[url]

    _status(f"Starting crawl: {start_url}")
    if verbose:
        print(f"\n{Fore.CYAN}Base domain: {base}{Style.RESET_ALL}\n")

    # Seed queue from sitemap.xml so orphan pages are also discovered
    _status("Loading sitemap...")
    for u in _load_sitemap(session, start_url, timeout):
        if not is_under_start_path(u, start_url):
            continue
        if u not in crawled and u not in queued:
            pages_to_crawl.append(u)
            queued.add(u)
            results[u] = LinkResult(url=u, status_code=None, error=None)
    if verbose and len(queued) > 1:
        print(f"{Fore.CYAN}Sitemap: {len(queued) - 1} additional pages queued{Style.RESET_ALL}")

    # Phase 1: crawl same-domain pages with GET
    while pages_to_crawl:
        if stop_event and stop_event.is_set():
            break

        page_url = pages_to_crawl.pop(0)
        if page_url in crawled:
            continue
        crawled.add(page_url)

        if max_pages and pages_crawled >= max_pages:
            break

        _status(f"Crawling: {page_url}")

        try:
            resp = session.get(page_url, timeout=timeout, allow_redirects=True)
            status = resp.status_code
            content_type = resp.headers.get("Content-Type", "")
        except requests.exceptions.RequestException as e:
            r = _ensure(page_url)
            r.status_code = None
            r.error = str(e)
            if on_result:
                on_result(r)
            continue

        r = _ensure(page_url)
        r.status_code = status
        r.error = None
        if on_result:
            on_result(r)

        if status < 400 and "text/html" in content_type:
            pages_crawled += 1
            links = _extract_links_with_text(resp.text, page_url)
            for link, text in links:
                lr = _ensure(link)
                if not lr.link_text and text:
                    lr.link_text = text
                if page_url not in lr.found_on:
                    lr.found_on.append(page_url)
                if is_under_start_path(link, start_url) and link not in crawled and link not in queued:
                    pages_to_crawl.append(link)
                    queued.add(link)

        if delay:
            time.sleep(delay)

    # Phase 2: check all unchecked links (external + unreached internal)
    unchecked = [r for r in results.values() if r.status_code is None and r.error is None]
    if unchecked:
        _status(f"Checking {len(unchecked)} remaining links...")
        for result in unchecked:
            if stop_event and stop_event.is_set():
                break
            _status(f"Checking: {result.url}")
            code, err = check_url(session, result.url, timeout)
            result.status_code = code
            result.error = err
            if on_result:
                on_result(result)
            if delay:
                time.sleep(delay)

    return results


def print_report(results: dict[str, LinkResult], show_ok: bool) -> None:
    broken = [r for r in results.values() if r.is_broken]
    ok_count = len(results) - len(broken)

    print(f"\n{'='*70}")
    print(f"{'LINK CHECK REPORT':^70}")
    print(f"{'='*70}")
    print(f"  Total links checked : {len(results)}")
    print(f"  {Fore.GREEN}OK                  : {ok_count}{Style.RESET_ALL}")
    print(f"  {Fore.RED}Broken              : {len(broken)}{Style.RESET_ALL}")
    print(f"  Scan time           : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*70}")

    if broken:
        print(f"\n{Fore.RED}{'BROKEN LINKS':^70}{Style.RESET_ALL}")
        print("-" * 70)
        for i, r in enumerate(broken, 1):
            print(f"\n{Fore.RED}[{i}] {r.url}{Style.RESET_ALL}")
            print(f"     Status  : {Fore.YELLOW}{r.status_label}{Style.RESET_ALL}")
            if r.found_on:
                print(f"     Found on:")
                for src in r.found_on:
                    print(f"       - {src}")
            else:
                print(f"     Found on: (start URL)")
    else:
        print(f"\n{Fore.GREEN}No broken links found!{Style.RESET_ALL}")

    if show_ok:
        ok = [r for r in results.values() if not r.is_broken]
        print(f"\n{Fore.GREEN}{'OK LINKS':^70}{Style.RESET_ALL}")
        print("-" * 70)
        for r in ok:
            print(f"  {Fore.GREEN}[{r.status_code}]{Style.RESET_ALL} {r.url}")

    print(f"\n{'='*70}\n")


def export_csv(results: dict[str, LinkResult], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["URL", "Link Text", "Status", "Error", "Broken", "Found On"])
        for r in results.values():
            writer.writerow([
                r.url,
                r.link_text,
                r.status_code or "",
                r.error or "",
                r.is_broken,
                " | ".join(r.found_on),
            ])
    print(f"{Fore.CYAN}CSV report saved to: {path}{Style.RESET_ALL}")


def export_json(results: dict[str, LinkResult], path: str) -> None:
    data = {
        "generated_at": datetime.now().isoformat(),
        "total": len(results),
        "broken_count": sum(1 for r in results.values() if r.is_broken),
        "links": [
            {
                "url": r.url,
                "link_text": r.link_text,
                "status_code": r.status_code,
                "error": r.error,
                "is_broken": r.is_broken,
                "found_on": r.found_on,
            }
            for r in results.values()
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"{Fore.CYAN}JSON report saved to: {path}{Style.RESET_ALL}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Website Link Checker — crawl a site and report broken links",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python link_checker.py https://example.com
  python link_checker.py https://example.com --timeout 10 --delay 0.5
  python link_checker.py https://example.com --output report.csv --format csv
  python link_checker.py https://example.com --output report.json --format json
  python link_checker.py https://example.com --max-pages 50 --verbose
        """,
    )
    parser.add_argument("url", help="Starting URL to crawl (e.g. https://example.com)")
    parser.add_argument("--timeout", type=int, default=15, metavar="SEC",
                        help="Request timeout in seconds (default: 15)")
    parser.add_argument("--delay", type=float, default=0.0, metavar="SEC",
                        help="Delay between requests in seconds (default: 0)")
    parser.add_argument("--max-pages", type=int, default=0, metavar="N",
                        help="Max pages to crawl (0 = unlimited, default: 0)")
    parser.add_argument("--user-agent", default="WebLinkChecker/1.0 (link-checker bot)",
                        metavar="UA", help="Custom User-Agent string")
    parser.add_argument("--output", metavar="FILE",
                        help="Save report to file (e.g. report.csv or report.json)")
    parser.add_argument("--format", choices=["csv", "json"], default="csv",
                        help="Output format when --output is specified (default: csv)")
    parser.add_argument("--show-ok", action="store_true",
                        help="Also list OK links in the console report")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print each URL as it is crawled/checked")
    parser.add_argument("--broken-only", action="store_true",
                        help="When exporting, include only broken links")

    args = parser.parse_args()

    parsed = urlparse(args.url)
    if not parsed.scheme or not parsed.netloc:
        print(f"{Fore.RED}Error: '{args.url}' does not look like a valid URL.{Style.RESET_ALL}")
        print("Please provide a full URL including scheme, e.g. https://example.com")
        sys.exit(1)

    session = build_session(args.timeout, args.user_agent)

    try:
        results = crawl(
            start_url=args.url,
            session=session,
            timeout=args.timeout,
            delay=args.delay,
            max_pages=args.max_pages,
            verbose=args.verbose,
        )
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Crawl interrupted by user.{Style.RESET_ALL}")
        sys.exit(0)

    print_report(results, show_ok=args.show_ok)

    if args.output:
        export_results = results
        if args.broken_only:
            export_results = {k: v for k, v in results.items() if v.is_broken}
        if args.format == "json":
            export_json(export_results, args.output)
        else:
            export_csv(export_results, args.output)

    broken_count = sum(1 for r in results.values() if r.is_broken)
    sys.exit(1 if broken_count > 0 else 0)


if __name__ == "__main__":
    main()
