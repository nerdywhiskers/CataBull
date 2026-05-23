#!/usr/bin/env python3
"""
scan/market/jobspy_wrapper.py -- JobSpy sidecar for CataBull Deep Scan (Level 4).

Reads a JSON config from stdin and prints a JSON results envelope to stdout.
Stays intentionally tiny: jobspy does all the scraping, Node code in
scan/market/jobspy.mjs does all the filtering / dedup / writing.

Stdin shape:
  {
    "query": "art director",
    "location": "",
    "sites": ["indeed", "wellfound", "zip_recruiter", "google", "glassdoor"],
    "with_linkedin": false,
    "results_per_site": 20,
    "hours_old": 168,
    "country_indeed": "USA",
    "is_remote": true
  }

Stdout shape (success):
  {"ok": true, "jobs": [<jobspy records>], "count": N}

Stdout shape (failure):
  {"ok": false, "error": "<message>"}

Exit code is always 0 -- failures are conveyed via the JSON envelope so the
Node caller can render structured error messages instead of parsing stderr.
"""

import sys
import json


def main():
    try:
        cfg = json.load(sys.stdin)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {exc}"}))
        return

    try:
        from jobspy import scrape_jobs
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "error": f"python-jobspy not installed: {exc}. Install with: uv tool install python-jobspy",
        }))
        return

    sites = list(cfg.get("sites") or ["indeed", "wellfound", "zip_recruiter", "google", "glassdoor"])
    if cfg.get("with_linkedin"):
        if "linkedin" not in sites:
            sites.append("linkedin")
    else:
        sites = [s for s in sites if s != "linkedin"]

    try:
        df = scrape_jobs(
            site_name=sites,
            search_term=cfg["query"],
            location=cfg.get("location") or "",
            results_wanted=int(cfg.get("results_per_site") or 20),
            hours_old=int(cfg.get("hours_old") or 168),
            is_remote=bool(cfg.get("is_remote", False)),
            country_indeed=cfg.get("country_indeed") or "USA",
            description_format="markdown",
            verbose=0,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"jobspy.scrape_jobs failed: {exc}"}))
        return

    if df is None or df.empty:
        print(json.dumps({"ok": True, "jobs": [], "count": 0, "sites": sites}))
        return

    # jobspy returns a DataFrame whose schema varies slightly by site. We
    # normalize to a stable subset; everything else is dropped to keep the
    # JSON payload small (Deep Scan only needs URL, title, company, source).
    keep = ["title", "company", "job_url", "job_url_direct", "site",
            "location", "date_posted", "description", "is_remote"]
    cols = [c for c in keep if c in df.columns]
    records = df[cols].to_dict(orient="records") if cols else df.to_dict(orient="records")

    # Stringify pandas Timestamps + NaN -> None so json.dumps doesn't choke.
    def clean(v):
        try:
            import math
            if isinstance(v, float) and math.isnan(v):
                return None
        except Exception:
            pass
        if hasattr(v, "isoformat"):
            try:
                return v.isoformat()
            except Exception:
                return str(v)
        return v

    cleaned = [{k: clean(v) for k, v in row.items()} for row in records]
    print(json.dumps({"ok": True, "jobs": cleaned, "count": len(cleaned), "sites": sites}))


if __name__ == "__main__":
    main()
