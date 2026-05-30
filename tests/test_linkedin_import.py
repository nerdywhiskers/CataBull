#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "import-linkedin-junk.py"
SPEC = importlib.util.spec_from_file_location("linkedin_import", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load module spec for {MODULE_PATH}")
linkedin_import = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(linkedin_import)


class LinkedInImportTests(unittest.TestCase):
    def test_extract_links_keeps_nearby_role_company_context(self):
        body = {
            "contentType": "html",
            "content": """
                <html><body>
                  <div>Senior Product Designer</div>
                  <div>Figma · San Francisco, CA</div>
                  <a href=\"https://www.linkedin.com/jobs/view/12345/?trk=email\">View job</a>
                </body></html>
            """,
        }

        links = linkedin_import.extract_links(body)

        self.assertEqual(1, len(links))
        self.assertEqual("Senior Product Designer", links[0]["context_before"][0])
        self.assertEqual("Figma · San Francisco, CA", links[0]["context_before"][1])

    def test_infer_company_role_uses_html_context_when_anchor_text_generic(self):
        link = {
            "url": "https://www.linkedin.com/jobs/view/12345/",
            "text": "View job",
            "context_before": ["Senior Product Designer", "Figma · San Francisco, CA"],
            "context_after": [],
            "title": "",
            "aria_label": "",
        }

        company, role = linkedin_import.infer_company_role(link, "Recommended jobs for you")

        self.assertEqual("Figma", company)
        self.assertEqual("Senior Product Designer", role)

    def test_infer_company_role_uses_anchor_metadata_before_subject_fallback(self):
        link = {
            "url": "https://www.linkedin.com/jobs/view/67890/",
            "text": "View job",
            "context_before": [],
            "context_after": [],
            "title": "Applied AI Engineer at Anthropic",
            "aria_label": "",
        }

        company, role = linkedin_import.infer_company_role(link, "Jobs you may be interested in")

        self.assertEqual("Anthropic", company)
        self.assertEqual("Applied AI Engineer", role)

    def test_parse_job_page_metadata_prefers_json_ld(self):
        html = """
            <html><head>
              <script type="application/ld+json">
                {
                  "@context": "https://schema.org",
                  "@type": "JobPosting",
                  "title": "Senior Product Designer",
                  "hiringOrganization": {"name": "Figma"},
                  "jobLocation": {
                    "@type": "Place",
                    "address": {
                      "@type": "PostalAddress",
                      "addressLocality": "San Francisco",
                      "addressRegion": "CA"
                    }
                  }
                }
              </script>
            </head></html>
        """

        metadata = linkedin_import.parse_job_page_metadata(
            html,
            "https://boards.greenhouse.io/figma/jobs/123",
        )

        self.assertEqual("Senior Product Designer", metadata["role"])
        self.assertEqual("Figma", metadata["company"])
        self.assertEqual("San Francisco, CA", metadata["location"])

    def test_parse_job_page_metadata_understands_linkedin_titles(self):
        html = """
            <html><head>
              <title>Applied AI Engineer - Anthropic | LinkedIn</title>
              <meta property="og:title" content="Applied AI Engineer - Anthropic | LinkedIn">
              <meta property="og:description" content="Anthropic · San Francisco, CA (Hybrid)">
            </head><body><h1>Applied AI Engineer</h1></body></html>
        """

        metadata = linkedin_import.parse_job_page_metadata(
            html,
            "https://www.linkedin.com/jobs/view/987654321/",
        )

        self.assertEqual("Applied AI Engineer", metadata["role"])
        self.assertEqual("Anthropic", metadata["company"])
        self.assertEqual("San Francisco, CA (Hybrid)", metadata["location"])

    def test_fetch_job_page_metadata_uses_live_scrape_when_static_parse_weak(self):
        original_urlopen = linkedin_import.urllib.request.urlopen
        original_live = getattr(linkedin_import, "fetch_live_job_page_metadata")
        try:
            class FakeResponse:
                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    return False

                def geturl(self):
                    return "https://www.linkedin.com/jobs/view/123/"

                def read(self):
                    return b"<html><head><title>Jobs</title></head><body></body></html>"

            linkedin_import.urllib.request.urlopen = lambda req, timeout=20: FakeResponse()
            setattr(linkedin_import, "fetch_live_job_page_metadata", lambda url: {
                "role": "Founding Engineer",
                "company": "Acme",
                "location": "Remote",
                "source": "playwright-dom",
            })

            metadata = linkedin_import.fetch_job_page_metadata("https://www.linkedin.com/jobs/view/123/")

            self.assertEqual("Founding Engineer", metadata["role"])
            self.assertEqual("Acme", metadata["company"])
            self.assertEqual("Remote", metadata["location"])
            self.assertEqual("https://www.linkedin.com/jobs/view/123/", metadata["final_url"])
        finally:
            linkedin_import.urllib.request.urlopen = original_urlopen
            setattr(linkedin_import, "fetch_live_job_page_metadata", original_live)


if __name__ == "__main__":
    unittest.main()
