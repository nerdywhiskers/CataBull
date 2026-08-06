#!/usr/bin/env python3
import importlib.util
import pathlib
import tempfile
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

    def test_fetch_job_page_metadata_ignores_linkedin_login_wall(self):
        original_urlopen = linkedin_import.urllib.request.urlopen
        original_live = getattr(linkedin_import, "fetch_live_job_page_metadata")
        try:
            class FakeResponse:
                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    return False

                def geturl(self):
                    return "https://www.linkedin.com/uas/login?session_redirect=%2Fjobs%2Fview%2F123"

                def read(self):
                    return b"""
                        <html><head>
                          <title>LinkedIn Login</title>
                          <meta property='og:title' content='LinkedIn Login'>
                          <meta property='og:description' content='Sign in'>
                        </head></html>
                    """

            linkedin_import.urllib.request.urlopen = lambda req, timeout=20: FakeResponse()
            setattr(linkedin_import, "fetch_live_job_page_metadata", lambda url: {
                "role": "LinkedIn Login",
                "company": "Sign in",
                "location": "Login page",
                "source": "playwright-dom",
            })

            metadata = linkedin_import.fetch_job_page_metadata("https://www.linkedin.com/jobs/view/123/")

            self.assertEqual("", metadata["role"])
            self.assertEqual("", metadata["company"])
            self.assertEqual("", metadata["location"])
        finally:
            linkedin_import.urllib.request.urlopen = original_urlopen
            setattr(linkedin_import, "fetch_live_job_page_metadata", original_live)

    def test_infer_company_role_prefers_context_pair_for_jobs_similar_email(self):
        link = {
            "url": "https://www.linkedin.com/comm/jobs/view/4416492022",
            "text": "Jobs similar to Senior Art Director/Designer - Small Business at Autodesk",
            "context_before": [
                "-->",
                "Jobs similar to Senior Art Director/Designer - Small Business at Autodesk",
            ],
            "context_after": [
                "Senior Art Director",
                "Smalls · United States (Remote)",
            ],
            "title": "",
            "aria_label": "",
        }

        company, role = linkedin_import.infer_company_role(link, "New jobs similar to Senior Art Director/Designer - Small Business at Autodesk")

        self.assertEqual("Smalls", company)
        self.assertEqual("Senior Art Director", role)

    def test_infer_company_role_strips_company_location_from_role_text(self):
        link = {
            "url": "https://www.linkedin.com/comm/jobs/view/4405500413/",
            "text": "CG Artist, Experimental - INK Netflix · Los Angeles, CA (On-site)",
            "context_before": [
                "AR/VR jobs",
                "CG Artist, Experimental - INK",
                "Netflix · Los Angeles, CA (On-site)",
            ],
            "context_after": [],
            "title": "",
            "aria_label": "",
        }

        company, role = linkedin_import.infer_company_role(link, "Netflix is hiring for a AR/VR role")

        self.assertEqual("Netflix", company)
        self.assertEqual("CG Artist, Experimental - INK", role)

    def test_infer_company_role_uses_context_after_pair_for_job_alert(self):
        link = {
            "url": "https://www.linkedin.com/comm/jobs/view/4418821676/",
            "text": "",
            "context_before": [
                "Rocket Money Senior Art Director: ABOUT ROCKET MONEY 🔮Rocket Money’s mission is to…",
                "Your job alert for art director",
            ],
            "context_after": [
                "Senior Art Director",
                "Rocket Money · Los Angeles Metropolitan Area (Remote)",
            ],
            "title": "",
            "aria_label": "",
        }

        company, role = linkedin_import.infer_company_role(link, "Senior Art Director at Rocket Money")

        self.assertEqual("Rocket Money", company)
        self.assertEqual("Senior Art Director", role)

    def test_apply_to_pipeline_rejects_same_role_under_different_url(self):
        with tempfile.TemporaryDirectory(prefix="catabull-linkedin-import-") as root:
            data_dir = pathlib.Path(root) / "data"
            data_dir.mkdir(parents=True)
            (data_dir / "pipeline.md").write_text(
                "# Pipeline\n\n## Pendientes\n"
                "- [ ] https://linkedin.com/jobs/view/1 | BMW Group | Visualizer\n\n"
                "## Procesadas\n",
                encoding="utf-8",
            )

            result = linkedin_import.apply_to_pipeline(root, [{
                "url": "https://linkedin.com/jobs/view/2",
                "company": "BMW Group",
                "role": "Visualizer",
                "received": "2026-06-06",
                "location": None,
            }])

            self.assertEqual({"added": 0, "duplicates": 1}, result)
            content = (data_dir / "pipeline.md").read_text(encoding="utf-8")
            self.assertNotIn("jobs/view/2", content)

    def test_apply_to_pipeline_dedupes_within_incoming_batch(self):
        with tempfile.TemporaryDirectory() as root:
            rows = [
                {
                    "url": "https://www.linkedin.com/jobs/view/1/",
                    "company": "Acme",
                    "role": "Designer",
                    "received": None,
                    "location": None,
                },
                {
                    "url": "https://www.linkedin.com/jobs/view/2/",
                    "company": "Acme, Inc.",
                    "role": "Designer",
                    "received": None,
                    "location": None,
                },
            ]

            result = linkedin_import.apply_to_pipeline(root, rows)
            content = linkedin_import.read_pipeline(root)

            self.assertEqual({"added": 1, "duplicates": 1}, result)
            self.assertEqual(1, content.count("| Designer |"))

    def test_canonical_role_identity_avoids_false_company_and_language_collisions(self):
        self.assertNotEqual(
            linkedin_import.canonical_company_role_key("Group Nine Media", "Designer"),
            linkedin_import.canonical_company_role_key("Nine Media", "Designer"),
        )
        self.assertEqual(
            linkedin_import.canonical_company_role_key("Acme, Inc.", "Designer"),
            linkedin_import.canonical_company_role_key("Acme", "Designer"),
        )
        self.assertNotEqual(
            linkedin_import.canonical_company_role_key("Acme", "C++ Developer"),
            linkedin_import.canonical_company_role_key("Acme", "C# Developer"),
        )
        self.assertNotEqual(
            linkedin_import.canonical_company_role_key("C# Labs, Inc.", "Designer"),
            linkedin_import.canonical_company_role_key("C Labs", "Designer"),
        )


if __name__ == "__main__":
    unittest.main()
