# JOBVIS Architecture & Deep Functional Flow

JOBVIS is a high-performance, locally-orchestrated AI job intelligence platform. It transforms noisy, uncurated LinkedIn job feeds into a hyper-targeted, AI-scored local database. 

## 1. Monorepo Structure

The project is structured as a modern Monorepo separating concerns into distinct applications that communicate via secure internal APIs.

* **`apps/extension` (The Injector):** A Chrome Extension that operates seamlessly on top of LinkedIn. It scrapes the DOM and intercepts raw job payload JSONs directly from the browser, shipping them silently to the local Python backend via `/api/deepscan`.
* **`apps/server` (The Brain):** A Python FastAPI server backed by PostgreSQL and SQLAlchemy. This is the source of truth for the entire system. It orchestrates the asynchronous AI inference engine (Gemini API via httpx), manages the complex deduplication pipeline, and drives real-time system state to the UI via WebSockets.
* **`apps/ui` (The Command Center):** A React/Vite web application that provides the user with an aggressively curated list of evaluated jobs. It communicates with the backend via REST for fetches/mutations and WebSockets for live progress tracking during heavy scans.

---

## 2. Deep Functional Flows

### A. The "Deep Scan" (Automated Background Ingest)
Triggered securely by the Chrome Extension traversing jobs on LinkedIn.

1. **Ingest & Mapping:** The payload arrives at `/api/deepscan`. The backend utilizes `linkedinDataMapper` (in `mappers.py`) to systematically normalize the raw, unpredictable LinkedIn JSON into a rigid internal dictionary. The original untampered LinkedIn JSON is preserved immutably inside a `raw_data` property.
2. **Bulk Deduplication (O(1)):** `pipeline.py` extracts all `source_id`s (e.g., LinkedIn Job IDs) and performs a single bulk query against Postgres to map existing historical states.
3. **The Cache Shield:** Because `Deep Scan` runs in the background continuously as you browse, `force_rescan` defaults to `False`. If a job exists in the database **in any capacity** (Active or Ignored), the pipeline completely destroys the payload, marking it `[Cache Hit]` and terminating execution. This categorically prevents infinite AI loops.
4. **Preliminary Keyword Filtering:** Brand new jobs are crossed against `config/filter.yml`. Negative keywords (like `intern`, `seniority mismatches`) result in an immediate downgrade to `status: "IGNORED"`, bypassing the LLM completely to save financial API tokens.
5. **AI Inference Layer:** Jobs that survive keyword checks are assembled concurrently and securely passed to the Gemini LLM utilizing the `job_description` and `config/cv.md`. The LLM scores the job matches `0-100`.
6. **Persistence:** Scores `< 50` are automatically cast to `IGNORED`. All data, including the immutable `raw_data` json block, is inserted natively into PostgreSQL via blazing-fast bulk `.add()` transactions.

### B. The "Re-Scan Strategy" (Manual UI Override)
Triggered explicitly by the user clicking the "RE-SCAN" buttons inside the React UI. 

*Used specifically when you have modified your underlying Resume (`cv.md`), modified your Keyword Filters (`filter.yml`), or manipulated the LLM Prompt Instructions (`JobMatchAnalyst.md`), and you wish to apply these rule changes retroactively against your existing jobs!*

1. **Hydration from Source:** The UI passes target IDs to `/api/rescan`. The backend extracts the original, immutable `raw_data` JSON previously parked silently in Postgres. 
2. **Pipeline Re-Entry:** The old job payloads are passed back into the exact identical pipeline flow, but this time passing `force_rescan=True`.
3. **Cache Annihilation:** The pipeline sees `force_rescan=True` and deliberately overrides all background cache rules. It treats the active Postgres data as an "Upsert".
4. **Re-Evaluation:** The job is run natively against your **new** keyword filters. If it passes, it is thrown into the **new** AI prompts. 
5. **Total Row Refresh:** The SQLAlchemy mutation query runs a sweeping `.update({...})` across the database table. Because the mapped payload is completely fresh, any changes you made securely overwrite the old row seamlessly. The React UI intercepts the successful network response and dynamically fires `fetchJobsData()` natively to shift jobs magically from `IGNORED` back to `ACTIVE` right before your eyes.

---

## 3. The Central Source of Truth (Database Schema)

The PostgreSQL Schema is localized inside `models.py`. 

* **State Tracking:** `status` cleanly isolates visual rendering into two definitive buckets: `"ACTIVE"` (Jobs to review) or `"IGNORED"` (Jobs filtered out).
* **`raw_data` (JSONB):** The most critical engineering column. By saving the original LinkedIn scrape data as a deep immutable JSONB representation natively in Postgres, the application protects itself from unexpected UI/Pipeline mutations. At any time, regardless of what state the job is in, the server can pluck `raw_data` from the DB and confidently re-evalute it as if the browser just freshly scraped it 2 seconds ago.
