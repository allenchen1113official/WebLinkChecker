"""Unit tests for link_checker.py"""
import threading
from unittest.mock import MagicMock, patch

import pytest

from link_checker import (
    LinkResult,
    check_url,
    crawl,
    extract_links,
    get_base_domain,
    is_same_domain,
    normalize_url,
    build_session,
)


# ── LinkResult ────────────────────────────────────────────────────────────────

class TestLinkResult:
    def test_is_broken_on_error(self):
        r = LinkResult(url="http://x.com", status_code=None, error="Timeout")
        assert r.is_broken is True

    def test_is_broken_on_404(self):
        r = LinkResult(url="http://x.com", status_code=404, error=None)
        assert r.is_broken is True

    def test_is_broken_on_500(self):
        r = LinkResult(url="http://x.com", status_code=500, error=None)
        assert r.is_broken is True

    def test_not_broken_on_200(self):
        r = LinkResult(url="http://x.com", status_code=200, error=None)
        assert r.is_broken is False

    def test_not_broken_on_301(self):
        r = LinkResult(url="http://x.com", status_code=301, error=None)
        assert r.is_broken is False

    def test_status_label_with_error(self):
        r = LinkResult(url="http://x.com", status_code=None, error="Connection error")
        assert "Connection error" in r.status_label

    def test_status_label_with_code(self):
        r = LinkResult(url="http://x.com", status_code=404, error=None)
        assert r.status_label == "404"


# ── URL helpers ────────────────────────────────────────────────────────────────

class TestUrlHelpers:
    def test_get_base_domain(self):
        assert get_base_domain("https://example.com/path?q=1") == "https://example.com"

    def test_is_same_domain_true(self):
        assert is_same_domain("https://example.com/page", "https://example.com") is True

    def test_is_same_domain_false(self):
        assert is_same_domain("https://other.com/page", "https://example.com") is False

    def test_normalize_url_strips_fragment(self):
        assert normalize_url("https://example.com/page#section") == "https://example.com/page"

    def test_normalize_url_keeps_query(self):
        url = "https://example.com/page?q=1"
        assert normalize_url(url) == url


# ── extract_links ──────────────────────────────────────────────────────────────

class TestExtractLinks:
    def test_extracts_absolute_links(self):
        html = '<a href="https://example.com/about">About</a>'
        links = extract_links(html, "https://example.com/")
        assert "https://example.com/about" in links

    def test_resolves_relative_links(self):
        html = '<a href="/contact">Contact</a>'
        links = extract_links(html, "https://example.com/")
        assert "https://example.com/contact" in links

    def test_skips_mailto(self):
        html = '<a href="mailto:test@example.com">Email</a>'
        links = extract_links(html, "https://example.com/")
        assert not any("mailto" in l for l in links)

    def test_skips_javascript(self):
        html = '<a href="javascript:void(0)">Click</a>'
        links = extract_links(html, "https://example.com/")
        assert not any("javascript" in l for l in links)

    def test_skips_fragment_only(self):
        html = '<a href="#top">Top</a>'
        links = extract_links(html, "https://example.com/")
        assert not links

    def test_strips_fragment_from_link(self):
        html = '<a href="https://example.com/page#anchor">Page</a>'
        links = extract_links(html, "https://example.com/")
        assert "https://example.com/page" in links
        assert not any("#" in l for l in links)


# ── check_url ──────────────────────────────────────────────────────────────────

class TestCheckUrl:
    def _mock_session(self, status_code=200):
        session = MagicMock()
        resp = MagicMock()
        resp.status_code = status_code
        session.head.return_value = resp
        return session

    def test_returns_status_code(self):
        session = self._mock_session(200)
        code, err = check_url(session, "https://example.com", timeout=10)
        assert code == 200
        assert err is None

    def test_returns_404(self):
        session = self._mock_session(404)
        code, err = check_url(session, "https://example.com", timeout=10)
        assert code == 404
        assert err is None

    def test_falls_back_to_get_on_405(self):
        session = MagicMock()
        head_resp = MagicMock(status_code=405)
        get_resp = MagicMock(status_code=200)
        session.head.return_value = head_resp
        session.get.return_value = get_resp
        code, err = check_url(session, "https://example.com", timeout=10)
        assert code == 200
        session.get.assert_called_once()

    def test_connection_error(self):
        import requests
        session = MagicMock()
        session.head.side_effect = requests.exceptions.ConnectionError()
        code, err = check_url(session, "https://example.com", timeout=10)
        assert code is None
        assert err is not None

    def test_timeout_error(self):
        import requests
        session = MagicMock()
        session.head.side_effect = requests.exceptions.Timeout()
        code, err = check_url(session, "https://example.com", timeout=10)
        assert code is None
        assert "Timeout" in err


# ── crawl ──────────────────────────────────────────────────────────────────────

class TestCrawl:
    def _make_response(self, status=200, content_type="text/html", body=""):
        resp = MagicMock()
        resp.status_code = status
        resp.headers = {"Content-Type": content_type}
        resp.text = body
        return resp

    def test_crawl_single_page_no_links(self):
        session = MagicMock()
        session.get.return_value = self._make_response(body="<html><body>Hello</body></html>")
        results = crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=0,
            verbose=False,
        )
        assert "https://example.com" in results
        assert results["https://example.com"].status_code == 200

    def test_crawl_stops_on_stop_event(self):
        session = MagicMock()
        session.get.return_value = self._make_response(body="<html><body>Hello</body></html>")
        stop = threading.Event()
        stop.set()
        results = crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=0,
            verbose=False,
            stop_event=stop,
        )
        # With stop already set, should still return start URL result or empty
        assert isinstance(results, dict)

    def test_crawl_calls_on_result(self):
        session = MagicMock()
        session.get.return_value = self._make_response(body="<html></html>")
        collected = []
        crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=0,
            verbose=False,
            on_result=lambda r: collected.append(r),
        )
        assert len(collected) >= 1

    def test_crawl_calls_on_status(self):
        session = MagicMock()
        session.get.return_value = self._make_response(body="<html></html>")
        messages = []
        crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=0,
            verbose=False,
            on_status=lambda m: messages.append(m),
        )
        assert len(messages) >= 1

    def test_crawl_respects_max_pages(self):
        html_with_links = """
        <html><body>
          <a href="https://example.com/p1">P1</a>
          <a href="https://example.com/p2">P2</a>
          <a href="https://example.com/p3">P3</a>
        </body></html>
        """
        session = MagicMock()
        session.get.return_value = self._make_response(body=html_with_links)
        results = crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=1,
            verbose=False,
        )
        # Only 1 page should be GET-crawled (start URL)
        assert session.get.call_count == 1

    def test_crawl_marks_broken_link(self):
        # External link → checked via HEAD (not crawled with GET)
        html_with_broken = '<html><body><a href="https://external.com/dead">dead</a></body></html>'
        session = MagicMock()
        page_resp = self._make_response(body=html_with_broken)
        broken_resp = MagicMock(status_code=404)
        session.get.return_value = page_resp
        session.head.return_value = broken_resp
        results = crawl(
            start_url="https://example.com",
            session=session,
            timeout=10,
            delay=0,
            max_pages=0,
            verbose=False,
        )
        dead = results.get("https://external.com/dead")
        assert dead is not None
        assert dead.is_broken is True


# ── build_session ──────────────────────────────────────────────────────────────

class TestBuildSession:
    def test_returns_session_with_user_agent(self):
        session = build_session(15, "TestAgent/1.0")
        assert session.headers["User-Agent"] == "TestAgent/1.0"

    def test_max_redirects(self):
        session = build_session(15, "TestAgent/1.0")
        assert session.max_redirects == 10
