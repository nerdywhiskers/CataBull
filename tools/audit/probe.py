"""Quick sanity probe — tiny JobSpy query against one site at a time.

Run via:
  .venv/Scripts/python.exe probe.py google
  .venv/Scripts/python.exe probe.py linkedin

Prints the number of hits and the first row's key fields so we can see
the shape of the data and confirm scraping isn't getting throttled.
"""

import sys
import json
from jobspy import scrape_jobs

site = sys.argv[1] if len(sys.argv) > 1 else "google"
search_term = sys.argv[2] if len(sys.argv) > 2 else "platform engineer"

print(f"jobspy probe: site={site} term={search_term!r} results_wanted=3", flush=True)

try:
    df = scrape_jobs(
        site_name=[site],
        search_term=search_term,
        results_wanted=3,
        hours_old=168,
        country_indeed="USA",
        linkedin_fetch_description=False,
    )
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}")
    sys.exit(1)

if df is None or df.empty:
    print("FAIL: zero hits returned")
    sys.exit(2)

print(f"OK: {len(df)} hits")
first = df.iloc[0].to_dict()
keep = {k: first.get(k) for k in ["site", "title", "company", "location", "date_posted", "job_url", "job_url_direct"]}
print(json.dumps(keep, default=str, indent=2))
