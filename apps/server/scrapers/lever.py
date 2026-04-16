"""
JOBVIS Lever Scraper — Server-Side
====================================
Scrapes job postings from any Lever-powered job board using their
public REST API. No auth, no browser extension required.

Public endpoint used:
  GET https://api.lever.co/v0/postings/<slug>?mode=json

Key advantage over Ashby/Greenhouse:
  The Lever listing API returns the full job description alongside
  every posting in a SINGLE call — no separate per-job description
  fetch is needed. This makes the scan substantially simpler and faster.

Optimizations:
  1. Retry with exponential backoff  — recovers from transient 429 / 5xx
  2. Shared httpx.AsyncClient        — connection pooling across all org scrapes
  3. Parallel listing queries        — all org listing calls fire concurrently (semaphore-limited)
  4. Random jitter on delays         — avoids bot-looking clock patterns

Usage:
  from scrapers.lever import run_lever_scan
"""

import asyncio
import html as _html_module
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

LEVER_BASE_URL      = "https://api.lever.co/v0/postings"

# Retry settings
MAX_RETRIES         = 6       # max attempts per request
BACKOFF_BASE        = 2.0    # seconds — doubles each retry
BACKOFF_MAX         = 60.0   # cap

# Listing concurrency (parallel org listing queries)
LISTING_CONCURRENCY = 3      # how many org listing queries fire at once

# Global rate limit — applied across ALL listing requests in a scan
GLOBAL_RATE_RPS     = 2.0    # max requests per second
GLOBAL_BURST        = 4      # max burst tokens

# Inter-org cooldown (applied between sequential pipeline dispatches)
ORG_COOLDOWN        = 1.5    # base seconds between orgs (no desc fetches, so shorter)

# Jitter range applied to every sleep (±%)
JITTER_PCT          = 0.25


# ─── Rate Limiter ─────────────────────────────────────────────────────────────

class _RateLimiter:
    """
    Async token-bucket rate limiter — same pattern as Ashby/Greenhouse scrapers.

    Smooths out concurrent request bursts. The semaphore on listing concurrency
    only limits *how many* requests are in flight — this limiter controls *how fast*.
    """
    def __init__(self, rate: float = GLOBAL_RATE_RPS, burst: int = GLOBAL_BURST):
        self._rate   = rate
        self._burst  = burst
        self._tokens = float(burst)
        self._last   = 0.0
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
        """Drains the token bucket globally on 429 so all concurrent requests slow down."""
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

def _strip_html(text: str) -> str:
    """Strips HTML tags and unescapes entities to maintain readability."""
    if not text:
        return ""

    # 1. Unescape HTML entities (handles double escaping if present)
    text = _html_module.unescape(text)
    if '&lt;' in text or '&gt;' in text or '&amp;' in text:
        text = _html_module.unescape(text)

    # 2. Add newlines around structural tags to preserve readability
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


def _map_posting(posting: dict, slug: str, org_name: str) -> dict:
    """Maps a raw Lever posting (from the listing API) to the JOBVIS standard schema."""
    posting_id = posting.get("id") or ""
    categories = posting.get("categories") or {}

    # Location — prefer the named field, fall back to allLocations list
    location = categories.get("location") or None
    all_locations = categories.get("allLocations") or []
    if not location and all_locations:
        location = all_locations[0]

    # Workplace type normalisation
    workplace_raw = (posting.get("workplaceType") or "").lower()
    workplace_map = {
        "remote": "Remote",
        "hybrid": "Hybrid",
        "onsite": "On-site",
    }
    work_type = workplace_map.get(workplace_raw) or (workplace_raw.capitalize() if workplace_raw else None)

    # Employment type (e.g. "Full-time", "Contract")
    commitment = categories.get("commitment") or None

    # Description — Lever listing includes plain-text and/or HTML fields.
    # Prefer plain-text fields (no stripping needed); fall back to HTML stripping.
    desc_plain      = (posting.get("descriptionPlain") or "").strip()
    desc_body_plain = (posting.get("descriptionBodyPlain") or "").strip()
    opening_plain   = (posting.get("openingPlain") or "").strip()

    if desc_plain or desc_body_plain or opening_plain:
        description = "\n\n".join(filter(None, [desc_plain, desc_body_plain, opening_plain])) or None
    else:
        # Fall back to HTML fields — strip tags ourselves
        desc_html      = posting.get("description") or ""
        desc_body_html = posting.get("descriptionBody") or ""
        opening_html   = posting.get("opening") or ""
        combined_html  = "\n".join(filter(None, [desc_html, desc_body_html, opening_html]))
        description    = _strip_html(combined_html) or None

    # Posted timestamp — Lever uses millisecond epoch integers
    created_at_ms = posting.get("createdAt")
    if created_at_ms:
        try:
            posted_at = datetime.fromtimestamp(created_at_ms / 1000, tz=timezone.utc).isoformat()
        except (OSError, OverflowError, ValueError):
            posted_at = None
    else:
        posted_at = None

    source_url = posting.get("hostedUrl") or f"https://jobs.lever.co/{slug}/{posting_id}"
    apply_url  = posting.get("applyUrl") or source_url

    mapped = {
        "source":         "lever",
        "source_id":      posting_id,
        "source_url":     source_url,
        "apply_url":      apply_url,
        "title":          (posting.get("text") or "").strip() or None,
        "company_name":   org_name,
        "description":    description,
        "location":       location,
        "workType":       work_type,
        "employmentType": commitment,
        "salary_info":    None,   # Not exposed by Lever listing API
        "job_posted_at":  posted_at,
        "job_updated_at": posted_at,
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
                logger.warning("[Lever] 429 on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
                if rate_limiter:
                    await rate_limiter.backpressure(wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            if resp.status_code >= 500:
                wait = min(_jitter(delay), BACKOFF_MAX)
                logger.warning("[Lever] {} on {} — retry {}/{} in {:.1f}s", resp.status_code, label, attempt, MAX_RETRIES, wait)
                await asyncio.sleep(wait)
                delay *= 2
                continue

            resp.raise_for_status()
            return resp

        except httpx.TimeoutException:
            wait = min(_jitter(delay), BACKOFF_MAX)
            logger.warning("[Lever] Timeout on {} — retry {}/{} in {:.1f}s", label, attempt, MAX_RETRIES, wait)
            await asyncio.sleep(wait)
            delay *= 2

    raise RuntimeError(f"[Lever] Gave up after {MAX_RETRIES} retries: {label}")


# ─── Core Fetcher ─────────────────────────────────────────────────────────────

async def _fetch_all_postings(
    client: httpx.AsyncClient,
    slug: str,
    rate_limiter: Optional[_RateLimiter] = None,
) -> list[dict]:
    """
    Fetches ALL postings for a Lever org slug in a single API call.
    The Lever API returns description fields alongside every listing —
    no separate per-job fetch is required.
    """
    url = f"{LEVER_BASE_URL}/{slug}?mode=json"
    resp = await _get_with_retry(client, url, label=f"listing/{slug}", rate_limiter=rate_limiter)
    data = resp.json()

    # Lever returns a JSON array directly
    if not isinstance(data, list):
        logger.warning("[Lever] '{}' — unexpected response shape: {}", slug, type(data).__name__)
        return []

    return data


# ─── Scan Orchestrator ────────────────────────────────────────────────────────

async def run_lever_scan(
    portals: list[dict],
    skip_ids: set[str],
    pipeline_fn: Callable,
    org_cooldown: float = ORG_COOLDOWN,
    task_tracker: Optional[Callable] = None,
) -> dict:
    """
    Orchestrates a full Lever scrape across multiple portals.

    Because the Lever listing API returns descriptions in the same call,
    there is no Phase 2 (no separate description fetches). Each org's
    postings are mapped and sent to the pipeline immediately after listing.

    Flow:
      1. Deduplicate portals by slug.
      2. Fire all listing queries in parallel (semaphore-limited).
      3. Filter new/title-passing postings, map to JOBVIS schema.
      4. Fire pipeline per org as a background task.
      5. Wait for all pipeline tasks before returning.

    Args:
        portals:      List of {slug, name} dicts.
        skip_ids:     source_ids already in DB.
        pipeline_fn:  async (jobs, slug) -> dict
        org_cooldown: Base seconds between pipeline dispatches (minimal — no desc fetches).
        task_tracker: Optional fn(task) -> task for shutdown tracking.
    """
    # ── Deduplicate ───────────────────────────────────────────────────────────
    seen: set[str] = set()
    unique: list[dict] = []
    for p in portals:
        if p["slug"] not in seen:
            seen.add(p["slug"])
            unique.append(p)
    if len(unique) < len(portals):
        logger.info("[Lever] Deduplicated {} → {} unique orgs", len(portals), len(unique))
    portals = unique

    logger.info("[Lever] Starting scan — {} org(s): {}", len(portals), [p['slug'] for p in portals])

    # ── Shared client + rate limiter for all listing requests in this scan ────
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
                    logger.info("[Lever] '{}' — {} postings found", slug, len(postings))
                    return portal, postings
                except Exception as e:
                    logger.warning("[Lever] Listing failed for '{}': {}: {}", slug, type(e).__name__, e)
                    failed_orgs.append(slug)
                    return portal, []

        logger.info("[Lever] Phase 1 — fetching listings for all {} orgs in parallel...", len(portals))
        listing_results: list[tuple[dict, list[dict]]] = await asyncio.gather(
            *[_fetch_listing(p) for p in portals]
        )

        # ── Filter, title-pre-filter, and map new postings ────────────────────
        # Descriptions are already in the listing — map directly, no Phase 2.
        orgs_with_new: list[tuple[dict, list[dict]]] = []
        for portal, postings in listing_results:
            new = [p for p in postings if p.get("id") not in skip_ids]
            if new:
                title_ok = [
                    p for p in new
                    if _pipeline.apply_preliminary_filters({"title": p.get("text", "")})[0] == "ACTIVE"
                ]
                title_dropped = len(new) - len(title_ok)
                if title_dropped:
                    logger.info("[Lever] '{}' — {} filtered by title", portal['slug'], title_dropped)
                if title_ok:
                    orgs_with_new.append((portal, title_ok))
                    continue
            skipped = len(postings) - len(new)
            msg = f"{skipped} already in DB" if skipped else "no postings"
            logger.info("[Lever] '{}' → no new jobs ({}), skipping", portal['slug'], msg)

        if failed_orgs:
            logger.warning("[Lever] Phase 1 FAILURES ({}/{}): {}", len(failed_orgs), len(portals), failed_orgs)
        logger.info("[Lever] Phase 1 complete — {}/{} orgs have new jobs", len(orgs_with_new), len(portals))

        if not orgs_with_new:
            return {
                "message":        "No new Lever jobs found.",
                "total_processed": 0,
                "failed_orgs":     failed_orgs,
            }

        # ── Phase 2: Map + pipeline (no description fetches needed) ──────────
        # Descriptions are already present from Phase 1; just map and fire.
        pipeline_tasks: list[asyncio.Task] = []

        logger.info("[Lever] Phase 2 — mapping postings and firing pipeline per org...")
        for idx, (portal, new_postings) in enumerate(orgs_with_new):
            slug     = portal["slug"]
            org_name = portal["name"]

            jobs = [_map_posting(p, slug, org_name) for p in new_postings]
            logger.info("[Lever] '{}' — {} new jobs → pipeline", slug, len(jobs))

            task = asyncio.create_task(pipeline_fn(jobs, slug))
            if task_tracker:
                task_tracker(task)
            pipeline_tasks.append(task)

            # Brief cooldown between orgs to avoid burst-firing the pipeline
            if idx < len(orgs_with_new) - 1:
                await asyncio.sleep(_jitter(org_cooldown))

    # ── Phase 3: Await all pipeline tasks ────────────────────────────────────
    logger.info("[Lever] Waiting for {} pipeline task(s) to complete...", len(pipeline_tasks))
    results = await asyncio.gather(*pipeline_tasks, return_exceptions=True)

    dicts  = [r for r in results if isinstance(r, dict)]
    errors = [str(r) for r in results if isinstance(r, Exception)]
    if errors:
        logger.warning("[Lever] {} pipeline error(s): {}", len(errors), errors)

    total_processed = sum(r.get("total_processed", 0) for r in dicts)
    total_scanned   = sum(r.get("total_scanned",   0) for r in dicts)
    total_saved     = sum(r.get("total_saved",     0) for r in dicts)
    total_ignored   = sum(r.get("total_ignored",   0) for r in dicts)

    if failed_orgs:
        logger.warning("[Lever] Scan finished with {} failed org(s): {}", len(failed_orgs), failed_orgs)
    logger.info("[Lever] Scan complete — {} orgs checked, {} new jobs processed", len(portals), total_processed)
    return {
        "message":         f"Lever scan complete — {len(portals)} orgs, {total_processed} jobs processed",
        "total_processed": total_processed,
        "total_scanned":   total_scanned,
        "total_saved":     total_saved,
        "total_ignored":   total_ignored,
        "failed_orgs":     failed_orgs,
    }
