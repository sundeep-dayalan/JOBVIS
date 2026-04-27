/* ============================================================
   JOBVIS LinkedIn Job Scraper — Content Script  (v2)
   Injected into: https://www.linkedin.com/jobs/*

   Two-phase approach:
     Phase 1 — DOM walk: collect job IDs + card-level metadata from
               every page WITHOUT clicking detail panels. Fast.
     Phase 2 — Voyager API: fetch full job details in parallel
               batches of 5, using LinkedIn's internal REST API.

   Selectors / API endpoints verified against live LinkedIn (April 2026).
   ============================================================ */
'use strict';

const STORAGE_STATE_KEY = 'jobvis_state';
const STORAGE_JOBS_KEY = 'jobvis_jobs';

// ─── In-memory state ─────────────────────────────────────────

let scrapeState = {
  isRunning: false,
  stopRequested: false,
  phase: 1,            // 1 = collecting IDs, 2 = fetching details
  status: 'idle',
  currentPage: 1,
  totalIdsCollected: 0,
  totalToFetch: 0,
  totalScraped: 0,
  maxPages: 1000,
  delay: 1000,
  batchSize: 5,
  startedAt: null,
};

// Map<jobId (string) → cardData (object)> — populated in Phase 1
let jobCardMap = new Map();
// Final array of merged job objects — populated in Phase 2
let scrapedJobs = [];

// ─── Overlay ─────────────────────────────────────────────────
// Shows a full-screen semi-transparent panel with phase badge,
// status text, progress stats, and a stop button.

const OVERLAY_ID = 'jobvis-overlay';

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div id="jobvis-overlay-inner">
      <div id="jobvis-header-row">
        <span id="jobvis-logo">JOBVIS</span>
        <span id="jobvis-phase-badge">PHASE 1</span>
      </div>
      <div id="jobvis-status-text">Starting…</div>
      <div id="jobvis-progress-line">
        <span id="jobvis-page-info">Page 1</span>
        <span id="jobvis-ids-info">0 IDs</span>
        <span id="jobvis-total-info">0 scraped</span>
      </div>
      <div id="jobvis-bar-wrap"><div id="jobvis-bar-fill"></div></div>
      <button id="jobvis-stop-btn">Stop Scraping</button>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'jobvis-overlay-style';
  style.textContent = `
    #jobvis-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(10, 10, 26, 0.82);
      backdrop-filter: blur(3px);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: all;
      user-select: none;
    }
    #jobvis-overlay-inner {
      background: #12122a;
      border: 1px solid #1e2a4a;
      border-radius: 14px;
      padding: 32px 40px;
      min-width: 360px;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    }
    #jobvis-header-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    #jobvis-logo {
      font-size: 18px;
      font-weight: 900;
      letter-spacing: 4px;
      color: #0a66c2;
    }
    #jobvis-phase-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #fff;
      background: #0a66c2;
      border-radius: 20px;
      padding: 3px 10px;
      transition: background 0.3s;
    }
    #jobvis-phase-badge.phase2 {
      background: #00897b;
    }
    #jobvis-status-text {
      font-size: 15px;
      font-weight: 600;
      color: #d0d0f0;
      margin-bottom: 14px;
    }
    #jobvis-progress-line {
      display: flex;
      justify-content: center;
      gap: 18px;
      font-size: 12px;
      color: #7070a0;
      margin-bottom: 14px;
    }
    #jobvis-progress-line span {
      background: #1a1a38;
      padding: 4px 10px;
      border-radius: 20px;
    }
    #jobvis-total-info { color: #29b6f6 !important; font-weight: 700; }
    #jobvis-bar-wrap {
      height: 4px;
      background: #1a1a38;
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    #jobvis-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #0a66c2, #29b6f6);
      border-radius: 2px;
      transition: width 0.4s ease;
    }
    #jobvis-bar-fill.phase2 {
      background: linear-gradient(90deg, #00897b, #4db6ac);
    }
    #jobvis-stop-btn {
      background: transparent;
      border: 1px solid #b52d2d;
      color: #ef5350;
      padding: 8px 28px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    #jobvis-stop-btn:hover { background: rgba(181,45,45,0.15); }
    #jobvis-stop-btn:disabled { opacity: 0.45; cursor: default; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  document.getElementById('jobvis-stop-btn').addEventListener('click', () => {
    scrapeState.stopRequested = true;
    document.getElementById('jobvis-status-text').textContent = 'Stopping after current operation…';
    document.getElementById('jobvis-stop-btn').disabled = true;
  });
}

function updateOverlay() {
  const s = scrapeState;
  const statusEl = document.getElementById('jobvis-status-text');
  const pageEl = document.getElementById('jobvis-page-info');
  const idsEl = document.getElementById('jobvis-ids-info');
  const totalEl = document.getElementById('jobvis-total-info');
  const barEl = document.getElementById('jobvis-bar-fill');
  const badgeEl = document.getElementById('jobvis-phase-badge');
  if (!statusEl) return;

  if (s.stopRequested) {
    statusEl.textContent = 'Stopping after current operation…';
  } else if (s.phase === 1) {
    statusEl.textContent = `Phase 1: Collecting job IDs — Page ${s.currentPage}`;
  } else {
    statusEl.textContent = `Phase 2: Fetching details — ${s.totalScraped} of ${s.totalToFetch}`;
  }

  pageEl.textContent = `Page ${s.currentPage}`;
  idsEl.textContent = `${s.totalIdsCollected} IDs`;
  totalEl.textContent = `${s.totalScraped} scraped`;

  if (badgeEl) {
    if (s.phase === 2) {
      badgeEl.textContent = 'PHASE 2';
      badgeEl.classList.add('phase2');
    } else {
      badgeEl.textContent = 'PHASE 1';
      badgeEl.classList.remove('phase2');
    }
  }

  // Progress bar: phase 1 shows indeterminate pulse; phase 2 shows real pct
  if (barEl) {
    if (s.phase === 2) {
      barEl.classList.add('phase2');
      const pct = s.totalToFetch ? Math.round((s.totalScraped / s.totalToFetch) * 100) : 0;
      barEl.style.width = pct + '%';
    } else {
      barEl.classList.remove('phase2');
      // Animate based on pages processed (indefinite feel)
      barEl.style.width = '0%';
    }
  }
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById('jobvis-overlay-style')?.remove();
}

// ─── Utilities ───────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** querySelector with multiple fallback selectors */
function qs(sels, ctx = document) {
  const arr = Array.isArray(sels) ? sels : [sels];
  for (const s of arr) {
    try { const e = ctx.querySelector(s); if (e) return e; } catch (_) { }
  }
  return null;
}

/** querySelectorAll with multiple fallback selectors */
function qsAll(sels, ctx = document) {
  const arr = Array.isArray(sels) ? sels : [sels];
  for (const s of arr) {
    try {
      const els = ctx.querySelectorAll(s);
      if (els.length) return [...els];
    } catch (_) { }
  }
  return [];
}

/** Wait for an element matching any of the given selectors */
function waitForEl(sels, timeout = 15000) {
  const arr = Array.isArray(sels) ? sels : [sels];
  return new Promise((resolve, reject) => {
    const found = qs(arr);
    if (found) { resolve(found); return; }
    let done = false;
    const ob = new MutationObserver(() => {
      const el = qs(arr);
      if (el && !done) { done = true; ob.disconnect(); resolve(el); }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      if (!done) { done = true; ob.disconnect(); reject(new Error('timeout')); }
    }, timeout);
  });
}

/** Persist current state and jobs array to chrome.storage.local */
async function saveProgress() {
  await chrome.storage.local.set({
    [STORAGE_STATE_KEY]: { ...scrapeState },
    [STORAGE_JOBS_KEY]: scrapedJobs,
  });
}

// ─── CSRF Token (via background service worker) ──────────────
// JSESSIONID is HttpOnly so document.cookie cannot see it.
// The background script reads it via chrome.cookies.get().
// We extract the numeric portion after "ajax:" as the CSRF token.

async function getCsrfToken() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getCookie', url: 'https://www.linkedin.com', name: 'JSESSIONID' },
      (response) => {
        if (chrome.runtime.lastError || !response?.value) {
          console.warn('[JOBVIS] Could not read JSESSIONID cookie:', chrome.runtime.lastError?.message);
          resolve(null);
          return;
        }
        // Cookie value format: "ajax:1234567890123456789"
        // The CSRF token is the part after "ajax:"
        const raw = response.value.replace(/^"(.*)"$/, '$1'); // strip surrounding quotes if any
        const token = raw.startsWith('ajax:') ? raw : `ajax:${raw}`;
        resolve(token);
      }
    );
  });
}

// ─── Phase 1 helpers ─────────────────────────────────────────

/** Get all job cards on the current page */
function getJobCards() {
  const cards = [...document.querySelectorAll('li[data-occludable-job-id]')];
  if (cards.length) return cards;
  // Fallback selectors
  return [...document.querySelectorAll(
    'li[data-job-id], .scaffold-layout__list-item, .jobs-search-results__list-item'
  )].filter(el => el.querySelector('a[href*="jobs"]'));
}

/** Extract job ID from a card element */
function getJobIdFromCard(card) {
  return card.dataset.occludableJobId || card.dataset.jobId || null;
}

/**
 * Extract card-level metadata WITHOUT clicking the card.
 * Selectors confirmed from live LinkedIn DOM (April 2026).
 *
 * Title:    a.job-card-list__title--link span[aria-hidden="true"] strong
 * Company:  .artdeco-entity-lockup__subtitle span (first span)
 * Loc+Type: .artdeco-entity-lockup__caption li span  → "Bellevue, WA (Hybrid)"
 * Benefits: .artdeco-entity-lockup__metadata li span
 */
function extractCardData(card) {
  const data = {};

  // Title
  const titleEl = qs(
    'a.job-card-list__title--link span[aria-hidden="true"] strong',
    card
  );
  data.title = titleEl?.textContent?.trim() || null;

  // Company — first span inside subtitle (ignore dynamic class names)
  const companyEl = qs('.artdeco-entity-lockup__subtitle span', card);
  data.company = companyEl?.textContent?.trim() || null;

  // Location + work type — caption items
  const captionSpans = qsAll('.artdeco-entity-lockup__caption li span', card);
  if (captionSpans.length) {
    const raw = captionSpans[0].textContent.trim();
    // Parse "(Hybrid)" / "(Remote)" / "(On-site)" suffix out of location
    const wtMatch = raw.match(/\((remote|hybrid|on[- ]?site)\)\s*$/i);
    if (wtMatch) {
      data.workType = wtMatch[1].charAt(0).toUpperCase() + wtMatch[1].slice(1).toLowerCase()
        .replace('on site', 'On-site').replace('onsite', 'On-site');
      data.location = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    } else {
      data.location = raw;
      data.workType = null;
    }
  }

  // Benefits / metadata spans (salary hints, etc.)
  const metaSpans = qsAll('.artdeco-entity-lockup__metadata li span', card);
  data.metadataTexts = metaSpans.map(s => s.textContent.trim()).filter(Boolean);

  // Salary hint from metadata
  data.salary = data.metadataTexts.find(t =>
    t.includes('$') || /k\/yr|\/hr|per hour|salary/i.test(t)
  ) || null;

  return data;
}

/** Scroll list container to trigger lazy-load of all cards on the current page */
async function revealAllCards() {
  const list = qs(['.jobs-search-results-list', '.scaffold-layout__list']);
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  await sleep(600);
  list.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(300);
}

/** Click the "Next" pagination button. Returns true if button existed & was clicked. */
async function goToNextPage() {
  const btn = qs([
    'button[aria-label="View next page"]',
    'button[aria-label*="next page" i]',
    '.artdeco-pagination__button--next:not([disabled])',
    '.jobs-search-pagination__button--next',
  ]);
  if (btn && !btn.disabled) {
    btn.scrollIntoView({ block: 'center' });
    await sleep(200);
    btn.click();
    return true;
  }
  return false;
}

/**
 * Wait for the job list to update after clicking Next.
 * Detects both URL change and presence of new card elements.
 */
async function waitForNewCards(prevUrl, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const urlChanged = window.location.href !== prevUrl;
    if (urlChanged && getJobCards().length > 0) {
      await sleep(600);
      return true;
    }
    await sleep(300);
  }
  return false;
}

// ─── Phase 1: Collect job IDs across all pages ───────────────

/**
 * Walk every search-results page, collect job IDs from card DOM attributes,
 * and scrape card-level metadata (no panel clicks needed).
 * Returns a Map<jobId → cardData>.
 */
async function phase1CollectIds() {
  console.log('[JOBVIS] Phase 1 starting — collecting job IDs from DOM');
  scrapeState.phase = 1;
  updateOverlay();

  // Wait for at least one job card to appear
  try {
    await waitForEl(['li[data-occludable-job-id]', 'li[data-job-id]'], 12000);
  } catch {
    throw new Error('No job cards found. Are you on a LinkedIn Jobs search page?');
  }

  while (!scrapeState.stopRequested && scrapeState.currentPage <= scrapeState.maxPages) {
    // Scroll to reveal any lazily-loaded cards
    await revealAllCards();
    const cards = getJobCards();
    console.log(`[JOBVIS] Phase 1 — Page ${scrapeState.currentPage}: ${cards.length} cards`);

    if (!cards.length) break;

    for (const card of cards) {
      const jobId = getJobIdFromCard(card);
      if (!jobId) continue;
      if (!jobCardMap.has(jobId)) {
        const cardData = extractCardData(card);
        jobCardMap.set(jobId, cardData);
      }
    }

    scrapeState.totalIdsCollected = jobCardMap.size;
    updateOverlay();
    await saveProgress();

    if (scrapeState.stopRequested) break;

    // Navigate to next page
    const prevUrl = window.location.href;
    const hasNext = await goToNextPage();
    if (!hasNext) {
      console.log('[JOBVIS] Phase 1 — No next page. All pages collected.');
      break;
    }

    const loaded = await waitForNewCards(prevUrl);
    if (!loaded) {
      console.log('[JOBVIS] Phase 1 — Next page did not load in time.');
      break;
    }

    scrapeState.currentPage++;
    updateOverlay();
    await saveProgress();
  }

  console.log(`[JOBVIS] Phase 1 complete. ${jobCardMap.size} unique job IDs collected.`);
  return jobCardMap;
}

// ─── Phase 2: Voyager API fetching ───────────────────────────

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api/jobs/jobPostings';

/**
 * Map Voyager workplaceTypes URN number (or plain string) to a human label.
 *   urn:li:fs_workplaceType:1 → On-site
 *   urn:li:fs_workplaceType:2 → Remote
 *   urn:li:fs_workplaceType:3 → Hybrid
 */
function resolveWorkType(data) {
  // Try workRemoteAllowed + workplaceTypes first
  const types = data.workplaceTypes;
  if (Array.isArray(types) && types.length) {
    const urn = types[0];
    const num = typeof urn === 'string'
      ? (urn.match(/:(\d+)$/) || [])[1]
      : String(urn);
    if (num === '2') return 'Remote';
    if (num === '3') return 'Hybrid';
    if (num === '1') return 'On-site';
    // Plain string fallbacks
    if (/remote/i.test(urn)) return 'Remote';
    if (/hybrid/i.test(urn)) return 'Hybrid';
    if (/on.?site/i.test(urn)) return 'On-site';
  }
  if (data.workRemoteAllowed === true) return 'Remote';
  return null;
}

/** Map Voyager employmentStatus string to a readable label */
function resolveEmploymentType(raw) {
  if (!raw) return null;
  const map = {
    FULL_TIME: 'Full-time',
    PART_TIME: 'Part-time',
    CONTRACT: 'Contract',
    TEMPORARY: 'Temporary',
    INTERNSHIP: 'Internship',
    VOLUNTEER: 'Volunteer',
    OTHER: 'Other',
  };
  return map[raw.toUpperCase()] || raw;
}

/**
 * Parse a single Voyager jobPostings API response into a job object.
 * The API returns normalized JSON with a "data" key and an "included" array
 * containing referenced entities (company, salary, etc.).
 */
function parseVoyagerResponse(json, jobId, cardData) {
  const data = json.data || {};
  const included = Array.isArray(json.included) ? json.included : [];

  const job = {
    source: 'linkedin',
    source_id: jobId,
    source_url: `https://www.linkedin.com/jobs/view/${jobId}/`,
  };

  // ── Title ──
  job.title = data.title || cardData?.title || null;

  // ── Description ──
  job.description = data.description?.text || null;

  // ── Company — resolve URN against included[] ──
  //   data.companyDetails.company = "urn:li:company:12345"
  const companyUrn = data.companyDetails?.company
    || data.companyDetails?.companyResolutionResult?.entityUrn
    || null;

  let companyEntity = null;
  if (companyUrn) {
    companyEntity = included.find(e =>
      e.entityUrn === companyUrn ||
      e['$id'] === companyUrn ||
      e.entityUrn?.endsWith(companyUrn.replace('urn:li:company:', ''))
    ) || null;
  }
  // Also search by companyPageUrl or universalName fallback
  if (!companyEntity) {
    companyEntity = included.find(e =>
      e.name && (e.universalName || e.companyPageUrl)
    ) || null;
  }

  job.company_name = companyEntity?.name || cardData?.company || null;
  job.companyUrl = companyEntity?.universalName
    ? `https://www.linkedin.com/company/${companyEntity.universalName}/`
    : null;

  // ── Location ──
  job.location = data.formattedLocation || cardData?.location || null;

  // ── Posted date ──
  if (data.listedAt) {
    const ms = Number(data.listedAt);
    job.postedTimestamp = ms;
    job.job_posted_at = new Date(ms).toISOString().slice(0, 10);
  } else {
    job.job_posted_at = null;
    job.postedTimestamp = null;
  }

  // ── Applicant count ──
  job.applicants = data.applies != null ? `${data.applies} applicants` : null;

  // ── Work type ──
  job.workType = resolveWorkType(data) || cardData?.workType || null;

  // ── Employment type ──
  job.employmentType = resolveEmploymentType(data.employmentStatus) || null;

  // ── Apply type & external URL ──
  const applyMethod = data.applyMethod;
  if (applyMethod) {
    const type = applyMethod.$type || applyMethod.type || '';
    job.applyType = type.includes('OffsiteApply') ? 'External Apply' : 'Easy Apply';
    job.apply_url = applyMethod.companyApplyUrl || null;
  } else {
    job.applyType = null;
    job.apply_url = null;
  }

  // Company was already resolved above

  // ── Salary ──
  // Try data.salary first, then scan included[] for salary insights
  if (data.salary) {
    const sal = data.salary;
    const min = sal.min ?? sal.salaryMin;
    const max = sal.max ?? sal.salaryMax;
    const currency = sal.currencyCode || 'USD';
    const period = sal.compensationPeriod || sal.period || '';
    if (min != null && max != null) {
      job.salary_info = `${currency} ${min}–${max}${period ? ' / ' + period : ''}`;
    } else {
      job.salary_info = sal.text || null;
    }
  } else {
    // Look in included[] for salary insight objects
    const salaryEntity = included.find(e =>
      e.$type?.toLowerCase().includes('salary') ||
      e.salaryInsight ||
      (e.salaryMin != null && e.salaryMax != null)
    );
    if (salaryEntity) {
      const min = salaryEntity.salaryMin ?? salaryEntity.min;
      const max = salaryEntity.salaryMax ?? salaryEntity.max;
      if (min != null && max != null) {
        job.salary_info = `${salaryEntity.currencyCode || 'USD'} ${min}–${max}`;
      } else {
        job.salary_info = salaryEntity.text || null;
      }
    } else {
      job.salary_info = cardData?.salary || null;
    }
  }

  // ── Skills ──
  job.skills = [];

  job.scrapedAt = new Date().toISOString();
  return job;
}

/**
 * Fetch details for a single job from the Voyager API.
 * Returns a parsed job object, or null on failure.
 *
 * @param {string} jobId
 * @param {object} cardData — card-level data from Phase 1 (used as fallback)
 * @param {string} csrfToken — value of JSESSIONID cookie (the full "ajax:XXX" string)
 */
async function fetchJobDetails(jobId, cardData, csrfToken) {
  const url = `${VOYAGER_BASE}/${jobId}`;
  const headers = {
    'csrf-token': csrfToken || '',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
  };

  let attempt = 0;
  while (attempt < 2) {
    attempt++;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include', // Send session cookies automatically
      });

      if (resp.status === 429) {
        console.warn(`[JOBVIS] 429 rate-limit for job ${jobId}. Waiting 5s…`);
        await sleep(5000);
        continue; // Retry once
      }

      if (!resp.ok) {
        console.warn(`[JOBVIS] HTTP ${resp.status} for job ${jobId} — skipping`);
        return null;
      }

      const json = await resp.json();
      return parseVoyagerResponse(json, jobId, cardData);

    } catch (err) {
      console.warn(`[JOBVIS] Fetch error for job ${jobId} (attempt ${attempt}):`, err.message);
      if (attempt < 2) await sleep(1000);
    }
  }
  return null;
}

/**
 * Run Phase 2: fetch all collected job IDs from the Voyager API in
 * batches of batchSize, with a delay between batches.
 */
async function phase2FetchDetails(csrfToken) {
  const jobIds = [...jobCardMap.keys()];
  scrapeState.phase = 2;
  scrapeState.totalToFetch = jobIds.length;
  scrapeState.totalScraped = 0;
  scrapeState.currentPage = 1; // Reset display field for phase 2
  updateOverlay();
  await saveProgress();

  console.log(`[JOBVIS] Phase 2 starting — fetching ${jobIds.length} jobs via Voyager API`);

  const batchSize = scrapeState.batchSize;

  for (let i = 0; i < jobIds.length; i += batchSize) {
    if (scrapeState.stopRequested) break;

    const batch = jobIds.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatch = Math.ceil(jobIds.length / batchSize);
    console.log(`[JOBVIS] Phase 2 — Batch ${batchNum}/${totalBatch} (${batch.length} jobs)`);

    // Fetch all jobs in the batch concurrently
    const promises = batch.map(jobId =>
      fetchJobDetails(jobId, jobCardMap.get(jobId), csrfToken)
    );
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        scrapedJobs.push(result.value);
        scrapeState.totalScraped = scrapedJobs.length;
        const j = result.value;
        console.log(
          `[JOBVIS] [${scrapeState.totalScraped}/${scrapeState.totalToFetch}]` +
          ` "${j.title}" @ ${j.company_name} | ${j.workType || '?'} | ${j.salary_info || 'no salary'}`
        );
      }
    }

    updateOverlay();
    await saveProgress();

    // Polite delay between batches (skip after last batch)
    if (i + batchSize < jobIds.length && !scrapeState.stopRequested) {
      await sleep(400);
    }
  }

  console.log(`[JOBVIS] Phase 2 complete. ${scrapedJobs.length} jobs fetched.`);
}

// ─── Main orchestrator ───────────────────────────────────────

async function runScraping() {
  scrapeState.status = 'running';
  createOverlay();
  updateOverlay();
  await saveProgress();

  try {
    // ── Phase 1: Collect IDs ──────────────────────────────
    await phase1CollectIds();

    if (jobCardMap.size === 0) {
      console.warn('[JOBVIS] No job IDs collected. Aborting.');
      scrapeState.status = 'error';
      scrapeState.isRunning = false;
      removeOverlay();
      await saveProgress();
      return;
    }

    if (scrapeState.stopRequested) {
      console.log('[JOBVIS] Stop requested after Phase 1.');
      scrapeState.status = 'stopped';
      scrapeState.isRunning = false;
      removeOverlay();
      await saveProgress();
      return;
    }

    // ── Obtain CSRF token before Phase 2 ─────────────────
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
      console.warn('[JOBVIS] No CSRF token obtained. Voyager API calls may fail (401).');
    } else {
      console.log('[JOBVIS] CSRF token obtained successfully.');
    }

    // ── Phase 2: Fetch details ────────────────────────────
    await phase2FetchDetails(csrfToken);

  } catch (err) {
    console.error('[JOBVIS] Fatal error during scraping:', err);
    scrapeState.status = 'error';
  }

  scrapeState.isRunning = false;
  scrapeState.status = scrapeState.stopRequested ? 'stopped' : 'complete';
  await saveProgress();
  removeOverlay();
  console.log(`[JOBVIS] Done. ${scrapedJobs.length} total jobs scraped.`);
}

// ─── Message handler (popup → content) ───────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'start') {
    if (scrapeState.isRunning) {
      reply({ ok: false, reason: 'already_running' });
      return true;
    }

    // Reset all state
    jobCardMap = new Map();
    scrapedJobs = [];
    scrapeState = {
      isRunning: true,
      stopRequested: false,
      phase: 1,
      status: 'starting',
      currentPage: 1,
      totalIdsCollected: 0,
      totalToFetch: 0,
      totalScraped: 0,
      maxPages: msg.config?.maxPages ?? 1000,
      delay: msg.config?.delay ?? 1000,
      batchSize: msg.config?.batchSize ?? 5,
      startedAt: new Date().toISOString(),
    };
    chrome.storage.local.set({ [STORAGE_JOBS_KEY]: [] });
    runScraping();
    reply({ ok: true });

  } else if (msg.action === 'stop') {
    scrapeState.stopRequested = true;
    const statusEl = document.getElementById('jobvis-status-text');
    if (statusEl) statusEl.textContent = 'Stopping after current operation…';
    const stopBtn = document.getElementById('jobvis-stop-btn');
    if (stopBtn) stopBtn.disabled = true;
    reply({ ok: true });

  } else if (msg.action === 'auto_overlay_update') {
    // Background.js is updating the reserved-tab overlay in auto-scrape mode
    _handleAutoOverlay(msg);
    reply({ ok: true });

  } else if (msg.action === 'ping') {
    reply({ ok: true, isRunning: scrapeState.isRunning });
  }

  return true; // Keep channel open for async replies
});

// ─── Auto-scrape reserved tab overlay ────────────────────────────────────────
// When this tab is reserved by the background scheduler, we show a permanent
// full-screen overlay that blocks user interaction and shows scraping status.

const AUTO_OVERLAY_ID    = 'jobvis-auto-overlay';
const AUTO_OVERLAY_STYLE = 'jobvis-auto-overlay-style';

function _ensureAutoOverlay() {
  if (document.getElementById(AUTO_OVERLAY_ID)) return;

  const style = document.createElement('style');
  style.id = AUTO_OVERLAY_STYLE;
  style.textContent = `
    #${AUTO_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(5, 5, 18, 0.94);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: all;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #jobvis-ao-box {
      background: #0e0e22;
      border: 1px solid #1e2a4a;
      border-radius: 16px;
      padding: 40px 50px;
      min-width: 400px;
      max-width: 520px;
      text-align: center;
      box-shadow: 0 32px 80px rgba(0,0,0,0.7);
    }
    #jobvis-ao-logo {
      font-size: 22px;
      font-weight: 900;
      letter-spacing: 5px;
      color: #0a66c2;
      margin-bottom: 6px;
    }
    #jobvis-ao-subtitle {
      font-size: 10px;
      letter-spacing: 2px;
      color: rgba(255,255,255,0.35);
      text-transform: uppercase;
      margin-bottom: 28px;
    }
    #jobvis-ao-status-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 2px;
      padding: 4px 14px;
      border-radius: 20px;
      margin-bottom: 18px;
      text-transform: uppercase;
      background: #1a1a38;
      color: #6666aa;
      transition: background 0.3s, color 0.3s;
    }
    #jobvis-ao-status-badge.scraping {
      background: rgba(10,102,194,0.2);
      color: #4fa3e8;
      animation: aoBadgePulse 1.5s ease-in-out infinite alternate;
    }
    #jobvis-ao-status-badge.error {
      background: rgba(181,45,45,0.2);
      color: #ef5350;
    }
    #jobvis-ao-status-badge.waiting {
      background: rgba(0,137,123,0.2);
      color: #4db6ac;
    }
    @keyframes aoBadgePulse {
      from { box-shadow: 0 0 0 rgba(10,102,194,0); }
      to   { box-shadow: 0 0 12px rgba(10,102,194,0.5); }
    }
    #jobvis-ao-main-text {
      font-size: 16px;
      font-weight: 600;
      color: #d0d0f0;
      margin-bottom: 10px;
      min-height: 24px;
    }
    #jobvis-ao-sub-text {
      font-size: 12px;
      color: #55558a;
      min-height: 18px;
      margin-bottom: 24px;
    }
    #jobvis-ao-bar-wrap {
      height: 3px;
      background: #1a1a38;
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    #jobvis-ao-bar-fill {
      height: 100%;
      width: 30%;
      background: linear-gradient(90deg, #0a66c2, #29b6f6);
      border-radius: 2px;
      animation: aoBarSlide 2s ease-in-out infinite alternate;
    }
    #jobvis-ao-bar-fill.static { animation: none; width: 0%; }
    @keyframes aoBarSlide {
      from { margin-left: 0%; }
      to   { margin-left: 70%; }
    }
    #jobvis-ao-warning {
      font-size: 10px;
      color: rgba(255,255,255,0.2);
      letter-spacing: 0.5px;
      border-top: 1px solid #1a1a38;
      padding-top: 16px;
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = AUTO_OVERLAY_ID;
  overlay.innerHTML = `
    <div id="jobvis-ao-box">
      <div id="jobvis-ao-logo">JOBVIS</div>
      <div id="jobvis-ao-subtitle">Automated Scraper · Reserved Tab</div>
      <div id="jobvis-ao-status-badge" class="scraping">⟳ Scraping</div>
      <div id="jobvis-ao-main-text">Initializing…</div>
      <div id="jobvis-ao-sub-text"></div>
      <div id="jobvis-ao-bar-wrap"><div id="jobvis-ao-bar-fill"></div></div>
      <div id="jobvis-ao-warning">
        This tab is reserved by JOBVIS Auto-Scraper.<br>
        Do not close or navigate away — scraping in progress.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function _updateAutoOverlayText(badge, badgeClass, mainText, subText, animate = true) {
  const badgeEl = document.getElementById('jobvis-ao-status-badge');
  const mainEl  = document.getElementById('jobvis-ao-main-text');
  const subEl   = document.getElementById('jobvis-ao-sub-text');
  const barEl   = document.getElementById('jobvis-ao-bar-fill');
  if (!badgeEl) return;
  badgeEl.textContent = badge;
  badgeEl.className   = badgeClass;
  mainEl.textContent  = mainText;
  subEl.textContent   = subText || '';
  if (barEl) barEl.className = animate ? 'jobvis-ao-bar-fill' : 'jobvis-ao-bar-fill static';
}

function _handleAutoOverlay(msg) {
  _ensureAutoOverlay();
  const mode = msg.mode;

  if (mode === 'auto_idle') {
    const next = msg.next_scrape_at ? new Date(msg.next_scrape_at).toLocaleTimeString() : 'scheduled';
    _updateAutoOverlayText(
      '◉ Idle',
      'jobvis-ao-status-badge',
      'Waiting for next scrape cycle',
      `Next run: ${next}`,
      false
    );
  } else if (mode === 'auto_scraping') {
    _updateAutoOverlayText(
      '⟳ Scraping',
      'jobvis-ao-status-badge scraping',
      `Collecting jobs from: ${msg.url_name || 'LinkedIn'}`,
      `Phase ${msg.phase || 1} — ${msg.count || 0} jobs found`,
      true
    );
  } else if (mode === 'auto_waiting') {
    _updateAutoOverlayText(
      '◌ Waiting',
      'jobvis-ao-status-badge waiting',
      'Scrape complete. Pausing before next URL…',
      `Next: ${msg.next || ''}`,
      false
    );
  } else if (mode === 'auto_error') {
    _updateAutoOverlayText(
      '✕ Error',
      'jobvis-ao-status-badge error',
      'Scrape failed — check your LinkedIn session',
      msg.error || 'Unknown error',
      false
    );
    // Tint the overlay box red to make error very visible
    const box = document.getElementById('jobvis-ao-box');
    if (box) box.style.borderColor = 'rgba(181,45,45,0.5)';
  }
}

console.log('[JOBVIS] Content script ready (v2 — two-phase Voyager API)');
