#!/usr/bin/env python3
"""Import LinkedIn job links from Outlook Junk Email into CataBull.

Read-only against Outlook. Writes to data/pipeline.md only when --apply is set.
Uses the Microsoft Graph token created by:
  /home/jonathan/.openclaw/workspace/scripts/msgraph-auth-device.py
"""

import argparse
import csv
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

TENANT = os.environ.get("MSGRAPH_TENANT", "common")
CLIENT_ID = os.environ.get("MSGRAPH_CLIENT_ID", "14d82eec-204b-4c2f-b7e8-296a70dab67e")
TOKEN_PATH = Path(os.path.expanduser(os.environ.get("MSGRAPH_TOKEN_PATH", "~/.openclaw/secrets/msgraph-token.json")))
GRAPH = os.environ.get("MSGRAPH_BASE_URL", "https://graph.microsoft.com/v1.0")

LINKEDIN_SENDER_RE = re.compile(r"(^|[.@-])linkedin\.com$", re.I)
LINKEDIN_TEXT_RE = re.compile(r"\blinkedin\b|job alert|recommended jobs|new jobs|hiring|recruiter", re.I)
URL_RE = re.compile(r"https?://[^\s<>'\")]+", re.I)
WS_RE = re.compile(r"\s+")
MARKER_RE = re.compile(r"\[\[LINK_(\d+)\]\]")
GENERIC_LINK_TEXT_RE = re.compile(r"^(?:view job|apply|view|jobs?|see more|learn more|open role|read more)$", re.I)
JSON_LD_RE = re.compile(r"<script[^>]*type=([\"'])application/ld\+json\1[^>]*>(.*?)</script>", re.I | re.S)
META_RE = re.compile(r"<meta\s+[^>]*(?:property|name)=([\"'])([^\"']+)\1[^>]*content=([\"'])([^\"']*)\3[^>]*>", re.I)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)
LINKEDIN_SEARCH_TITLE_RE = re.compile(r"(?:more than|mehr als|más de|plus de|meer dan)\s+\d+[\d,.]*\s+jobs?\s+for\b|vacatures\s+voor\b|empleos\s+de\b", re.I)
FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
ROOT = Path(__file__).resolve().parents[1]
LIVE_SCRAPE_SCRIPT = ROOT / "scripts" / "extract-job-url-metadata.mjs"
BLOCK_TAGS = {
    "div",
    "p",
    "section",
    "article",
    "header",
    "footer",
    "table",
    "tr",
    "td",
    "th",
    "ul",
    "ol",
    "li",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
}


class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self._active_href = None
        self._text = []
        self._attrs = {}
        self._stream = []

    def _append(self, text):
        if text:
            self._stream.append(text)

    def _newline(self):
        if not self._stream or self._stream[-1].endswith("\n"):
            return
        self._stream.append("\n")

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in BLOCK_TAGS:
            self._newline()
        if tag != "a":
            return
        attrs_dict = {}
        for key, value in attrs:
            if key:
                attrs_dict[key.lower()] = html.unescape(value or "")
        href = attrs_dict.get("href")
        if href:
            self._active_href = href
            self._text = []
            self._attrs = attrs_dict

    def handle_data(self, data):
        self._append(data)
        if self._active_href:
            self._text.append(data)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "a" and self._active_href:
            text = clean_cell(" ".join(self._text))
            marker = f"[[LINK_{len(self.links)}]]"
            self._append(f" {marker} ")
            self.links.append(
                {
                    "url": self._active_href,
                    "text": text,
                    "title": clean_cell(self._attrs.get("title")),
                    "aria_label": clean_cell(self._attrs.get("aria-label")),
                    "context_before": [],
                    "context_after": [],
                    "_marker": marker,
                }
            )
            self._active_href = None
            self._text = []
            self._attrs = {}
        if tag in BLOCK_TAGS:
            self._newline()

    def finalize(self):
        cleaned_lines = [clean_cell(line) for line in "".join(self._stream).splitlines()]
        for link in self.links:
            marker = link.pop("_marker", "")
            marker_line_idx = None
            for idx, line in enumerate(cleaned_lines):
                if marker and marker in line:
                    marker_line_idx = idx
                    break
            if marker_line_idx is None:
                continue
            before = []
            for line in cleaned_lines[:marker_line_idx]:
                candidate = clean_cell(MARKER_RE.sub("", line))
                if candidate:
                    before.append(candidate)
            after = []
            for line in cleaned_lines[marker_line_idx + 1 :]:
                candidate = clean_cell(MARKER_RE.sub("", line))
                if candidate:
                    after.append(candidate)
            link["context_before"] = before[-3:]
            link["context_after"] = after[:2]


def clean_cell(value):
    return WS_RE.sub(" ", str(value or "").replace("|", " ").replace("\n", " ")).strip()


def load_token():
    if not TOKEN_PATH.exists():
        raise SystemExit(f"No token found at {TOKEN_PATH}. Run: /home/jonathan/.openclaw/workspace/scripts/msgraph-auth-device.py")
    return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))


def save_token(tok):
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(tok), encoding="utf-8")
    TOKEN_PATH.chmod(0o600)


def post_form(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def access_token():
    tok = load_token()
    if tok.get("refresh_token"):
        try:
            refreshed = post_form(
                f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token",
                {
                    "client_id": CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": tok["refresh_token"],
                    "scope": os.environ.get("MSGRAPH_SCOPES", "offline_access User.Read Mail.Read Files.Read Calendars.Read"),
                },
            )
            if "access_token" in refreshed:
                save_token(refreshed)
                tok = refreshed
        except Exception:
            pass
    if not tok.get("access_token"):
        raise SystemExit("Token file missing access_token. Re-run msgraph-auth-device.py")
    return tok["access_token"]


def graph_get(path_or_url, params=None):
    url = path_or_url if path_or_url.startswith("https://") else GRAPH + path_or_url
    if params:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token()}"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            err = json.loads(text)
        except Exception:
            err = {"error": text}
        raise SystemExit(json.dumps(err, indent=2))


def iso_days_ago(days):
    start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    return start.isoformat(timespec="seconds").replace("+00:00", "Z")


def sender_address(message):
    return (((message.get("from") or {}).get("emailAddress") or {}).get("address") or "").lower()


def linkedinish_message(message):
    sender = sender_address(message)
    subject = message.get("subject") or ""
    return bool(LINKEDIN_SENDER_RE.search(sender) or LINKEDIN_TEXT_RE.search(subject))


def extract_links(body):
    content = (body or {}).get("content") or ""
    content_type = ((body or {}).get("contentType") or "").lower()
    links = []
    if content_type == "html" or "<a " in content.lower():
        parser = LinkExtractor()
        parser.feed(content)
        parser.finalize()
        links.extend(parser.links)
        text = html.unescape(re.sub(r"<[^>]+>", " ", content))
        links.extend(
            {
                "url": u,
                "text": "",
                "title": "",
                "aria_label": "",
                "context_before": [],
                "context_after": [],
            }
            for u in URL_RE.findall(text)
        )
    else:
        links.extend(
            {
                "url": u,
                "text": "",
                "title": "",
                "aria_label": "",
                "context_before": [],
                "context_after": [],
            }
            for u in URL_RE.findall(content)
        )
    return links


def unwrap_url(url):
    current = html.unescape(url.strip())
    seen = set()
    for _ in range(4):
        if current in seen:
            break
        seen.add(current)
        parsed = urllib.parse.urlparse(current)
        query = urllib.parse.parse_qs(parsed.query)
        wrapped = query.get("url") or query.get("u")
        if wrapped:
            current = wrapped[0]
            continue
        return current
    return current


def is_linkedin_job_url(url, include_search=False):
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    query = parsed.query.lower()
    if "linkedin.com" not in host and "lnkd.in" not in host:
        return False
    if "linkedin.com" in host:
        is_detail = "/jobs/view/" in path or "/comm/jobs/view/" in path or "currentjobid=" in query
        if is_detail:
            return True
        if include_search:
            return "/jobs/search" in path or "/comm/jobs/search" in path
        return False
    return True


def canonical_url(url):
    unwrapped = unwrap_url(url)
    parsed = urllib.parse.urlparse(unwrapped)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    keep = {}
    for key in ("currentJobId", "currentjobid", "keywords", "location"):
        if key in query:
            keep[key] = query[key]
    normalized_query = urllib.parse.urlencode(keep, doseq=True)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc.lower(), parsed.path, "", normalized_query, ""))


def parse_role_company_phrase(text):
    text = clean_cell(text)
    if not text:
        return "", ""
    m = re.match(r"(.{2,120}?)\s+at\s+([^,|·•–—-]{2,80})$", text, re.I)
    if not m:
        return "", ""
    return clean_cell(m.group(1)), clean_cell(m.group(2))


def split_context_parts(text):
    return [clean_cell(part) for part in re.split(r"\s*[|·•]\s*|\s+[–—]\s+", clean_cell(text)) if clean_cell(part)]


def generic_link_text(text):
    text = clean_cell(text)
    return not text or len(text) > 120 or bool(GENERIC_LINK_TEXT_RE.fullmatch(text))


def strip_tags(html_text):
    text = re.sub(r"<[^>]+>", " ", html_text or "")
    return WS_RE.sub(" ", html.unescape(text)).strip()


def extract_meta_map(html_text):
    meta = {}
    for _, key, _, value in META_RE.findall(html_text or ""):
        meta[key.lower()] = WS_RE.sub(" ", html.unescape(str(value or ""))).strip()
    return meta


def split_company_location(text):
    parts = [clean_cell(part) for part in re.split(r"\s*[·|]\s*", clean_cell(text)) if clean_cell(part)]
    if len(parts) >= 2:
        return parts[0], " · ".join(parts[1:])
    return "", clean_cell(text)


def location_from_job_posting(job):
    location = ""
    job_location = job.get("jobLocation")
    if isinstance(job_location, list):
        job_location = job_location[0] if job_location else {}
    if isinstance(job_location, dict):
        address = job_location.get("address") or {}
        locality = clean_cell(address.get("addressLocality") or job_location.get("name") or "")
        region = clean_cell(address.get("addressRegion") or "")
        country = clean_cell(address.get("addressCountry") or "")
        parts = []
        if locality:
            parts.append(locality)
        if region and region.lower() != locality.lower():
            parts.append(region)
        if not parts and country:
            parts.append(country)
        location = ", ".join(parts)
    applicant_req = clean_cell(((job.get("applicantLocationRequirements") or {}).get("name") if isinstance(job.get("applicantLocationRequirements"), dict) else "") or "")
    if location and applicant_req and applicant_req.lower() != location.lower():
        return f"{location} ({applicant_req})"
    return location or applicant_req


def collect_job_postings(node, out):
    if isinstance(node, list):
        for item in node:
            collect_job_postings(item, out)
        return
    if not isinstance(node, dict):
        return
    node_type = node.get("@type")
    if isinstance(node_type, list):
        node_type = ",".join(str(part) for part in node_type)
    if isinstance(node_type, str) and "jobposting" in node_type.lower():
        out.append(node)
    for value in node.values():
        collect_job_postings(value, out)


def parse_linkedin_title(text):
    raw = html.unescape(str(text or "")).strip()
    if not raw or LINKEDIN_SEARCH_TITLE_RE.search(raw):
        return "", ""
    candidate = re.sub(r"\s*\|\s*LinkedIn.*$", "", raw, flags=re.I).strip()
    candidate = clean_cell(candidate)
    if not candidate or LINKEDIN_SEARCH_TITLE_RE.search(candidate):
        return "", ""
    m = re.match(r"(.+?)\s+-\s+(.+)$", candidate)
    if m:
        return clean_cell(m.group(1)), clean_cell(m.group(2))
    m = re.match(r"(.+?),\s+(.+)$", candidate)
    if m:
        return clean_cell(m.group(1)), clean_cell(m.group(2))
    return "", ""


def parse_job_page_metadata(html_text, url):
    html_text = html_text or ""
    postings = []
    for _, raw in JSON_LD_RE.findall(html_text):
        try:
            parsed = json.loads(raw.strip())
        except Exception:
            continue
        collect_job_postings(parsed, postings)
    for job in postings:
        role = clean_cell(job.get("title") or "")
        company = clean_cell(((job.get("hiringOrganization") or {}).get("name") if isinstance(job.get("hiringOrganization"), dict) else "") or "")
        location = clean_cell(location_from_job_posting(job))
        if role or company or location:
            return {"role": role, "company": company, "location": location, "source": "json-ld"}

    meta = extract_meta_map(html_text)
    title_match = TITLE_RE.search(html_text)
    h1_match = H1_RE.search(html_text)
    title = strip_tags(title_match.group(1)) if title_match else ""
    h1 = strip_tags(h1_match.group(1)) if h1_match else ""
    host = urllib.parse.urlparse(url).netloc.lower()
    if "linkedin.com" in host:
        role, company = parse_linkedin_title(meta.get("og:title") or title or h1)
        if not role:
            role = h1
        desc_company, desc_location = split_company_location(meta.get("og:description"))
        if not company:
            company = desc_company
        return {"role": role, "company": company, "location": desc_location, "source": "linkedin-meta"}

    role = h1 or meta.get("og:title") or title
    company = meta.get("og:site_name") or meta.get("twitter:site") or ""
    location = meta.get("og:description") or meta.get("description") or ""
    return {"role": clean_cell(role), "company": clean_cell(company), "location": clean_cell(location), "source": "html-meta"}


def metadata_sufficient(metadata):
    metadata = metadata or {}
    return bool(clean_cell(metadata.get("role")) and clean_cell(metadata.get("company")))


def fetch_live_job_page_metadata(url):
    if not LIVE_SCRAPE_SCRIPT.exists():
        return None
    result = subprocess.run(
        ["node", str(LIVE_SCRAPE_SCRIPT), url],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if result.returncode != 0:
        return None
    try:
        parsed = json.loads(result.stdout or "{}")
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def fetch_job_page_metadata(url):
    req = urllib.request.Request(url, headers=FETCH_HEADERS)
    with urllib.request.urlopen(req, timeout=20) as response:
        final_url = response.geturl()
        html_text = response.read().decode("utf-8", errors="replace")
    metadata = parse_job_page_metadata(html_text, final_url)
    if not metadata_sufficient(metadata):
        live_metadata = fetch_live_job_page_metadata(final_url)
        live = live_metadata if isinstance(live_metadata, dict) else {}
        if metadata_sufficient(live):
            metadata = {
                "role": clean_cell(live.get("role") or metadata.get("role") or ""),
                "company": clean_cell(live.get("company") or metadata.get("company") or ""),
                "location": clean_cell(live.get("location") or metadata.get("location") or ""),
                "source": clean_cell(live.get("source") or metadata.get("source") or "live-scrape"),
            }
    metadata["final_url"] = final_url
    return metadata


def should_fetch_metadata(company, role):
    return company == "LinkedIn" or role == "LinkedIn job lead"


def infer_company_role(link, subject):
    subject = clean_cell(subject)
    if isinstance(link, dict):
        text = clean_cell(link.get("text"))
        title = clean_cell(link.get("title"))
        aria_label = clean_cell(link.get("aria_label"))
        context_before = [clean_cell(item) for item in link.get("context_before", []) if clean_cell(item)]
        context_after = [clean_cell(item) for item in link.get("context_after", []) if clean_cell(item)]
    else:
        text = clean_cell(link)
        title = ""
        aria_label = ""
        context_before = []
        context_after = []

    role = ""
    company = ""

    for source in (title, aria_label, text):
        parsed_role, parsed_company = parse_role_company_phrase(source)
        if parsed_role and not role:
            role = parsed_role
        if parsed_company and not company:
            company = parsed_company
        if role and company:
            break

    if not role and not generic_link_text(text):
        role = text

    nearby_lines = context_before + context_after
    for line in reversed(nearby_lines):
        parsed_role, parsed_company = parse_role_company_phrase(line)
        if parsed_role and not role:
            role = parsed_role
        if parsed_company and not company:
            company = parsed_company
        if role and company:
            break

    if len(context_before) >= 2:
        nearest = context_before[-1]
        previous = context_before[-2]
        nearest_parts = split_context_parts(nearest)
        if len(nearest_parts) >= 2:
            if not company:
                company = nearest_parts[0]
            if not role and not generic_link_text(previous):
                role = previous
        elif not company and role and not generic_link_text(nearest):
            company = nearest

    for line in reversed(nearby_lines):
        if role and company:
            break
        parts = split_context_parts(line)
        if len(parts) >= 2 and not company:
            company = parts[0]
        if not role and not generic_link_text(line):
            role = line

    for source in (title, aria_label, text, subject):
        if company:
            break
        m = re.search(r"\bat\s+([^,|·•–—-]{2,80})", source, re.I)
        if m:
            company = clean_cell(m.group(1))

    if not role:
        m = re.search(r"(?:hiring|recommended|new):?\s+(.{5,90})", subject, re.I)
        role = clean_cell(m.group(1)) if m else "LinkedIn job lead"

    if not company:
        company = "LinkedIn"

    return company[:80], role[:120]


def fetch_messages(args):
    params = {
        "$top": str(min(args.page_size, 100)),
        "$select": "id,receivedDateTime,from,subject,body,webLink",
        "$orderby": "receivedDateTime desc",
    }
    if args.days:
        params["$filter"] = f"receivedDateTime ge {iso_days_ago(args.days)}"

    path = "/me/mailFolders/junkemail/messages"
    yielded = 0
    while path and yielded < args.limit:
        data = graph_get(path, params if path.startswith("/") else None)
        for message in data.get("value", []):
            yielded += 1
            yield message
            if yielded >= args.limit:
                break
        path = data.get("@odata.nextLink")
        params = None


def find_jobs(args):
    seen = set()
    rows = []
    for message in fetch_messages(args):
        if not args.include_non_linkedin_senders and not linkedinish_message(message):
            continue
        for link in extract_links(message.get("body")):
            url = canonical_url(link["url"])
            if not is_linkedin_job_url(url, include_search=args.include_search_pages) or url in seen:
                continue
            seen.add(url)
            company, role = infer_company_role(link, message.get("subject"))
            location = None
            if should_fetch_metadata(company, role):
                try:
                    metadata = fetch_job_page_metadata(url)
                except Exception:
                    metadata = None
                if metadata:
                    company = clean_cell(metadata.get("company") or company)
                    role = clean_cell(metadata.get("role") or role)
                    location = clean_cell(metadata.get("location") or "") or None
            rows.append(
                {
                    "url": url,
                    "company": company,
                    "role": role,
                    "received": (message.get("receivedDateTime") or "")[:10] or None,
                    "location": location,
                    "subject": message.get("subject") or "",
                    "messageUrl": message.get("webLink") or "",
                }
            )
    return rows


def pipeline_path(root):
    return Path(root).resolve() / "data" / "pipeline.md"


def read_pipeline(root):
    path = pipeline_path(root)
    if not path.exists():
        return "# Pipeline\n\n## Pendientes\n\n## Procesadas\n"
    return path.read_text(encoding="utf-8")


def pipeline_line(row):
    parts = [f"- [ ] {row['url']}", row["company"], row["role"]]
    if row.get("received"):
        parts.append(f"posted:{row['received']}")
    if row.get("location"):
        parts.append(f"loc:{clean_cell(row['location'])}")
    parts.append("source:linkedin-junk")
    return " | ".join(clean_cell(p) for p in parts)


def apply_to_pipeline(root, rows):
    path = pipeline_path(root)
    content = read_pipeline(root)
    existing = set(URL_RE.findall(content))
    added_rows = [row for row in rows if row["url"] not in existing]
    if not added_rows:
        return {"added": 0, "duplicates": len(rows)}

    lines = content.split("\n")
    insert_at = -1
    for i, line in enumerate(lines):
        if re.match(r"^##\s+Pendientes", line, re.I):
            insert_at = i + 1
            break
    if insert_at == -1:
        for i, line in enumerate(lines):
            if re.match(r"^##\s+Procesad", line, re.I):
                insert_at = i
                break
    if insert_at == -1:
        lines.extend(["", "## Pendientes"])
        insert_at = len(lines)

    while insert_at < len(lines) and not lines[insert_at].strip():
        insert_at += 1

    for row in reversed(added_rows):
        lines.insert(insert_at, pipeline_line(row))

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return {"added": len(added_rows), "duplicates": len(rows) - len(added_rows)}


def print_rows(rows, fmt):
    if fmt == "json":
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    elif fmt == "csv":
        writer = csv.DictWriter(sys.stdout, fieldnames=["url", "company", "role", "received", "subject", "messageUrl"])
        writer.writeheader()
        writer.writerows(rows)
    else:
        for row in rows:
            print(pipeline_line(row))


def main():
    parser = argparse.ArgumentParser(description="Import LinkedIn job links from Outlook Junk Email into CataBull")
    parser.add_argument("--workspace", default=os.environ.get("CATABULL_WORKSPACE_ROOT", os.getcwd()))
    parser.add_argument("--limit", type=int, default=200, help="Maximum junk messages to inspect")
    parser.add_argument("--days", type=int, default=30, help="Only scan messages received within this many days")
    parser.add_argument("--page-size", type=int, default=50, help="Graph page size, max 100")
    parser.add_argument("--include-non-linkedin-senders", action="store_true", help="Scan all junk messages")
    parser.add_argument("--include-search-pages", action="store_true", help="Include LinkedIn job search/result pages, not just job detail pages")
    parser.add_argument("--format", choices=["json", "csv", "pipeline"], default="pipeline")
    parser.add_argument("--apply", action="store_true", help="Append new links to data/pipeline.md")
    args = parser.parse_args()

    rows = find_jobs(args)
    if args.apply:
        result = apply_to_pipeline(args.workspace, rows)
        print(json.dumps({"scanned_links": len(rows), **result}, indent=2))
    else:
        print_rows(rows, args.format)


if __name__ == "__main__":
    main()
