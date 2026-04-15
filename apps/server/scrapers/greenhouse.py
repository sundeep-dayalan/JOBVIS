"""
JOBVIS Greenhouse Scraper — Server-Side
========================================
Scrapes job postings from any Greenhouse-powered public job board using their
REST API. No auth, no browser extension required.

Public endpoints used:
  GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
  GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}

Optimizations:
  1. Retry with exponential backoff  — recovers from transient 429 / 5xx
  2. Shared httpx.AsyncClient        — connection pooling across all board scrapes
  3. Parallel listing queries        — all board listing calls fire concurrently (semaphore-limited)
  4. Random jitter on delays         — avoids bot-looking clock patterns
  5. Adaptive batch size             — starts at 2, ramps up to 5 on success, drops on 429

Usage:
  from scrapers.greenhouse import run_greenhouse_scan
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

GREENHOUSE_BASE_URL = "https://boards-api.greenhouse.io/v1/boards"

# Retry settings
MAX_RETRIES         = 6       # max attempts per request
BACKOFF_BASE        = 2.0    # seconds — doubles each retry
BACKOFF_MAX         = 60.0   # cap

# Listing concurrency (parallel board listing queries)
LISTING_CONCURRENCY = 3      # how many board listing queries fire at once

# Global rate limit — applied across ALL requests in a scan (listing + desc)
GLOBAL_RATE_RPS     = 2.0    # max requests per second
GLOBAL_BURST        = 4      # max burst tokens

# Description batch settings
DESC_BATCH_MIN      = 2      # starting batch size
DESC_BATCH_MAX      = 5      # max batch size after ramping
DESC_BATCH_DELAY    = 1.2    # base seconds between description batches

# Inter-board cooldown (applied between description-fetch sessions)
ORG_COOLDOWN        = 3.0    # base seconds between boards

# Jitter range applied to every sleep (±%)
JITTER_PCT          = 0.25


# ─── Rate Limiter ─────────────────────────────────────────────────────────────

class _RateLimiter:
    """
    Async token-bucket rate limiter — same pattern as Ashby scraper.

    Smooths out concurrent request bursts that trigger 429s on Greenhouse's
    API when scraping many boards at once. The semaphore on listing concurrency
    only limits *how many* requests are in flight — it does not pace *how fast*
    they are issued. This limiter does both.
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
        """
        async with self._lock:
            drain = penalty_seconds * self._rate
            self._tokens = max(self._tokens - drain, -float(self._burst))


# ─── Shared HTTP Client ───────────────────────────────────────────────────────

def _make_client() -> httpx.AsyncClient:
    """Creates a shared httpx.AsyncClient with browser-like headers."""
    return httpx.AsyncClient(
        headers={
            "Accept":          "application/json",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
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


def _map_job(job: dict, board_token: str, board_name: str, description: Optional[str]) -> dict:
    """Maps a raw Greenhouse job to the JOBVIS standard schema."""
    job_id     = str(job.get("id", ""))
    source_url = job.get("absolute_url") or f"https://boards.greenhouse.io/{board_token}/jobs/{job_id}"
    location   = (job.get("location") or {}).get("name")
    updated_at = job.get("updated_at")

    mapped = {
        "source":         "greenhouse",
        "source_id":      job_id,
        "source_url":     source_url,
        "apply_url":      source_url,
        "title":          (job.get("title") or "").strip() or None,
        "company_name":   board_name,
        "description":    description,
        "location":       location,
        "workType":       None,   # Not available in Greenhouse listing
        "employmentType": None,   # Not available in Greenhouse listing
        "salary_info":    None,   # Not available in Greenhouse listing
        "job_posted_at":  updated_at,
        "job_updated_at": updated_at,
        "scrapedAt":      datetime.now(timezone.utc).isoformat(),
    }
    mapped["raw_data"] = {k: v for k, v in mapped.items()}
    return mapped


# ─── Retry Logic ─────────────────────────────────────────────────────────────

async def _get_with_retry(
    client: httpx.AsyncClient,
    url: str,
    label: str,
    rate_limiter: Optional["_RateLimiter"] = None,
) -> httpx.Response:
    """
    GET with exponential backoff + jitter retry.
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
            resp = await client.get(url)

            if resp.status_code == 429:
                own_backoff = min(_jitter(delay), BACKOFF_MAX)
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    try:
                        wait = max(float(retry_after), own_backoff)
                    except ValueError:
                        wait = own_backoff
                else:
                    wait = own_backoff
                logger.warning("[Greenhouse] 429 on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
                if rate_limiter:
                    await rate_limiter.backpressure(wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            if resp.status_code >= 500:
                wait = min(_jitter(delay), BACKOFF_MAX)
                logger.warning("[Greenhouse] {} on {} — retry {}/{} in {:.1f}s", resp.status_code, label, attempt, MAX_RETRIES, wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            resp.raise_for_status()
            return resp

        except httpx.TimeoutException:
            wait = min(_jitter(delay), BACKOFF_MAX)
            logger.warning("[Greenhouse] Timeout on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
            await asyncio.sleep(wait)
            delay *= 2

    raise RuntimeError(f"[Greenhouse] Gave up after {MAX_RETRIES} retries: {label}")


# ─── Core Fetchers ────────────────────────────────────────────────────────────

async def _fetch_all_jobs(
    client: httpx.AsyncClient,
    board_token: str,
    rate_limiter: Optional[_RateLimiter] = None,
) -> list[dict]:
    """Fetches the full listing of jobs for a board (IDs + brief metadata only)."""
    url = f"{GREENHOUSE_BASE_URL}/{board_token}/jobs"
    resp = await _get_with_retry(client, url, label=f"listing/{board_token}", rate_limiter=rate_limiter)
    data = resp.json()
    jobs = data.get("jobs") or []

    if not jobs:
        # Greenhouse returns {"jobs": [], "meta": {...}} for empty boards — not an error
        logger.info("[Greenhouse] '{}' — board returned 0 jobs", board_token)
    return jobs


async def _fetch_description(
    client: httpx.AsyncClient,
    board_token: str,
    job_id: str,
    rate_limiter: Optional[_RateLimiter] = None,
) -> Optional[str]:
    """Fetches the full HTML description for a single job and strips tags."""
    try:
        url = f"{GREENHOUSE_BASE_URL}/{board_token}/jobs/{job_id}"
        resp = await _get_with_retry(client, url, label=f"desc/{board_token}/{job_id}", rate_limiter=rate_limiter)
        html = resp.json().get("content")
        return _strip_html(html) if html else None
    except Exception as e:
        logger.warning("[Greenhouse] Failed to fetch description for {}: {}: {}", job_id, type(e).__name__, e)
        return None


# ─── Scan Orchestrator ────────────────────────────────────────────────────────

async def run_greenhouse_scan(
    portals: list[dict],
    skip_ids: set[str],
    pipeline_fn: Callable,
    org_cooldown: float = ORG_COOLDOWN,
    task_tracker: Optional[Callable] = None,    # optional: fn(task) -> task for shutdown tracking
    fetch_descriptions: bool = True,            # when False: skip Phase 2, all descriptions = None
) -> dict:
    """
    Orchestrates a full Greenhouse scrape across multiple boards.

    Flow:
      1. Deduplicate portals by slug.
      2. Fire all LISTING queries in parallel (semaphore-limited to LISTING_CONCURRENCY).
      3. For each board that has new jobs, fetch descriptions sequentially with adaptive batching
         (skipped entirely when fetch_descriptions=False — all descriptions will be None).
      4. Fire pipeline immediately per board as a background task.
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
        logger.info("[Greenhouse] Deduplicated {} → {} unique boards", len(portals), len(unique))
    portals = unique

    logger.info("[Greenhouse] Starting scan — {} board(s): {}", len(portals), [p['slug'] for p in portals])

    # ── Shared client + rate limiter for all requests in this scan ───────────
    rate_limiter = _RateLimiter(rate=GLOBAL_RATE_RPS, burst=GLOBAL_BURST)

    async with _make_client() as client:

        # ── Phase 1: Parallel listing queries ────────────────────────────────
        listing_semaphore = asyncio.Semaphore(LISTING_CONCURRENCY)
        failed_boards: list[str] = []

        async def _fetch_listing(portal: dict) -> tuple[dict, list[dict]]:
            async with listing_semaphore:
                slug = portal["slug"]
                try:
                    jobs = await _fetch_all_jobs(client, slug, rate_limiter=rate_limiter)
                    logger.info("[Greenhouse] '{}' — {} jobs found", slug, len(jobs))
                    return portal, jobs
                except Exception as e:
                    logger.warning("[Greenhouse] Listing failed for '{}': {}: {}", slug, type(e).__name__, e)
                    failed_boards.append(slug)
                    return portal, []

        logger.info("[Greenhouse] Phase 1 — fetching job listings for all {} boards in parallel...", len(portals))
        listing_results: list[tuple[dict, list[dict]]] = await asyncio.gather(
            *[_fetch_listing(p) for p in portals]
        )

        # Filter to boards that have new jobs (not in skip_ids)
        boards_with_new: list[tuple[dict, list[dict]]] = []
        for portal, jobs in listing_results:
            new = [j for j in jobs if str(j.get("id", "")) not in skip_ids]
            if new:
                title_ok = [
                    j for j in new
                    if _pipeline.apply_preliminary_filters({"title": j.get("title", "")})[0] == "ACTIVE"
                ]
                title_dropped = len(new) - len(title_ok)
                if title_dropped:
                    logger.info("[Greenhouse] '{}' — {} filtered by title before desc fetch", portal['slug'], title_dropped)
                if title_ok:
                    boards_with_new.append((portal, title_ok))
                    continue
            skipped = len(jobs) - len(new)
            msg = f"{skipped} already in DB" if skipped else "no jobs"
            logger.info("[Greenhouse] '{}' → no new jobs ({}), skipping", portal['slug'], msg)

        if failed_boards:
            logger.warning("[Greenhouse] Phase 1 FAILURES ({}/{}): {}", len(failed_boards), len(portals), failed_boards)
        logger.info("[Greenhouse] Phase 1 complete — {}/{} boards have new jobs", len(boards_with_new), len(portals))

        if not boards_with_new:
            return {
                "message": "No new Greenhouse jobs found.", "total_processed": 0,
                "failed_boards": failed_boards,
            }

        # ── Phase 2: Sequential description fetches + immediate pipeline ──────
        pipeline_tasks: list[asyncio.Task] = []

        if not fetch_descriptions:
            # ── PHASE 2 BYPASSED ───────────────────────────────────────────────
            logger.info("[Greenhouse] Phase 2 BYPASSED (fetch_descriptions=False) — descriptions will be null")
            for portal, new_jobs in boards_with_new:
                slug = portal["slug"]
                board_name = portal["name"]
                mapped_jobs = [_map_job(j, slug, board_name, None) for j in new_jobs]
                logger.info("[Greenhouse] '{}' — {} jobs → pipeline (no descriptions)", slug, len(mapped_jobs))
                task = asyncio.create_task(pipeline_fn(mapped_jobs, slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)
        else:
            logger.info("[Greenhouse] Phase 2 — fetching descriptions sequentially, firing pipeline per board...")
            for idx, (portal, new_jobs) in enumerate(boards_with_new):
                slug = portal["slug"]
                board_name = portal["name"]

                # Adaptive batch desc fetch (reuses shared client)
                batch_size     = DESC_BATCH_MIN
                consecutive_ok = 0
                result_jobs: list[dict] = []
                i = 0
                total = len(new_jobs)

                while i < total:
                    batch = new_jobs[i : i + batch_size]
                    batch_no = i // DESC_BATCH_MIN + 1
                    total_est = (total + batch_size - 1) // batch_size
                    logger.debug("[Greenhouse] '{}' — desc batch {}/{} ({}/{}) [bs={}]", slug, batch_no, total_est, i + len(batch), total, batch_size)

                    descriptions = await asyncio.gather(*[
                        _fetch_description(client, slug, str(j["id"]), rate_limiter=rate_limiter)
                        for j in batch
                    ])

                    for job, description in zip(batch, descriptions):
                        result_jobs.append(_map_job(job, slug, board_name, description))

                    none_count = sum(1 for d in descriptions if d is None)
                    if none_count == 0:
                        consecutive_ok += 1
                        if consecutive_ok >= 3 and batch_size < DESC_BATCH_MAX:
                            batch_size += 1
                            consecutive_ok = 0
                            logger.debug("[Greenhouse] '{}' — ramping → bs={}", slug, batch_size)
                    else:
                        if batch_size > DESC_BATCH_MIN:
                            batch_size = DESC_BATCH_MIN
                            consecutive_ok = 0
                            logger.warning("[Greenhouse] '{}' — throttle, dropping → bs={}", slug, batch_size)

                    i += len(batch)
                    if i < total:
                        await asyncio.sleep(_jitter(DESC_BATCH_DELAY))

                logger.info("[Greenhouse] '{}' — {} new jobs → pipeline", slug, len(result_jobs))
                task = asyncio.create_task(pipeline_fn(result_jobs, slug))
                if task_tracker:
                    task_tracker(task)
                pipeline_tasks.append(task)

                # Cooldown with jitter before next board's description session
                if idx < len(boards_with_new) - 1:
                    await asyncio.sleep(_jitter(org_cooldown))

    # ── Phase 3: Await all pipeline tasks ────────────────────────────────────
    logger.info("[Greenhouse] Waiting for {} pipeline task(s) to complete...", len(pipeline_tasks))
    results = await asyncio.gather(*pipeline_tasks, return_exceptions=True)

    dicts  = [r for r in results if isinstance(r, dict)]
    errors = [str(r) for r in results if isinstance(r, Exception)]
    if errors:
        logger.warning("[Greenhouse] {} pipeline error(s): {}", len(errors), errors)

    total_processed = sum(r.get("total_processed", 0) for r in dicts)
    total_scanned   = sum(r.get("total_scanned",   0) for r in dicts)
    total_saved     = sum(r.get("total_saved",     0) for r in dicts)
    total_ignored   = sum(r.get("total_ignored",   0) for r in dicts)

    if failed_boards:
        logger.warning("[Greenhouse] Scan finished with {} failed board(s): {}", len(failed_boards), failed_boards)
    logger.info("[Greenhouse] Scan complete — {} boards checked, {} new jobs processed", len(portals), total_processed)
    return {
        "message":         f"Greenhouse scan complete — {len(portals)} boards, {total_processed} jobs processed",
        "total_processed": total_processed,
        "total_scanned":   total_scanned,
        "total_saved":     total_saved,
        "total_ignored":   total_ignored,
        "failed_boards":   failed_boards,
    }
