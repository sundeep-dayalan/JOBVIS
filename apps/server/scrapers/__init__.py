"""
JOBVIS Server-Side Scrapers Package

Each module in this package is a self-contained scraper for a specific
job board source. Each scraper:
  - Is source-specific and lives in its own file
  - Returns a list of job dicts conforming to the standard JOBVIS schema
  - Has no dependency on the Chrome extension

Supported scrapers:
  - ashby.py   → jobs.ashbyhq.com  (public GraphQL API, no auth)
  - greenhouse.py → (future)
  - lever.py      → (future)
"""
