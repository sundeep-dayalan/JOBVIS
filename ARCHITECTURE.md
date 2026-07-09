# JOBVIS Architecture & Deep Functional Flow

JOBVIS is a high-performance, locally-orchestrated AI job intelligence platform. It transforms noisy, uncurated job feeds — from LinkedIn *and* company applicant-tracking systems (Ashby, Greenhouse, Lever) — into a hyper-targeted, AI-scored local database. Ingestion happens two ways: a **Chrome extension** that rides on top of LinkedIn, and **server-side scrapers** that pull directly from public ATS APIs on a schedule. Everything is filtered, deduplicated, LLM-scored against your CV, and surfaced through a React command center.

---

## 1. Monorepo Structure

The project is a Monorepo separating concerns into distinct applications that communicate via secure internal APIs, plus a shared `config/` directory that is the single source of truth for all tunable behavior.

* **`apps/extension` (The Injector):** A Chrome MV3 extension that operates on top of LinkedIn. It scrapes the DOM and intercepts raw job payload JSONs directly from the browser, normalizes them to the internal schema, and ships them to the local Python backend via `/api/deepscan`. It also runs an **auto-scrape loop** (via `chrome.alarms`) that cycles through the LinkedIn search URLs defined in `config/portals.yml`, POSTs a **heartbeat** to the server every 30s, and listens for `trigger_now` commands so the UI can drive it remotely.
* **`apps/server` (The Brain):** A Python FastAPI server backed by PostgreSQL and SQLAlchemy. This is the source of truth for the entire system. It orchestrates the asynchronous multi-provider AI inference engine, hosts the **server-side ATS scrapers** (Ashby/Greenhouse/Lever), runs a **custom asyncio scheduler** for automated background ingestion, manages the deduplication + filtering pipeline, and drives real-time system state to the UI via WebSockets.
* **`apps/ui` (The Command Center):** A React/Vite/TypeScript web application. It provides an aggressively curated list of evaluated jobs (`Home`), a live scan console (`DeepScan`), a scan-history browser (`History`), and a control panel (`Settings`) for toggles, schedules, and portal management. It talks to the backend via REST for fetches/mutations and WebSockets for live progress tracking.
* **`config/` (The Control Plane):** All runtime behavior is externalized here — CV, keyword filters, LLM provider selection, tracked portals, and per-environment settings. See §7.

Supporting files at the repo root: `docker-compose.yml` (PostgreSQL + Adminer), `start.sh` (env-aware launcher), `README.md`.

### Dev / Prod split
`start.sh` accepts a `--prod` flag and everything keys off the `APP_ENV` variable so dev and prod can run **simultaneously without colliding**:

| | Server port | UI port | Database | Settings file | Extension name |
|---|---|---|---|---|---|
| **dev**  | `8000` | `5173` | `jobvisdb_dev`  | `config/settings.dev.yml`  | `JOBVIS - (DEV)` |
| **prod** | `8001` | `1997` | `jobvisdb_prod` | `config/settings.prod.yml` | `JOBVIS - (PROD)` |

`start.sh` regenerates `apps/extension/config.js` (API/WS base URL + env) and stamps the extension `manifest.json` name on every launch, then brings up Postgres via `docker compose up -d`. The database is auto-created on startup if it doesn't exist (`database.ensure_database_exists`), and lightweight `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations backfill `activity_log` and `updated_at` on existing DBs.

---

## 2. Deep Functional Flows

There are **three ingestion paths** (LinkedIn Deep Scan, Server-Side ATS Scan, Manual Re-Scan), all of which converge on the **same core pipeline** (`execute_job_pipeline` in `main.py`).

### A. The "Deep Scan" (LinkedIn — Browser-Driven Ingest)
Triggered by the Chrome extension traversing jobs on LinkedIn (manually or via the auto-scrape alarm).

1. **Ingest & Mapping:** The payload arrives at `/api/deepscan`. It accepts multiple shapes (`[job, ...]`, `{"jobs": [...]}`, or `{"linkedinScrapeData": [...]}`). Each raw job is passed through `linkedinDataMapper` (`mappers.py`). As of extension v2 the extension already emits standardized keys, so the mapper is a thin passthrough whose main job is to snapshot the original payload immutably into a `raw_data` property.
2. **Core pipeline:** The mapped jobs are handed to `execute_job_pipeline(..., force_rescan=False, scan_source="linkedin")`. See §3 for the shared logic.

### B. The "Server-Side ATS Scan" (Ashby / Greenhouse / Lever)
Triggered either by the scheduler (§4) or on demand via `POST /api/scrape/{ashby|greenhouse|lever}` (optionally with a specific `slug`). Each source has a dedicated scraper module under `apps/server/scrapers/`, but they share a common shape:

1. **Portal resolution:** `_load_portals(source=...)` reads `tracked_companies` from `config/portals.yml`. With no slug, all **enabled** portals for that source are scanned; with a slug, just that one.
2. **DB dedup set:** All existing `source_id`s for that source are loaded from Postgres into a `skip_ids` set up front.
3. **Shared ScanSession:** One `ScanSession` row is created for the whole run so every org/board in the batch rolls up into a single history entry.
4. **Phase 1 — Parallel listing:** All org/board listing queries fire concurrently (semaphore-limited to `LISTING_CONCURRENCY = 3`), paced by a shared **token-bucket rate limiter** (`GLOBAL_RATE_RPS = 2.0`, burst 4) with exponential backoff + jitter and `Retry-After` handling on 429s. A 429 anywhere drains the shared bucket (`backpressure`) so *all* concurrent requests slow down together, preventing synchronized retry storms.
5. **Title pre-filter:** Before any expensive description fetch, listings are run through `apply_preliminary_filters({"title": ...})` — jobs whose titles will be IGNORED anyway never trigger a description request (saves bandwidth and rate-limit budget).
6. **Phase 2 — Descriptions (adaptive):** For sources that need them, descriptions are fetched sequentially per org in **adaptive batches** (start size 2, ramp to 5 after 3 clean batches, drop back to 2 on any throttle), with jittered cooldowns between batches and between orgs. HTML descriptions are tag-stripped into readable plain text.
7. **Per-org pipeline dispatch:** As soon as an org's jobs are mapped, they're fired into `execute_job_pipeline(..., scan_source=<source>, session_id=<shared>)` as a background task. Phase 3 awaits all pipeline tasks and aggregates totals back onto the shared `ScanSession`.

**Source-specific notes:**
* **Ashby** (`ashby.py`) — public GraphQL API (`jobs.ashbyhq.com/api/non-user-graphql`). Two queries: full listing, then per-posting `descriptionHtml`. Description fetch is gated by `pipeline.ashby_description_fetch_enabled`; when off, descriptions are `null`. Exposes `refetch_descriptions()` used by Re-Scan to backfill missing descriptions.
* **Greenhouse** (`greenhouse.py`) — public REST API (`boards-api.greenhouse.io/v1/boards/{token}/jobs[/{id}]`). Same two-phase pattern; gated by `pipeline.greenhouse_description_fetch_enabled`.
* **Lever** (`lever.py`) — public REST API (`api.lever.co/v0/postings/{slug}?mode=json`). **Single-phase**: the listing call returns full descriptions inline, so there is no separate description-fetch phase and no fetch toggle. Prefers plain-text description fields, falls back to stripping HTML.

### C. The "Re-Scan Strategy" (Manual UI Override)
Triggered explicitly by the user clicking **RE-SCAN** in the React UI. *Used when you've modified your Resume (`cv.md`), your Keyword Filters (`filter.yml`), or the LLM Prompt (`JobMatchAnalyst.md`) and want to apply those changes retroactively to existing jobs.*

1. **Hydration from source:** The UI passes target IDs (or the literal `"all"`) to `/api/rescan`. The backend loads the matching rows and re-maps each one from its immutable `raw_data` JSON via `linkedinDataMapper`.
2. **Ashby description backfill:** If `pipeline.ashby_description_fetch_enabled` is on, Ashby jobs that were ingested without descriptions are re-fetched (`refetch_descriptions`) so the upsert persists fresh text.
3. **Pipeline re-entry with `force_rescan=True`:** The payloads re-enter the exact same pipeline, but the cache shield is deliberately overridden — existing rows are treated as **upserts** rather than cache hits.
4. **Re-evaluation:** Jobs run against your **new** filters and, if they pass, your **new** AI prompt.
5. **Total row refresh:** A sweeping SQLAlchemy `.update({...})` overwrites each row with the fresh mapped payload and new score/status. On a rescan the existing `activity_log` is preserved as-is (no new history spam). The React UI intercepts the response and re-fetches, shifting jobs between `IGNORED` and `ACTIVE` live.

---

## 3. The Core Pipeline (Filter → Deduplicate → Score → Persist)

All three ingestion paths call `execute_job_pipeline(jobs, db, force_rescan, scan_source, session_id)`. Settings are re-read on **every** run so UI toggles take effect immediately with no restart.

### 3.1 Deduplication & preliminary filtering — `JobPipeline.filter_and_deduplicate`
`pipeline/pipeline.py` runs an N+1-optimized dedup:

1. **Bulk existence query (O(1)):** All `source_id`s in the batch are looked up in one query, **scoped by `source`**, building a `{source_id: status}` map.
2. **Preliminary filters** run on every job (`apply_preliminary_filters`), in order — first IGNORED wins:
   * **Title filter** (`preprocessors/title_filter.py`) — `include_any` must match (if configured) and `exclude_any` must not.
   * **Location filter** (`preprocessors/location_filter.py`) — if a location allowlist is configured and the job has a location, at least one allowed term must appear. A *missing* location passes through (the LLM catches it later).
   * **JD keyword filter** (`preprocessors/jd_filter.py`) — `include_any` / `exclude_any` term matching plus regex `description_pattern_excludes` (e.g. hourly-rate/contractor markers). Skipped if the job has no description yet.
3. **The Cache Shield:** For a normal background scan (`force_rescan=False`), any job whose `source_id` already exists **in any status** is dropped (`skipped++`) — this categorically prevents infinite AI re-scoring loops as the extension browses. Only `force_rescan=True` bypasses this, routing existing rows into `upserts`.
4. **Bucketing:** New jobs → `inserts`; existing jobs under force-rescan → `upserts`. Any insert/upsert that survived preliminary filters as `ACTIVE` is added to `jobs_to_generate` (the LLM work list). New jobs killed by preliminary filters increment `ignored_count`.

### 3.2 AI scoring — `LLMEngine.evaluate_job_match`
If `pipeline.ai_scoring_enabled` is **off**, the LLM is skipped entirely and every surviving job is saved `ACTIVE` with no score. Otherwise:

1. **Prompt assembly:** The static system prompt is built once per run by injecting `config/cv.md` into `{{CV_CONTENT}}` of `prompts/JobMatchAnalyst.md` (kept static for prompt caching). Per job, the user prompt is `TITLE / JD / LOCATION`, where the JD is first run through the **boilerplate stripper** (§3.3).
2. **Concurrent evaluation:** Jobs are scored concurrently under an `asyncio.Semaphore(llm.concurrency)` — default 3 for cloud providers, 1 for local. Each call retries up to 3× with self-correction if the model returns invalid JSON.
3. **Scorecard:** `JobMatchAnalyst.md` instructs the model as a deterministic ATS engine: **Step 1** runs knockout gates **K1–K10** (experience range 3–5 yrs, clearance/citizenship, sponsorship refusal, location, non-full-time, role mismatch, scam/indirect posting, salary floor $150k, zero core-skill overlap, overqualification cap) — first trigger scores **0**. **Step 2** scores weighted dimensions (keyword ×4, YoE ×4, hard-reqs ×3, scope/title/industry ×2, impact/edu/semantic ×1) summing to a **0–100** integer. Output is strict JSON: `{_step_by_step_execution, decision_reference, reason, score}`.
4. **Threshold:** Score **< 75 → `IGNORED`** (with reason `AI Score N/100 < 75`); otherwise `ACTIVE`. If the LLM ultimately fails to return valid JSON, the job is kept `ACTIVE` with an error recorded in `ai_analysis` (fail-open — never silently dropped).

Live progress (`EVALUATING`/`PASSED`/`REJECTED`/timing stats) is streamed to the UI over the `/ws/deepscan` WebSocket throughout.

### 3.3 JD boilerplate stripper — `preprocessors/jd_stripper.py`
Before scoring, each JD is compressed by a **6-layer, safety-netted** stripper (`strip_jd`): normalize → remove verified-safe boilerplate (EEO/salary legalese, URLs, HTML) → score-based paragraph filtering → dedupe near-identical paragraphs → **always preserve knockout signals** (visa/clearance/remote/contract/etc.) → validate. If the stripped output fails validation (too short, over-cut, lost a knockout term, no signal-heavy paragraph), it **falls back to the normalized original** — it never returns corrupted text.

### 3.4 Persistence
Results are merged back onto the insert/upsert tuples by `source_id`, then written in one transaction:
* **Inserts** → new `JobPosition` rows with a fresh `activity_log` (`INGESTED` → `FILTER_PASSED`/`FILTER_IGNORED`/`AI_REJECTED` → `AI_EVALUATED`).
* **Upserts** → a batched sweeping `.update({...})`; existing activity logs are fetched in one query (no N+1) and preserved (rescans add no new entries).
A `ScanSession` is reused (shared batch) or created (LinkedIn/single-org), and a completion event is broadcast to the UI.

---

## 4. The Scheduler (Automated Background Ingest)

`scheduler.py` is a dependency-free **asyncio scheduler** running inside the FastAPI event loop (registered in the `startup` hook for `ashby`, `greenhouse`, `lever`). Design:

* **Sleep-first:** never fires immediately on startup.
* **Live interval:** `interval_fn()` re-reads `settings.{env}.yml` before every sleep, so changing an interval or toggling enable/disable in the UI takes effect on the **next cycle** with no restart. A disabled job polls every 30s waiting to be re-enabled.
* **Jitter:** ±60s on every interval so it doesn't look like a cron bot (never sleeps < 60s).
* **Run-now:** `trigger_now(name)` wakes a sleeping job early via an `asyncio.Event` and resets its timer afterward.
* **Resilience:** a single run's exception is logged but never kills the loop; all tasks are registered for clean cancellation on server shutdown.

Control surface: `GET /api/scheduler/status` (live task states + config) and `POST /api/scheduler/trigger/{job_name}`. If the scheduler is disabled, `trigger` fires the job once directly as a background task. `linkedin` is special-cased — it isn't server-scraped, so its trigger is routed to the extension via `/api/extension/trigger`.

---

## 5. The LLM Engine (Multi-Provider)

`llm_engine.py` abstracts inference across four providers, selected by the entry marked `active: true` (or the first entry) in `config/llm_config.yml`:

| Provider | Mode | Transport | Notes |
|---|---|---|---|
| **gemini** | cloud | `google-genai` SDK (streaming + `ThinkingConfig` MINIMAL) | Needs `GEMINI_API_KEY`; parses JSON from streamed text, self-corrects on bad JSON |
| **groq** | cloud | OpenAI-compatible REST | Needs `GROQ_API_KEY`; JSON mode; tenacity network retries |
| **mlx** | local | OpenAI-compatible REST (`mlx_lm.server`) | Apple-Silicon; native concurrency; handles truncation via `finish_reason` |
| **ollama** | local | `/api/chat` REST | `num_ctx`/`num_predict`/`keep_alive` tunables; model is preloaded on startup and released on shutdown |

On startup the server runs a **health check** against the active provider and **halts (`_exit(1)`) if it's down** — JOBVIS refuses to run without a working brain. `concurrency` (semaphore width) defaults to 3 cloud / 1 local and is overridable per provider in config.

---

## 6. The Central Source of Truth (Database Schema)

The PostgreSQL schema lives in `models.py`.

### `ScanSession` (`scans`)
One row per scan run. Columns: `id` (UUID), `created_at`, `total_jobs_scanned`, `total_jobs_saved`, `total_ignored`, `source_meta` (JSONB — which sources/orgs the run covered). Exposed via `GET /api/scans`; `DELETE /api/scans/{id}` cascades.

### `JobPosition` (`jobs`)
One row per job. Highlights:
* **State:** `status` ∈ `"ACTIVE"` (review), `"IGNORED"` (filtered out), `"APPLIED"` (manually marked). `ignore_reason` explains an IGNORED verdict.
* **Intelligence:** `ai_score` (Float 0–100) and `ai_analysis` (JSONB — the full scorecard).
* **Normalized fields:** `source`, `source_id` (both indexed), `title`, `company_name`, `description`, `source_url`, `apply_url`, `job_posted_at`, `job_updated_at`, `location`, `salary_info`.
* **`raw_data` (JSONB):** the most critical engineering column — the original immutable scrape snapshot. Regardless of a job's current state, the server can re-map `raw_data` and re-evaluate it as if freshly scraped (this is what powers Re-Scan). It protects the app from unexpected UI/pipeline mutations.
* **`activity_log` (JSONB, append-only):** a structured audit trail of `{timestamp, event, summary, detail}` entries (`INGESTED`, `FILTER_PASSED`, `AI_EVALUATED`, `STATUS_CHANGED`, `MANUAL_STATUS_CHANGE`, …).
* **Timestamps:** `created_at` (DB insert — drives UI date filtering) and `updated_at` (last change — drives sort order). `scan_id` FKs `scans.id` with `ON DELETE CASCADE`.

`GET /api/jobs` returns all jobs ordered by `updated_at DESC, created_at DESC, id ASC` (the final UUID tiebreaker guarantees deterministic ordering).

---

## 7. Configuration (`config/`)

| File | Purpose |
|---|---|
| `cv.md` | Your résumé, injected into the LLM system prompt as `{{CV_CONTENT}}`. |
| `filter.yml` | Preliminary filters: `title_filter` (include/exclude), `job_description_filter` (include/exclude + regex `description_pattern_excludes`), `location_filter` (allowlist), plus `linkedin-filter` / `experience_filter` hints. |
| `llm_config.yml` | `llm-providers` list; the `active` one drives `LLMEngine`. |
| `portals.yml` | `linkedin_search_urls` (cycled by the extension auto-scrape) and `tracked_companies` (per-source `{name, source, slug, enabled}` used by the server scrapers). |
| `profile.yml` | Candidate profile / narrative metadata (target roles, comp, location, visa status). |
| `settings.dev.yml` / `settings.prod.yml` | Per-environment runtime state: `pipeline` toggles (`ai_scoring_enabled`, `*_description_fetch_enabled`) and `scheduler` config (`enabled` + `interval_minutes` per source). Read live and writable via `PATCH /api/settings`. |

---

## 8. API Surface (`main.py`)

**Ingestion**
* `POST /api/deepscan` — LinkedIn payload ingest (extension).
* `POST /api/rescan` — re-map & re-evaluate existing jobs by ID (or `"all"`) with `force_rescan=True`.
* `POST /api/scrape/ashby` · `POST /api/scrape/greenhouse` · `POST /api/scrape/lever` — trigger a server-side ATS scan (optional `slug`).

**Jobs & scans**
* `GET /api/jobs` — all jobs, deterministically ordered.
* `PATCH /api/jobs/status` — bulk move jobs to `ACTIVE`/`IGNORED`/`APPLIED` (validates UUIDs, appends `MANUAL_STATUS_CHANGE`).
* `DELETE /api/jobs` — bulk hard-delete by ID.
* `GET /api/scans` · `DELETE /api/scans/{scan_id}` (cascades to its jobs).

**Settings, scheduler & portals**
* `GET /api/settings` · `PATCH /api/settings` · `GET /api/env`.
* `GET /api/scheduler/status` · `POST /api/scheduler/trigger/{job_name}`.
* `GET /api/portals` · `GET /api/portals/linkedin` · `PATCH /api/portals/linkedin` · `POST /api/portals/import` (bulk-append new tracked companies).

**Extension coordination**
* `POST /api/extension/heartbeat` (30s; returns queued commands) · `GET /api/extension/status` (marks disconnected after 60s) · `POST /api/extension/trigger` · `POST /api/extension/notify`.

**WebSockets**
* `/ws/deepscan` — live scan/eval progress to the UI.
* `/ws/extension-sync` — live extension status to the Settings page (tolerant of MV3 service-worker churn).

---

## 9. Request Lifecycle at a Glance

```
                 ┌──────────────────────────┐
   LinkedIn ───▶ │ Chrome Extension          │──▶ POST /api/deepscan ──┐
                 │ (DOM scrape + auto-alarm)  │                         │
                 └──────────────────────────┘                          │
                                                                       ▼
 Ashby/Greenhouse/Lever ──▶ Scheduler / /api/scrape/* ──▶ scrapers ──▶ execute_job_pipeline
                                                                       │
                          ┌────────────────────────────────────────────┤
                          ▼                                            ▼
                filter_and_deduplicate                       (force_rescan? upsert : insert)
              (bulk O(1) dedup + Cache Shield                          │
               + title/location/JD filters)                           ▼
                          │                              JD stripper ─▶ LLMEngine (K1–K10 + scoring)
                          ▼                                            │  score < 75 ⇒ IGNORED
                    jobs_to_generate ───────────────────────────────▶ │
                                                                       ▼
                                              PostgreSQL (jobs + scans, raw_data, activity_log)
                                                                       │
                                                                       ▼
                                        React UI  ◀── REST /api/jobs · WS /ws/deepscan
```

The immutable `raw_data` snapshot on every row is what makes the whole system re-entrant: at any time, from any state, the server can pull `raw_data`, re-map it, and re-evaluate the job against your latest CV, filters, and prompt as if it had just been scraped.
