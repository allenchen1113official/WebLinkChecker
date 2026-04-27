# WebLinkChecker

A Python command-line tool that crawls all pages under a given website and reports broken links, along with the source page where each broken link was found.

## Features

- Crawls all internal pages within the same domain
- Checks every discovered link (internal and external)
- Reports broken links (HTTP 4xx / 5xx) and connection errors
- Shows which page each broken link was found on
- Exports results to **CSV** or **JSON**
- Configurable timeout, request delay, max pages, and User-Agent
- Colored terminal output

## Requirements

- Python 3.10+
- pip

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```
python link_checker.py <URL> [OPTIONS]
```

### Arguments

| Argument | Description |
|---|---|
| `url` | Starting URL to crawl (required), e.g. `https://example.com` |
| `--timeout SEC` | Request timeout in seconds (default: 15) |
| `--delay SEC` | Delay between requests in seconds (default: 0) |
| `--max-pages N` | Max pages to crawl, 0 = unlimited (default: 0) |
| `--user-agent UA` | Custom User-Agent string |
| `--output FILE` | Save report to file (e.g. `report.csv` or `report.json`) |
| `--format csv\|json` | Output format for `--output` (default: csv) |
| `--show-ok` | Also print OK links in console output |
| `--broken-only` | Include only broken links when exporting |
| `--verbose / -v` | Print each URL as it is crawled/checked |

### Examples

```bash
# Basic check
python link_checker.py https://example.com

# With polite crawl delay and verbose output
python link_checker.py https://example.com --delay 0.5 --verbose

# Limit crawl to 50 pages and save CSV report
python link_checker.py https://example.com --max-pages 50 --output report.csv

# Export broken links only as JSON
python link_checker.py https://example.com --output broken.json --format json --broken-only
```

## Output

### Console

```
======================================================================
                          LINK CHECK REPORT
======================================================================
  Total links checked : 142
  OK                  : 138
  Broken              : 4
  Scan time           : 2026-04-27 10:30:00
======================================================================

                             BROKEN LINKS
----------------------------------------------------------------------

[1] https://example.com/old-page
     Status  : 404
     Found on:
       - https://example.com/
       - https://example.com/about

[2] https://external-site.com/missing
     Status  : ERROR: Connection error
     Found on:
       - https://example.com/contact
```

### CSV columns

`URL`, `Status`, `Error`, `Broken`, `Found On`

### JSON structure

```json
{
  "generated_at": "2026-04-27T10:30:00",
  "total": 142,
  "broken_count": 4,
  "links": [
    {
      "url": "https://example.com/old-page",
      "status_code": 404,
      "error": null,
      "is_broken": true,
      "found_on": ["https://example.com/", "https://example.com/about"]
    }
  ]
}
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No broken links found |
| `1` | One or more broken links detected |
