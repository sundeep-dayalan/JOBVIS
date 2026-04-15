"""
JOBVIS Ashby Scraper — Server-Side
===================================
Scrapes job postings from any Ashby-powered job board using their
public GraphQL API. No auth, no browser extension required.

Public endpoint used:
  https://jobs.ashbyhq.com/api/non-user-graphql

Optimizations:
  1. Retry with exponential backoff  — recovers from transient 429 / 5xx
  2. Shared httpx.AsyncClient        — connection pooling across all org scrapes
  3. Parallel listing queries        — all org listing calls fire concurrently (semaphore-limited)
  4. Random jitter on delays         — avoids bot-looking clock patterns
  5. Adaptive batch size             — starts at 2, ramps up to 5 on success, drops on 429

Usage:
  from scrapers.ashby import run_ashby_scan
"""

import asyncio
import random
import re
from datetime import datetime, timezone
from typing import Callable, Optional

import httpx
from pipeline.pipeline import JobPipeline

# Shared pipeline instance for title pre-filtering (reads filter.yml once at startup)
_pipeline = JobPipeline()

# ─── Config ───────────────────────────────────────────────────────────────────

ASHBY_GRAPHQL_URL  = "https://jobs.ashbyhq.com/api/non-user-graphql"

# Retry settings
MAX_RETRIES        = 4       # max attempts per request
BACKOFF_BASE       = 2.0    # seconds — doubles each retry
BACKOFF_MAX        = 30.0   # cap

# Listing concurrency (parallel org listing queries)
LISTING_CONCURRENCY = 5     # how many org listing queries fire at once

# Description batch settings
DESC_BATCH_MIN     = 2      # starting batch size
DESC_BATCH_MAX     = 5      # max batch size after ramping
DESC_BATCH_DELAY   = 1.2    # base seconds between description batches

# Inter-org cooldown (applied between description-fetch sessions)
ORG_COOLDOWN       = 3.0    # base seconds between orgs

# Jitter range applied to every sleep (±%)
JITTER_PCT         = 0.25


# ─── GraphQL Queries ─────────────────────────────────────────────────────────

QUERY_ALL_POSTINGS = """
query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings {
      id
      title
      locationName
      workplaceType
      employmentType
      teamId
      compensationTierSummary
    }
  }
}
"""

QUERY_SINGLE_POSTING = """
query ApiJobBoardJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    descriptionHtml
  }
}
"""


# ─── Shared HTTP Client ───────────────────────────────────────────────────────

def _make_client(org_slug: str = "") -> httpx.AsyncClient:
    """
    Creates a shared httpx.AsyncClient with browser-like headers.
    Passing org_slug sets a realistic Referer.
    A single client is created per full scan and reused across all orgs.
    """
    return httpx.AsyncClient(
        headers={
            "Content-Type":   "application/json",
            "Origin":         "https://jobs.ashbyhq.com",
            "Referer":        f"https://jobs.ashbyhq.com/{org_slug}",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept":         "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=30.0,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _strip_html(html: str) -> str:
    """Strips HTML tags. Fast enough for job descriptions."""
    return re.sub(r'<[^>]+>', '', html).strip()


def _jitter(base: float) -> float:
    """Adds ±JITTER_PCT random jitter to a delay so we don't look like a cron job."""
    return base * (1 + random.uniform(-JITTER_PCT, JITTER_PCT))


def _map_posting(posting: dict, org_slug: str, org_name: str, description: Optional[str]) -> dict:
    """Maps a raw Ashby jobPosting to the JOBVIS standard schema."""
    posting_id = posting.get("id")
    source_url = f"https://jobs.ashbyhq.com/{org_slug}/{posting_id}"
    workplace_map = {"Remote": "Remote", "Hybrid": "Hybrid", "OnSite": "On-site"}

    return {
        "source":         "ashby",
        "source_id":      posting_id,
        "source_url":     source_url,
        "apply_url":      source_url,
        "title":          (posting.get("title") or "").strip() or None,
        "company_name":   org_name,
        "description":    description,
        "location":       posting.get("locationName"),
        "workType":       workplace_map.get(posting.get("workplaceType"), posting.get("workplaceType")),
        "employmentType": posting.get("employmentType"),
        "salary_info":    posting.get("compensationTierSummary") or None,
        "job_posted_at":  None,   # Not available from listing query
        "job_updated_at": None,   # Not available from listing query
        "scrapedAt":      datetime.now(timezone.utc).isoformat(),
    }


# ─── Retry Logic ─────────────────────────────────────────────────────────────

async def _post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    json: dict,
    label: str,
) -> httpx.Response:
    """
    POST with exponential backoff + jitter retry.
    Retries on 429 (rate limit) and 5xx (transient server errors).
    Raises on final failure or 4xx (except 429).
    """
    delay = BACKOFF_BASE
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = await client.post(url, params=params, json=json)

            if resp.status_code == 429:
                wait = min(_jitter(delay), BACKOFF_MAX)
                print(f"[Ashby] 429 on {label} — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                await asyncio.sleep(wait)
                delay *= 2
                continue

            if resp.status_code >= 500:
                wait = min(_jitter(delay), BACKOFF_MAX)
                print(f"[Ashby] {resp.status_code} on {label} — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                await asyncio.sleep(wait)
                delay *= 2
                continue

            resp.raise_for_status()
            return resp

        except httpx.TimeoutException:
            wait = min(_jitter(delay), BACKOFF_MAX)
            print(f"[Ashby] Timeout on {label} — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
            await asyncio.sleep(wait)
            delay *= 2

    raise RuntimeError(f"[Ashby] Gave up after {MAX_RETRIES} retries: {label}")


# ─── Core Fetchers ────────────────────────────────────────────────────────────

async def _fetch_all_postings(client: httpx.AsyncClient, org_slug: str) -> list[dict]:
    """Fetches the full listing of jobs for an org (IDs + brief metadata only)."""
    resp = await _post_with_retry(
        client,
        url=ASHBY_GRAPHQL_URL,
        params={"op": "ApiJobBoardWithTeams"},
        json={
            "operationName": "ApiJobBoardWithTeams",
            "variables": {"organizationHostedJobsPageName": org_slug},
            "query": QUERY_ALL_POSTINGS,
        },
        label=f"listing/{org_slug}",
    )
    data = resp.json()

    # Use `or {}` — Ashby sometimes returns {"data": null, "errors": [...]}
    board    = (data.get("data") or {}).get("jobBoardWithTeams") or {}
    postings = board.get("jobPostings") or []

    if not postings:
        errors = data.get("errors")
        if errors:
            raise ValueError(f"Ashby GraphQL error for '{org_slug}': {errors}")
    return postings


async def _fetch_description(
    client: httpx.AsyncClient,
    org_slug: str,
    posting_id: str,
) -> Optional[str]:
    """Fetches the full HTML description for a single posting and strips tags."""
    try:
        resp = await _post_with_retry(
            client,
            url=ASHBY_GRAPHQL_URL,
            params={"op": "ApiJobBoardJobPosting"},
            json={
                "operationName": "ApiJobBoardJobPosting",
                "variables": {
                    "organizationHostedJobsPageName": org_slug,
                    "jobPostingId": posting_id,
                },
                "query": QUERY_SINGLE_POSTING,
            },
            label=f"desc/{org_slug}/{posting_id}",
        )
        html = (resp.json().get("data") or {}).get("jobPosting", {}).get("descriptionHtml")
        return _strip_html(html) if html else None
    except Exception as e:
        print(f"[Ashby] Failed to fetch description for {posting_id}: {type(e).__name__}: {e}")
        return None


# ─── Single-Org Scraper ───────────────────────────────────────────────────────

async def scrape_ashby_org(
    org_slug: str,
    org_name: Optional[str] = None,
    skip_ids: Optional[set] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> list[dict]:
    """
    Scrapes all NEW job postings for a single Ashby org.

    Args:
        org_slug:  The slug in jobs.ashbyhq.com/<org_slug>
        org_name:  Display name (falls back to org_slug)
        skip_ids:  source_ids already in DB — skips description fetch + excludes from output
        client:    Shared httpx client (created internally if not provided)

    Returns:
        List of new job dicts in JOBVIS standard schema.
    """
    company = org_name or org_slug
    print(f"[Ashby] Scraping '{org_slug}' ({company})")

    _own_client = client is None
    if _own_client:
        client = _make_client(org_slug)

    try:
        postings = await _fetch_all_postings(client, org_slug)
        print(f"[Ashby] '{org_slug}' — found {len(postings)} total postings")

        if not postings:
            return []

        skip        = skip_ids or set()
        new_postings = [p for p in postings if p["id"] not in skip]
        skipped_cnt  = len(postings) - len(new_postings)

        if skipped_cnt:
            print(f"[Ashby] '{org_slug}' — {len(new_postings)} new, {skipped_cnt} already in DB")
        if not new_postings:
            return []

        # Title pre-filter: skip description fetch for jobs that will be IGNORED anyway.
        # Reuses apply_preliminary_filters directly — same rules, no duplication.
        preliminary_filters = [
            p for p in new_postings
            if _pipeline.apply_preliminary_filters({"title": p.get("title", "")})[0] == "ACTIVE"
        ]
        preliminary_filters_dropped = len(new_postings) - len(preliminary_filters)
        if preliminary_filters_dropped:
            print(f"[Ashby] '{org_slug}' — {preliminary_filters_dropped} filtered by preliminary_filters (skipping description fetch)")
        if not preliminary_filters:
            return []
        new_postings = preliminary_filters

        # ── Adaptive batch size (opt #5) ──────────────────────────────────────
        # Start at DESC_BATCH_MIN, ramp up by 1 each successful batch (max DESC_BATCH_MAX).
        # Drop back to DESC_BATCH_MIN immediately on any 429 within a batch.
        batch_size  = DESC_BATCH_MIN
        consecutive_ok = 0          # successful batches without 429
        jobs: list[dict] = []
        i = 0
        total = len(new_postings)

        while i < total:
            batch    = new_postings[i : i + batch_size]
            batch_no = i // DESC_BATCH_MIN + 1
            total_batches_est = (total + batch_size - 1) // batch_size
            print(f"[Ashby] '{org_slug}' — desc batch {batch_no}/{total_batches_est} "
                  f"({i + len(batch)}/{total}) [batch_size={batch_size}]")

            descriptions = await asyncio.gather(*[
                _fetch_description(client, org_slug, p["id"]) for p in batch
            ])

            # Count 429 failures (returned as None from _fetch_description on HTTPStatusError)
            # We detect 429 via the retry path — if desc is None and batch < MAX chunk we treat as throttled
            none_count = sum(1 for d in descriptions if d is None)
            total_in_batch = len(batch)

            for posting, description in zip(batch, descriptions):
                jobs.append(_map_posting(posting, org_slug, company, description))

            # Adaptive rate: ramp up on clean batches, back off on failures
            if none_count == 0:
                consecutive_ok += 1
                if consecutive_ok >= 3 and batch_size < DESC_BATCH_MAX:
                    batch_size += 1
                    consecutive_ok = 0
                    print(f"[Ashby] '{org_slug}' — ramping batch size → {batch_size}")
            else:
                if batch_size > DESC_BATCH_MIN:
                    batch_size = DESC_BATCH_MIN
                    consecutive_ok = 0
                    print(f"[Ashby] '{org_slug}' — throttle detected, dropping batch size → {batch_size}")

            i += total_in_batch

            if i < total:
                await asyncio.sleep(_jitter(DESC_BATCH_DELAY))

        print(f"[Ashby] '{org_slug}' — done. {len(jobs)} new jobs scraped")
        return jobs

    finally:
        if _own_client:
            await client.aclose()


# ─── Scan Orchestrator ────────────────────────────────────────────────────────

async def run_ashby_scan(
    portals: list[dict],
    skip_ids: set[str],
    pipeline_fn: Callable,
    org_cooldown: float = ORG_COOLDOWN,
    task_tracker: Optional[Callable] = None,    # optional: fn(task) -> task for shutdown tracking
    fetch_descriptions: bool = True,            # when False: skip Phase 2, all descriptions = None
) -> dict:
    """
    Orchestrates a full Ashby scrape across multiple portals.

    Flow:
      1. Deduplicate portals by org_slug.
      2. Fire all LISTING queries in parallel (semaphore-limited to LISTING_CONCURRENCY).
      3. For each org that has new postings, fetch descriptions sequentially with adaptive batching
         (skipped entirely when fetch_descriptions=False — all descriptions will be None).
      4. Fire pipeline immediately per org as a background task.
      5. Wait for all pipeline tasks before returning.

    Args:
        portals:            List of {org_slug, name} dicts.
        skip_ids:           source_ids already in DB.
        pipeline_fn:        async (jobs, org_slug) -> dict
        org_cooldown:       Base seconds between description-fetch sessions.
        fetch_descriptions: When False, Phase 2 is bypassed — descriptions are null.
    """
    # ── Deduplicate ───────────────────────────────────────────────────────────
    seen: set[str] = set()
    unique: list[dict] = []
    for p in portals:
        if p["org_slug"] not in seen:
            seen.add(p["org_slug"])
            unique.append(p)
    if len(unique) < len(portals):
        print(f"[Ashby] Deduplicated {len(portals)} → {len(unique)} unique orgs")
    portals = unique

    print(f"[Ashby] Starting scan — {len(portals)} org(s): {[p['org_slug'] for p in portals]}")

    # ── Shared client for all requests in this scan ───────────────────────────
    async with _make_client() as client:

        # ── Phase 1: Parallel listing queries (opt #3) ────────────────────────
        # All org listing calls fire concurrently (limited by LISTING_CONCURRENCY).
        # This collapses 25 × ~0.5s sequential listings into ~2.5s total.
        listing_semaphore = asyncio.Semaphore(LISTING_CONCURRENCY)

        async def _fetch_listing(portal: dict) -> tuple[dict, list[dict]]:
            async with listing_semaphore:
                org_slug = portal["org_slug"]
                try:
                    postings = await _fetch_all_postings(client, org_slug)
                    print(f"[Ashby] '{org_slug}' — {len(postings)} postings found")
                    return portal, postings
                except Exception as e:
                    print(f"[Ashby] Listing failed for '{org_slug}': {type(e).__name__}: {e}")
                    return portal, []

        print(f"[Ashby] Phase 1 — fetching job listings for all {len(portals)} orgs in parallel...")
        listing_results: list[tuple[dict, list[dict]]] = await asyncio.gather(
            *[_fetch_listing(p) for p in portals]
        )

        # Filter to orgs that have new postings (not in skip_ids)
        orgs_with_new: list[tuple[dict, list[dict]]] = []
        for portal, postings in listing_results:
            new = [p for p in postings if p["id"] not in skip_ids]
            if new:
                # Title pre-filter before desc fetch — reuses apply_preliminary_filters directly
                title_ok = [
                    p for p in new
                    if _pipeline.apply_preliminary_filters({"title": p.get("title", "")})[0] == "ACTIVE"
                ]
                title_dropped = len(new) - len(title_ok)
                if title_dropped:
                    print(f"[Ashby] '{portal['org_slug']}' — {title_dropped} filtered by title before desc fetch")
                if title_ok:
                    orgs_with_new.append((portal, title_ok))
                    continue
            skipped = len(postings) - len(new)
            msg = f"{skipped} already in DB" if skipped else "no postings"
            print(f"[Ashby] '{portal['org_slug']}' → no new jobs ({msg}), skipping")

        print(f"[Ashby] Phase 1 complete — {len(orgs_with_new)}/{len(portals)} orgs have new jobs")

        if not orgs_with_new:
            return {"message": "No new Ashby jobs found.", "total_processed": 0}

        # ── Phase 2: Sequential description fetches + immediate pipeline ──────
        # Descriptions are fetched one org at a time to respect Ashby's rate limits.
        # Pipeline is fired as a background task immediately after each org's descriptions
        # are ready — it runs concurrently with the cooldown and next org's desc fetches.
        pipeline_tasks: list[asyncio.Task] = []

        if not fetch_descriptions:
            # ── PHASE 2 BYPASSED ───────────────────────────────────────────────
            # Skip all HTTP description fetches. Map every posting with description=None
            # and fire the pipeline immediately for each org.
            print(f"[Ashby] Phase 2 BYPASSED (fetch_descriptions=False) — descriptions will be null")
            for portal, new_postings in orgs_with_new:
                org_slug = portal["org_slug"]
                org_name = portal["name"]
                jobs = [_map_posting(p, org_slug, org_name, None) for p in new_postings]
                print(f"[Ashby] '{org_slug}' — {len(jobs)} jobs → pipeline (no descriptions)")
                task = asyncio.create_task(pipeline_fn(jobs, org_slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)
        else:
            print(f"[Ashby] Phase 2 — fetching descriptions sequentially, firing pipeline per org...")
            for idx, (portal, new_postings) in enumerate(orgs_with_new):
                org_slug = portal["org_slug"]
                org_name = portal["name"]

                # Adaptive batch desc fetch (reuses shared client)
                batch_size     = DESC_BATCH_MIN
                consecutive_ok = 0
                jobs: list[dict] = []
                i = 0
                total = len(new_postings)

                while i < total:
                    batch = new_postings[i : i + batch_size]
                    batch_no = i // DESC_BATCH_MIN + 1
                    total_est = (total + batch_size - 1) // batch_size
                    print(f"[Ashby] '{org_slug}' — desc batch {batch_no}/{total_est} "
                          f"({i + len(batch)}/{total}) [bs={batch_size}]")

                    descriptions = await asyncio.gather(*[
                        _fetch_description(client, org_slug, p["id"]) for p in batch
                    ])

                    for posting, description in zip(batch, descriptions):
                        jobs.append(_map_posting(posting, org_slug, org_name, description))

                    none_count = sum(1 for d in descriptions if d is None)
                    if none_count == 0:
                        consecutive_ok += 1
                        if consecutive_ok >= 3 and batch_size < DESC_BATCH_MAX:
                            batch_size += 1
                            consecutive_ok = 0
                            print(f"[Ashby] '{org_slug}' — ramping → bs={batch_size}")
                    else:
                        if batch_size > DESC_BATCH_MIN:
                            batch_size = DESC_BATCH_MIN
                            consecutive_ok = 0
                            print(f"[Ashby] '{org_slug}' — throttle, dropping → bs={batch_size}")

                    i += len(batch)
                    if i < total:
                        await asyncio.sleep(_jitter(DESC_BATCH_DELAY))

                print(f"[Ashby] '{org_slug}' — {len(jobs)} new jobs → pipeline")
                task = asyncio.create_task(pipeline_fn(jobs, org_slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)

                # Cooldown with jitter before next org's description session
                if idx < len(orgs_with_new) - 1:
                    await asyncio.sleep(_jitter(org_cooldown))

    # ── Phase 3: Await all pipeline tasks ────────────────────────────────────
    print(f"[Ashby] Waiting for {len(pipeline_tasks)} pipeline task(s) to complete...")
    results = await asyncio.gather(*pipeline_tasks, return_exceptions=True)

    total_processed = sum(
        r.get("total_processed", 0) for r in results if isinstance(r, dict)
    )
    errors = [str(r) for r in results if isinstance(r, Exception)]
    if errors:
        print(f"[Ashby] {len(errors)} pipeline error(s): {errors}")

    print(f"[Ashby] Scan complete — {len(portals)} orgs checked, {total_processed} new jobs processed")
    return {
        "message": f"Ashby scan complete — {len(portals)} orgs, {total_processed} jobs processed",
        "total_processed": total_processed,
    }
