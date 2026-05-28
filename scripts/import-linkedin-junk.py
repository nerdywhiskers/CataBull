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


class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self._active_href = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a":
            return
        href = None
        for key, value in attrs:
            if key and key.lower() == "href" and value:
                href = value
                break
        if href:
            self._active_href = href
            self._text = []

    def handle_data(self, data):
        if self._active_href:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() != "a" or not self._active_href:
            return
        text = clean_cell(" ".join(self._text))
        self.links.append({"url": self._active_href, "text": text})
        self._active_href = None
        self._text = []


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
        links.extend(parser.links)
        text = html.unescape(re.sub(r"<[^>]+>", " ", content))
        links.extend({"url": u, "text": ""} for u in URL_RE.findall(text))
    else:
        links.extend({"url": u, "text": ""} for u in URL_RE.findall(content))
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


def is_linkedin_job_url(url):
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    query = parsed.query.lower()
    if "linkedin.com" not in host and "lnkd.in" not in host:
        return False
    if "linkedin.com" in host:
        return "/jobs/" in path or "/comm/jobs/" in path or "currentjobid=" in query
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


def infer_company_role(link_text, subject):
    text = clean_cell(link_text)
    subject = clean_cell(subject)

    if text and len(text) <= 120 and not re.fullmatch(r"view job|apply|view|jobs?|see more", text, re.I):
        role = text
    else:
        role = ""

    company = ""
    for source in (text, subject):
        m = re.search(r"\bat\s+([^,|·–—-]{2,60})", source, re.I)
        if m:
            company = clean_cell(m.group(1))
            break

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
            if not is_linkedin_job_url(url) or url in seen:
                continue
            seen.add(url)
            company, role = infer_company_role(link.get("text"), message.get("subject"))
            rows.append(
                {
                    "url": url,
                    "company": company,
                    "role": role,
                    "received": (message.get("receivedDateTime") or "")[:10] or None,
                    "location": None,
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
