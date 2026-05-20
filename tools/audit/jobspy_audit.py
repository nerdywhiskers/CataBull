"""
jobspy_audit.py — Python wrapper around JobSpy for the one-shot portals audit.

Reads a JSON plan from stdin, runs each query through jobspy.scrape_jobs,
writes a JSON result to stdout. Designed to be called by
tools/audit/run-audit.mjs; never imported by the dashboard. The full set
of fields, dedup logic, and report writing live on the Node side — this
file just handles the JobSpy boundary.

Plan shape (stdin):
  {
    "queries": [
      { "search_term": "platform engineer",
        "site": "indeed",
        "results_wanted": 25,
        "hours_old": 720,
        "country_indeed": "USA",
        "location": "" }
      ...
    ],
    "delay_between_queries_sec": 2
  }

Result shape (stdout):
  {
    "jobspy_version": "1.1.82",
    "queries": [
      { "request": <the original query>,
        "ok": true,
        "duration_ms": 4321,
        "hit_count": 25,
        "hits": [ {site, title, company, location, date_posted, job_url, job_url_direct, salary?} ... ],
        "error": null }
      ...
    ]
  }

Why a separate Python process: JobSpy is the only Python dep in the
project and isn't shipped with the npm install. Keeping it isolated
means the rest of the audit (deduplication, classification, report
writing) is plain Node and can be re-run without touching the venv.
"""

import sys
import json
import math
import time
import logging
from importlib import metadata

# Silence JobSpy's own logger to stderr so a successful run doesn't look
# like an error in CI / PowerShell. We still print real exceptions.
logging.basicConfig(level=logging.WARNING, format="[jobspy] %(message)s")
for name in ("JobSpy", "JobSpy:Linkedin", "JobSpy:Indeed", "JobSpy:Glassdoor"):
    logging.getLogger(name).setLevel(logging.ERROR)

try:
    from jobspy import scrape_jobs
except ImportError as e:
    json.dump({"jobspy_version": None, "queries": [], "fatal": f"jobspy not installed: {e}"}, sys.stdout)
    sys.exit(1)

try:
    jobspy_version = metadata.version("python-jobspy")
except Exception:
    jobspy_version = "unknown"

KEEP_FIELDS = [
    "site", "title", "company", "company_industry", "location",
    "date_posted", "job_url", "job_url_direct",
    "min_amount", "max_amount", "currency", "interval",
    "is_remote", "description",
]


def normalize_hit(row):
    """Coerce a JobSpy row (pandas Series → dict) to plain JSON-safe types,
    keeping only the fields the audit needs. Drops the rest to keep the
    JSON small and the post-processing in Node cheap. Pandas leaks NaN
    for missing numeric fields like min_amount/max_amount — those are
    coerced to None so json.dumps doesn't emit invalid `NaN` literals."""
    out = {}
    for k in KEEP_FIELDS:
        v = row.get(k) if hasattr(row, "get") else None
        if v is None:
            out[k] = None
            continue
        # NaN sneaks past `is None` (it's a float). isnan only works on
        # floats, so guard the call.
        if isinstance(v, float) and math.isnan(v):
            out[k] = None
            continue
        if isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            try:
                out[k] = str(v)
            except Exception:
                out[k] = None
    # description is huge — truncate so the JSON blob doesn't balloon
    if isinstance(out.get("description"), str) and len(out["description"]) > 500:
        out["description"] = out["description"][:500] + "…"
    return out


def run_query(q):
    """Run one JobSpy query. Returns a result dict whether it succeeded or
    failed — the Node side decides how to react to errors per source."""
    started = time.monotonic()
    try:
        df = scrape_jobs(
            site_name=[q["site"]],
            search_term=q["search_term"],
            location=q.get("location") or "",
            results_wanted=int(q.get("results_wanted", 25)),
            hours_old=int(q.get("hours_old", 720)),
            country_indeed=q.get("country_indeed", "USA"),
            linkedin_fetch_description=False,
        )
    except Exception as e:
        return {
            "request": q,
            "ok": False,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "hit_count": 0,
            "hits": [],
            "error": f"{type(e).__name__}: {e}",
        }

    if df is None or df.empty:
        return {
            "request": q,
            "ok": True,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "hit_count": 0,
            "hits": [],
            "error": None,
        }

    hits = [normalize_hit(row) for _, row in df.iterrows()]
    return {
        "request": q,
        "ok": True,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "hit_count": len(hits),
        "hits": hits,
        "error": None,
    }


def main():
    plan = json.load(sys.stdin)
    queries = plan.get("queries", [])
    # Per-site delay map: LinkedIn's bot detection is more aggressive
    # than Indeed's, so we wait longer between LinkedIn calls. Fall
    # back to a legacy single delay for older callers.
    per_site = plan.get("per_site_delay_sec", {})
    legacy_delay = float(plan.get("delay_between_queries_sec", 2))

    out = {"jobspy_version": jobspy_version, "queries": []}
    prev_site = None
    for i, q in enumerate(queries):
        site = q.get("site", "")
        if i > 0:
            # The delay applies BEFORE the next query of the same site
            # (i.e. the gap between two Indeed calls or two LinkedIn
            # calls). Site transitions wait the longer of the two.
            wait = max(
                float(per_site.get(site, legacy_delay)),
                float(per_site.get(prev_site, legacy_delay)) if prev_site != site else 0,
            )
            if wait > 0:
                time.sleep(wait)
        # Progress on stderr so the Node side can stream it without
        # polluting the JSON contract on stdout.
        sys.stderr.write(f"[{i+1}/{len(queries)}] {site:9s} term={q['search_term']!r}\n")
        sys.stderr.flush()
        result = run_query(q)
        out["queries"].append(result)
        sys.stderr.write(f"          {chr(0x21B3)} {result['hit_count']} hits in {result['duration_ms']}ms"
                         + (f" ERROR: {result['error']}" if result.get("error") else "")
                         + "\n")
        sys.stderr.flush()
        prev_site = site

    # allow_nan=False would now raise rather than silently emit `NaN` —
    # belt + suspenders given the pre-normalize NaN coercion above.
    json.dump(out, sys.stdout, default=str, allow_nan=False)


if __name__ == "__main__":
    main()
