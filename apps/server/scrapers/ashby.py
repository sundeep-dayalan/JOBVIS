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
from logger import logger

# Shared pipeline instance for title pre-filtering (reads filter.yml once at startup)
_pipeline = JobPipeline()

# ─── Config ───────────────────────────────────────────────────────────────────

ASHBY_GRAPHQL_URL  = "https://jobs.ashbyhq.com/api/non-user-graphql"

# Retry settings
MAX_RETRIES        = 6       # max attempts per request (raised: 3 failures → 0 with extra room)
BACKOFF_BASE       = 2.0    # seconds — doubles each retry
BACKOFF_MAX        = 60.0   # cap

# Listing concurrency (parallel org listing queries)
# Kept low — a semaphore alone doesn't pace requests; the token bucket does that.
LISTING_CONCURRENCY = 3     # how many org listing queries fire at once

# Global rate limit — applied across ALL requests in a scan (listing + desc)
GLOBAL_RATE_RPS    = 2.0    # max requests per second (reduced from 3.0 — fewer 429s overall)
GLOBAL_BURST       = 4      # max burst tokens (tighter burst = smoother ramp-up)

# Description batch settings
DESC_BATCH_MIN     = 2      # starting batch size
DESC_BATCH_MAX     = 5      # max batch size after ramping
DESC_BATCH_DELAY   = 1.2    # base seconds between description batches

# Inter-org cooldown (applied between description-fetch sessions)
ORG_COOLDOWN       = 3.0    # base seconds between orgs

# Jitter range applied to every sleep (±%)
JITTER_PCT         = 0.25


# ─── Rate Limiter ─────────────────────────────────────────────────────────────

class _RateLimiter:
    """
    Async token-bucket rate limiter.

    Smooths out concurrent request bursts that trigger 429s on Ashby's
    GraphQL endpoint when scraping 100+ orgs at once. The semaphore on
    listing concurrency only limits *how many* requests are in flight —
    it does not pace *how fast* they are issued. This limiter does both.

    Usage:
        rl = _RateLimiter()
        await rl.acquire()   # blocks until a token is available
        resp = await client.post(...)
    """
    def __init__(self, rate: float = GLOBAL_RATE_RPS, burst: int = GLOBAL_BURST):
        self._rate   = rate           # tokens/second refill rate
        self._burst  = burst          # max tokens (ceiling)
        self._tokens = float(burst)   # start full — allows initial burst
        self._last   = 0.0            # last acquisition timestamp
        self._lock   = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = asyncio.get_event_loop().time()
            if self._last:
                self._tokens = min(
                    self._burst,
                    self._tokens + (now - self._last) * self._rate,
                )
            self._last = now
            if self._tokens < 1.0:
                wait = (1.0 - self._tokens) / self._rate
                await asyncio.sleep(wait)
                self._tokens = 0.0
            else:
                self._tokens -= 1.0

    async def backpressure(self, penalty_seconds: float) -> None:
        """
        Called when ANY request receives a 429.
        Drains the shared token bucket so all concurrent requests slow down
        globally — not just the one that was rate-limited.

        Without this, concurrent retries stay in sync and re-hit the 429
        wall together, exhausting MAX_RETRIES without ever recovering.
        """
        async with self._lock:
            drain = penalty_seconds * self._rate
            # Floor at -burst to avoid unbounded waits if many 429s stack up
            self._tokens = max(self._tokens - drain, -float(self._burst))


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

import html

def _strip_html(text: str) -> str:
    """Strips HTML tags and unescapes entities to maintain readability."""
    if not text:
        return ""
    
    # 1. Unescape HTML entities (handles double escaping if present)
    text = html.unescape(text)
    if '&lt;' in text or '&gt;' in text or '&amp;' in text:
        text = html.unescape(text)
        
    # 2. Add spaces or newlines around certain tags to preserve layout readability
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</(p|div|ul|ol|h[1-6]|tr)>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<li[^>]*>', '\n• ', text, flags=re.IGNORECASE)
    text = re.sub(r'</li>', '\n', text, flags=re.IGNORECASE)
    
    # 3. Strip remaining HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    
    # 4. Clean up excessive whitespace
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n ?\n+', '\n\n', text)
    
    return text.strip()


def _jitter(base: float) -> float:
    """Adds ±JITTER_PCT random jitter to a delay so we don't look like a cron job."""
    return base * (1 + random.uniform(-JITTER_PCT, JITTER_PCT))


def _map_posting(posting: dict, org_slug: str, org_name: str, description: Optional[str]) -> dict:
    """Maps a raw Ashby jobPosting to the JOBVIS standard schema."""
    posting_id = posting.get("id")
    source_url = f"https://jobs.ashbyhq.com/{org_slug}/{posting_id}"
    workplace_map = {"Remote": "Remote", "Hybrid": "Hybrid", "OnSite": "On-site"}

    mapped = {
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
    # Snapshot all fields as raw_data for archival/re-scanning (mirrors linkedinDataMapper behaviour)
    mapped["raw_data"] = {k: v for k, v in mapped.items()}
    return mapped


# ─── Retry Logic ─────────────────────────────────────────────────────────────

async def _post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    json: dict,
    label: str,
    rate_limiter: Optional["_RateLimiter"] = None,
) -> httpx.Response:
    """
    POST with exponential backoff + jitter retry.
    Retries on 429 (rate limit) and 5xx (transient server errors).
    Raises on final failure or 4xx (except 429).

    If rate_limiter is provided, acquires a token before every attempt
    so the caller doesn't need to manage pacing separately.

    On 429 responses, respects the Retry-After header when present
    instead of using our own backoff estimate.
    """
    delay = BACKOFF_BASE
    for attempt in range(1, MAX_RETRIES + 1):
        if rate_limiter:
            await rate_limiter.acquire()
        try:
            resp = await client.post(url, params=params, json=json)

            if resp.status_code == 429:
                # Use Retry-After if present, but never trust a value < our own backoff.
                # Ashby sometimes returns Retry-After: 0 — honoring it causes instant
                # re-bursts that exhaust all retries in milliseconds.
                own_backoff = min(_jitter(delay), BACKOFF_MAX)
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    try:
                        wait = max(float(retry_after), own_backoff)
                    except ValueError:
                        wait = own_backoff
                else:
                    wait = own_backoff
                logger.warning("[Ashby] 429 on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
                # Signal the shared rate limiter to slow ALL concurrent requests,
                # not just this one — prevents synchronized retry storms.
                if rate_limiter:
                    await rate_limiter.backpressure(wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            if resp.status_code >= 500:
                wait = min(_jitter(delay), BACKOFF_MAX)
                logger.warning("[Ashby] {} on {} — retry {}/{} in {:.1f}s", resp.status_code, label, attempt, MAX_RETRIES, wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            resp.raise_for_status()
            return resp

        except httpx.TimeoutException:
            wait = min(_jitter(delay), BACKOFF_MAX)
            logger.warning("[Ashby] Timeout on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
            await asyncio.sleep(wait)
            delay *= 2

    raise RuntimeError(f"[Ashby] Gave up after {MAX_RETRIES} retries: {label}")


# ─── Core Fetchers ────────────────────────────────────────────────────────────

async def _fetch_all_postings(
    client: httpx.AsyncClient,
    org_slug: str,
    rate_limiter: Optional[_RateLimiter] = None,
) -> list[dict]:
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
        rate_limiter=rate_limiter,
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
    rate_limiter: Optional[_RateLimiter] = None,
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
            rate_limiter=rate_limiter,
        )
        html = (resp.json().get("data") or {}).get("jobPosting", {}).get("descriptionHtml")
        return _strip_html(html) if html else None
    except Exception as e:
        logger.warning("[Ashby] Failed to fetch description for {}: {}: {}", posting_id, type(e).__name__, e)
        return None


# ─── Single-Org Scraper ───────────────────────────────────────────────────────

async def scrape_ashby_org(
    org_slug: str,
    org_name: Optional[str] = None,
    skip_ids: Optional[set] = None,
    client: Optional[httpx.AsyncClient] = None,
    only_ids: Optional[set] = None,
) -> list[dict]:
    """
    Scrapes job postings for a single Ashby org.

    Args:
        org_slug:  The slug in jobs.ashbyhq.com/<org_slug>
        org_name:  Display name (falls back to org_slug)
        skip_ids:  source_ids already in DB — excludes from output (normal scan mode)
        client:    Shared httpx client (created internally if not provided)
        only_ids:  When set, fetches ONLY these specific posting IDs (rescan mode).
                   Bypasses skip_ids dedup and title pre-filter entirely.

    Returns:
        List of job dicts in JOBVIS standard schema.
    """
    company = org_name or org_slug
    logger.info("[Ashby] Scraping '{}' ({})", org_slug, company)

    _own_client = client is None
    if _own_client:
        client = _make_client(org_slug)

    try:
        postings = await _fetch_all_postings(client, org_slug)
        logger.info("[Ashby] '{}' — found {} total postings", org_slug, len(postings))

        if not postings:
            return []

        if only_ids is not None:
            # Rescan mode: target specific known IDs — skip dedup and title pre-filter
            new_postings = [p for p in postings if p["id"] in only_ids]
            logger.info("[Ashby] '{}' — rescan mode: {}/{} IDs found in listing", org_slug, len(new_postings), len(only_ids))
        else:
            skip        = skip_ids or set()
            new_postings = [p for p in postings if p["id"] not in skip]
            skipped_cnt  = len(postings) - len(new_postings)

            if skipped_cnt:
                logger.info("[Ashby] '{}' — {} new, {} already in DB", org_slug, len(new_postings), skipped_cnt)
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
                logger.info("[Ashby] '{}' — {} filtered by preliminary_filters (skipping description fetch)", org_slug, preliminary_filters_dropped)
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
            logger.debug("[Ashby] '{}' — desc batch {}/{} ({}/{}) [batch_size={}]", org_slug, batch_no, total_batches_est, i + len(batch), total, batch_size)

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
                    logger.debug("[Ashby] '{}' — ramping batch size → {}", org_slug, batch_size)
            else:
                if batch_size > DESC_BATCH_MIN:
                    batch_size = DESC_BATCH_MIN
                    consecutive_ok = 0
                    logger.warning("[Ashby] '{}' — throttle detected, dropping batch size → {}", org_slug, batch_size)

            i += total_in_batch

            if i < total:
                await asyncio.sleep(_jitter(DESC_BATCH_DELAY))

        logger.info("[Ashby] '{}' — done. {} new jobs scraped", org_slug, len(jobs))
        return jobs

    finally:
        if _own_client:
            await client.aclose()


# ─── Rescan Helper ───────────────────────────────────────────────────────────

async def refetch_descriptions(jobs: list[dict]) -> None:
    """
    For Ashby jobs with a missing description, re-scrapes fresh data per org using
    scrape_ashby_org (only_ids mode) — reuses all batching/retry logic.
    Replaces matching entries in `jobs` in-place with fresh dicts (description + raw_data).
    """
    targets = [j for j in jobs if j.get("source") == "ashby" and not j.get("description")]
    if not targets:
        return

    # Group by org_slug (derived from source_url: https://jobs.ashbyhq.com/{org_slug}/{id})
    orgs: dict[str, dict] = {}
    for job in targets:
        parts = (job.get("source_url") or "").rstrip("/").split("/")
        org_slug = parts[-2] if len(parts) >= 2 else ""
        if not org_slug:
            continue
        if org_slug not in orgs:
            orgs[org_slug] = {"name": job.get("company_name", org_slug), "ids": set()}
        orgs[org_slug]["ids"].add(job.get("source_id"))

    if not orgs:
        return

    logger.info("[Ashby] Rescan: fetching descriptions for {} jobs across {} org(s)...", len(targets), len(orgs))

    # Fetch fresh dicts per org — reuses scrape_ashby_org's batching/retry/adaptive logic
    fresh: dict[str, dict] = {}
    for org_slug, meta in orgs.items():
        fetched = await scrape_ashby_org(org_slug, org_name=meta["name"], only_ids=meta["ids"])
        for fj in fetched:
            fresh[fj["source_id"]] = fj

    # Replace stale job dicts with fresh ones (fresh dicts already have raw_data snapshotted)
    for i, job in enumerate(jobs):
        if job.get("source_id") in fresh:
            jobs[i] = fresh[job["source_id"]]

    logger.info("[Ashby] Rescan: refreshed {} job(s) with fresh descriptions", len(fresh))


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
      1. Deduplicate portals by slug.
      2. Fire all LISTING queries in parallel (semaphore-limited to LISTING_CONCURRENCY).
      3. For each org that has new postings, fetch descriptions sequentially with adaptive batching
         (skipped entirely when fetch_descriptions=False — all descriptions will be None).
      4. Fire pipeline immediately per org as a background task.
      5. Wait for all pipeline tasks before returning.

    Args:
        portals:            List of {slug, name} dicts.
        skip_ids:           source_ids already in DB.
        pipeline_fn:        async (jobs, slug) -> dict
        org_cooldown:       Base seconds between description-fetch sessions.
        fetch_descriptions: When False, Phase 2 is bypassed — descriptions are null.
    """
    # ── Deduplicate ───────────────────────────────────────────────────────────
    seen: set[str] = set()
    unique: list[dict] = []
    for p in portals:
        if p["slug"] not in seen:
            seen.add(p["slug"])
            unique.append(p)
    if len(unique) < len(portals):
        logger.info("[Ashby] Deduplicated {} → {} unique orgs", len(portals), len(unique))
    portals = unique

    logger.info("[Ashby] Starting scan — {} org(s): {}", len(portals), [p['slug'] for p in portals])

    # ── Shared client + rate limiter for all requests in this scan ───────────
    rate_limiter = _RateLimiter(rate=GLOBAL_RATE_RPS, burst=GLOBAL_BURST)

    async with _make_client() as client:

        # ── Phase 1: Parallel listing queries ────────────────────────────────
        listing_semaphore = asyncio.Semaphore(LISTING_CONCURRENCY)

        failed_orgs: list[str] = []

        async def _fetch_listing(portal: dict) -> tuple[dict, list[dict]]:
            async with listing_semaphore:
                slug = portal["slug"]
                try:
                    postings = await _fetch_all_postings(client, slug, rate_limiter=rate_limiter)
                    logger.info("[Ashby] '{}' — {} postings found", slug, len(postings))
                    return portal, postings
                except Exception as e:
                    logger.warning("[Ashby] Listing failed for '{}': {}: {}", slug, type(e).__name__, e)
                    failed_orgs.append(slug)
                    return portal, []

        logger.info("[Ashby] Phase 1 — fetching job listings for all {} orgs in parallel...", len(portals))
        listing_results: list[tuple[dict, list[dict]]] = await asyncio.gather(
            *[_fetch_listing(p) for p in portals]
        )

        # Filter to orgs that have new postings (not in skip_ids)
        orgs_with_new: list[tuple[dict, list[dict]]] = []
        for portal, postings in listing_results:
            new = [p for p in postings if p["id"] not in skip_ids]
            if new:
                title_ok = [
                    p for p in new
                    if _pipeline.apply_preliminary_filters({"title": p.get("title", "")})[0] == "ACTIVE"
                ]
                title_dropped = len(new) - len(title_ok)
                if title_dropped:
                    logger.info("[Ashby] '{}' — {} filtered by title before desc fetch", portal['slug'], title_dropped)
                if title_ok:
                    orgs_with_new.append((portal, title_ok))
                    continue
            skipped = len(postings) - len(new)
            msg = f"{skipped} already in DB" if skipped else "no postings"
            logger.info("[Ashby] '{}' → no new jobs ({}), skipping", portal['slug'], msg)

        if failed_orgs:
            logger.warning("[Ashby] Phase 1 FAILURES ({}/{}): {}", len(failed_orgs), len(portals), failed_orgs)
        logger.info("[Ashby] Phase 1 complete — {}/{} orgs have new jobs", len(orgs_with_new), len(portals))

        if not orgs_with_new:
            return {
                "message": "No new Ashby jobs found.", "total_processed": 0,
                "failed_orgs": failed_orgs,
            }

        # ── Phase 2: Sequential description fetches + immediate pipeline ──────
        pipeline_tasks: list[asyncio.Task] = []

        if not fetch_descriptions:
            logger.info("[Ashby] Phase 2 BYPASSED (fetch_descriptions=False) — descriptions will be null")
            for portal, new_postings in orgs_with_new:
                slug     = portal["slug"]
                org_name = portal["name"]
                jobs = [_map_posting(p, slug, org_name, None) for p in new_postings]
                logger.info("[Ashby] '{}' — {} jobs → pipeline (no descriptions)", slug, len(jobs))
                task = asyncio.create_task(pipeline_fn(jobs, slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)
        else:
            logger.info("[Ashby] Phase 2 — fetching descriptions sequentially, firing pipeline per org...")
            for idx, (portal, new_postings) in enumerate(orgs_with_new):
                slug     = portal["slug"]
                org_name = portal["name"]

                batch_size     = DESC_BATCH_MIN
                consecutive_ok = 0
                jobs: list[dict] = []
                i = 0
                total = len(new_postings)

                while i < total:
                    batch = new_postings[i : i + batch_size]
                    batch_no = i // DESC_BATCH_MIN + 1
                    total_est = (total + batch_size - 1) // batch_size
                    logger.debug("[Ashby] '{}' — desc batch {}/{} ({}/{}) [bs={}]", slug, batch_no, total_est, i + len(batch), total, batch_size)

                    descriptions = await asyncio.gather(*[
                        _fetch_description(client, slug, p["id"], rate_limiter=rate_limiter) for p in batch
                    ])

                    for posting, description in zip(batch, descriptions):
                        jobs.append(_map_posting(posting, slug, org_name, description))

                    none_count = sum(1 for d in descriptions if d is None)
                    if none_count == 0:
                        consecutive_ok += 1
                        if consecutive_ok >= 3 and batch_size < DESC_BATCH_MAX:
                            batch_size += 1
                            consecutive_ok = 0
                            logger.debug("[Ashby] '{}' — ramping → bs={}", slug, batch_size)
                    else:
                        if batch_size > DESC_BATCH_MIN:
                            batch_size = DESC_BATCH_MIN
                            consecutive_ok = 0
                            logger.warning("[Ashby] '{}' — throttle, dropping → bs={}", slug, batch_size)

                    i += len(batch)
                    if i < total:
                        await asyncio.sleep(_jitter(DESC_BATCH_DELAY))

                logger.info("[Ashby] '{}' — {} new jobs → pipeline", slug, len(jobs))
                task = asyncio.create_task(pipeline_fn(jobs, slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)

                if idx < len(orgs_with_new) - 1:
                    await asyncio.sleep(_jitter(org_cooldown))

    # ── Phase 3: Await all pipeline tasks ────────────────────────────────────
    logger.info("[Ashby] Waiting for {} pipeline task(s) to complete...", len(pipeline_tasks))
    results = await asyncio.gather(*pipeline_tasks, return_exceptions=True)

    dicts = [r for r in results if isinstance(r, dict)]
    errors = [str(r) for r in results if isinstance(r, Exception)]
    if errors:
        logger.warning("[Ashby] {} pipeline error(s): {}", len(errors), errors)

    total_processed = sum(r.get("total_processed", 0) for r in dicts)
    total_scanned   = sum(r.get("total_scanned",   0) for r in dicts)
    total_saved     = sum(r.get("total_saved",     0) for r in dicts)
    total_ignored   = sum(r.get("total_ignored",   0) for r in dicts)

    if failed_orgs:
        logger.warning("[Ashby] Scan finished with {} failed org(s): {}", len(failed_orgs), failed_orgs)
    logger.info("[Ashby] Scan complete — {} orgs checked, {} new jobs processed", len(portals), total_processed)
    return {
        "message":         f"Ashby scan complete — {len(portals)} orgs, {total_processed} jobs processed",
        "total_processed": total_processed,
        "total_scanned":   total_scanned,
        "total_saved":     total_saved,
        "total_ignored":   total_ignored,
        "failed_orgs":     failed_orgs,
    }
