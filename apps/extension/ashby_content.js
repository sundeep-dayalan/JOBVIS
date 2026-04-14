/* ============================================================
   JOBVIS Ashby Job Board Scraper — Content Script
   Injected into: https://jobs.ashbyhq.com/*

   Ashby embeds the entire job listing as window.__appData in
   the page's initial HTML — no DOM scraping or auth needed.

   Strategy:
     1. Read window.__appData to get org name + all job postings (with
        title, location, salary, dates, workplace type, etc.)
     2. Fetch each job's full description from Ashby's public API:
        POST https://api.ashbyhq.com/jobPostings.info
     3. Output standardized job objects (matching backend schema)
        and persist them into chrome.storage.local.
   ============================================================ */
'use strict';

const STORAGE_STATE_KEY = 'jobvis_state';
const STORAGE_JOBS_KEY  = 'jobvis_jobs';

// ─── In-memory state ─────────────────────────────────────────

let scrapeState = {
  isRunning: false,
  stopRequested: false,
  phase: 1,
  status: 'idle',
  currentPage: 1,
  totalIdsCollected: 0,
  totalToFetch: 0,
  totalScraped: 0,
  source: 'ashby',
  startedAt: null,
};

let scrapedJobs = [];

// ─── Utilities ───────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function saveProgress() {
  await chrome.storage.local.set({
    [STORAGE_STATE_KEY]: { ...scrapeState },
    [STORAGE_JOBS_KEY]: scrapedJobs,
  });
}

// ─── Overlay ─────────────────────────────────────────────────

const OVERLAY_ID = 'jobvis-overlay';

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div id="jobvis-overlay-inner">
      <div id="jobvis-header-row">
        <span id="jobvis-logo">JOBVIS</span>
        <span id="jobvis-phase-badge" class="ashby">ASHBY</span>
      </div>
      <div id="jobvis-status-text">Starting…</div>
      <div id="jobvis-progress-line">
        <span id="jobvis-ids-info">0 jobs</span>
        <span id="jobvis-total-info">0 fetched</span>
      </div>
      <div id="jobvis-bar-wrap"><div id="jobvis-bar-fill"></div></div>
      <button id="jobvis-stop-btn">Stop Scraping</button>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'jobvis-overlay-style';
  style.textContent = `
    #jobvis-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(10, 10, 26, 0.85); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center;
      pointer-events: all; user-select: none;
    }
    #jobvis-overlay-inner {
      background: #12122a; border: 1px solid #1e2a4a; border-radius: 14px;
      padding: 32px 40px; min-width: 360px; text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    }
    #jobvis-header-row { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 16px; }
    #jobvis-logo { font-size: 18px; font-weight: 900; letter-spacing: 4px; color: #6c63ff; }
    #jobvis-phase-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #fff;
      background: #6c63ff; border-radius: 20px; padding: 3px 10px;
    }
    #jobvis-phase-badge.ashby { background: #6c63ff; }
    #jobvis-status-text { font-size: 15px; font-weight: 600; color: #d0d0f0; margin-bottom: 14px; }
    #jobvis-progress-line { display: flex; justify-content: center; gap: 18px; font-size: 12px; color: #7070a0; margin-bottom: 14px; }
    #jobvis-progress-line span { background: #1a1a38; padding: 4px 10px; border-radius: 20px; }
    #jobvis-total-info { color: #a78bfa !important; font-weight: 700; }
    #jobvis-bar-wrap { height: 4px; background: #1a1a38; border-radius: 2px; overflow: hidden; margin-bottom: 20px; }
    #jobvis-bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #6c63ff, #a78bfa); border-radius: 2px; transition: width 0.4s ease; }
    #jobvis-stop-btn { background: transparent; border: 1px solid #b52d2d; color: #ef5350; padding: 8px 28px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    #jobvis-stop-btn:hover { background: rgba(181,45,45,0.15); }
    #jobvis-stop-btn:disabled { opacity: 0.45; cursor: default; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  document.getElementById('jobvis-stop-btn').addEventListener('click', () => {
    scrapeState.stopRequested = true;
    document.getElementById('jobvis-status-text').textContent = 'Stopping…';
    document.getElementById('jobvis-stop-btn').disabled = true;
  });
}

function updateOverlay() {
  const statusEl = document.getElementById('jobvis-status-text');
  const idsEl    = document.getElementById('jobvis-ids-info');
  const totalEl  = document.getElementById('jobvis-total-info');
  const barEl    = document.getElementById('jobvis-bar-fill');
  if (!statusEl) return;

  statusEl.textContent = scrapeState.stopRequested
    ? 'Stopping…'
    : `Fetching descriptions — ${scrapeState.totalScraped} of ${scrapeState.totalToFetch}`;

  idsEl.textContent   = `${scrapeState.totalIdsCollected} jobs found`;
  totalEl.textContent = `${scrapeState.totalScraped} fetched`;

  if (barEl && scrapeState.totalToFetch) {
    const pct = Math.round((scrapeState.totalScraped / scrapeState.totalToFetch) * 100);
    barEl.style.width = pct + '%';
  }
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById('jobvis-overlay-style')?.remove();
}

// ─── Read __appData ───────────────────────────────────────────

/**
 * Reads the Ashby window.__appData from the page's existing inline script tag.
 * Ashby injects it as:  window.__appData = { ...huge JSON... };\nfetch(...)...
 *
 * Content scripts can read script.textContent freely (DOM read, no execution,
 * no CSP issues). We use a balanced brace counter to extract ONLY the JSON
 * object — stopping at its matching closing brace, ignoring the fetch() code
 * that follows in the same script tag.
 */
function readAppData() {
  try {
    const MARKER = 'window.__appData = ';

    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      if (!text || !text.includes(MARKER)) continue;

      // Start right at the opening '{'
      const startIdx = text.indexOf(MARKER) + MARKER.length;
      const rest = text.slice(startIdx).trimStart();

      if (!rest.startsWith('{')) continue; // sanity check

      // Walk the string with a balanced brace counter so we stop
      // exactly at the end of the JSON object, ignoring trailing code.
      let depth    = 0;
      let inString = false;
      let escaped  = false;
      let endIdx   = 0;

      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (escaped)            { escaped = false; continue; }
        if (c === '\\' && inString) { escaped = true; continue; }
        if (c === '"')          { inString = !inString; continue; }
        if (inString)           { continue; }
        if (c === '{')          { depth++; }
        else if (c === '}')     { depth--; if (depth === 0) { endIdx = i + 1; break; } }
      }

      if (!endIdx) {
        console.warn('[JOBVIS/Ashby] Could not find end of __appData JSON object.');
        continue;
      }

      const data = JSON.parse(rest.slice(0, endIdx));
      return {
        orgName:     data.organization?.name               || null,
        orgSlug:     data.organization?.hostedJobsPageSlug || null,
        jobPostings: data.jobBoard?.jobPostings            || [],
      };
    }

    console.warn('[JOBVIS/Ashby] window.__appData script tag not found in DOM.');
    return null;
  } catch (e) {
    console.error('[JOBVIS/Ashby] Failed to parse __appData:', e);
    return null;
  }
}


// ─── Ashby Public GraphQL — fetch job description ────────────

const ASHBY_GRAPHQL_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardJobPosting';
const DESCRIPTION_QUERY = `
  query ApiJobBoardJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
    jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
      id
      descriptionHtml
    }
  }
`.trim();

/**
 * Fetches the full job description via Ashby's public job board GraphQL API.
 * This is the same endpoint the Ashby board UI uses — no auth required.
 * Returns plain-text description (HTML tags stripped), or null on failure.
 */
async function fetchAshbyDescription(jobPostingId, orgSlug) {
  try {
    const resp = await fetch(ASHBY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://jobs.ashbyhq.com',
      },
      body: JSON.stringify({
        operationName: 'ApiJobBoardJobPosting',
        variables: {
          organizationHostedJobsPageName: orgSlug,
          jobPostingId,
        },
        query: DESCRIPTION_QUERY,
      }),
    });

    if (!resp.ok) {
      console.warn(`[JOBVIS/Ashby] GraphQL HTTP ${resp.status} for posting ${jobPostingId}`);
      return null;
    }

    const json = await resp.json();
    const html = json?.data?.jobPosting?.descriptionHtml;
    if (!html) return null;

    // Strip HTML tags to get plain text
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent?.trim() || null;
  } catch (e) {
    console.warn(`[JOBVIS/Ashby] Description fetch error for ${jobPostingId}:`, e.message);
    return null;
  }
}


// ─── Map a job posting to the standard schema ──────────────────

/**
 * Converts an Ashby jobPosting object (from __appData) into the
 * backend-standard job schema.
 */
function mapAshbyPosting(posting, orgName, orgSlug, description) {
  // Build the canonical job URL
  const source_url = `https://jobs.ashbyhq.com/${orgSlug}/${posting.id}`;

  // Normalize workplaceType
  const wtMap = { Remote: 'Remote', Hybrid: 'Hybrid', OnSite: 'On-site' };
  const workType = wtMap[posting.workplaceType] || posting.workplaceType || null;

  // Use compensationTierSummary as salary_info (e.g. "$190K – $230K • Offers Equity")
  const salary_info = posting.shouldDisplayCompensationOnJobBoard
    ? (posting.compensationTierSummary || null)
    : null;

  // Build location string — use locationName (e.g. "US Remote", "New York City")
  const location = posting.locationExternalName || posting.locationName || null;

  return {
    source:         'ashby',
    source_id:      posting.id,                        // UUID from Ashby
    source_url,
    apply_url:      source_url,                        // Ashby board IS the apply URL
    title:          posting.title?.trim() || null,
    company_name:   orgName || null,
    description:    description || null,
    location,
    workType,
    employmentType: posting.employmentType || null,    // "FullTime", "PartTime", etc.
    department:     posting.departmentName || null,
    team:           posting.teamName || null,
    salary_info,
    job_posted_at:  posting.publishedDate || null,     // "YYYY-MM-DD"
    job_updated_at: posting.updatedAt ? posting.updatedAt.slice(0, 10) : null,
    scrapedAt:      new Date().toISOString(),
  };
}

// ─── Main scraping orchestrator ───────────────────────────────

async function runScraping() {
  scrapeState.status    = 'running';
  scrapeState.isRunning = true;
  scrapeState.startedAt = new Date().toISOString();
  createOverlay();
  updateOverlay();
  await saveProgress();

  console.log('[JOBVIS/Ashby] Reading __appData…');

  // Step 1: Read the embedded data
  const appData = readAppData();
  if (!appData || !appData.jobPostings?.length) {
    console.error('[JOBVIS/Ashby] No job postings found in __appData. Are you on https://jobs.ashbyhq.com/<org>?');
    scrapeState.status    = 'error';
    scrapeState.isRunning = false;
    removeOverlay();
    await saveProgress();
    return;
  }

  const { orgName, orgSlug, jobPostings } = appData;
  scrapeState.totalIdsCollected = jobPostings.length;
  scrapeState.totalToFetch      = jobPostings.length;
  console.log(`[JOBVIS/Ashby] Found ${jobPostings.length} job postings for "${orgName}" (${orgSlug})`);
  updateOverlay();
  await saveProgress();

  // Step 2: Fetch descriptions in batches of 5
  const BATCH_SIZE  = 5;
  const BATCH_DELAY = 400; // ms between batches — polite to Ashby's API

  for (let i = 0; i < jobPostings.length; i += BATCH_SIZE) {
    if (scrapeState.stopRequested) break;

    const batch    = jobPostings.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(jobPostings.length / BATCH_SIZE);
    console.log(`[JOBVIS/Ashby] Batch ${batchNum}/${totalBatches} — fetching ${batch.length} descriptions`);

    const results = await Promise.allSettled(
      batch.map(async (posting) => {
        const description = await fetchAshbyDescription(posting.id, orgSlug);
        return mapAshbyPosting(posting, orgName, orgSlug, description);
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        scrapedJobs.push(result.value);
        scrapeState.totalScraped = scrapedJobs.length;
        const j = result.value;
        console.log(
          `[JOBVIS/Ashby] [${scrapeState.totalScraped}/${scrapeState.totalToFetch}]` +
          ` "${j.title}" @ ${j.company_name} | ${j.workType || '?'} | ${j.salary_info || 'no salary'}`
        );
      }
    }

    updateOverlay();
    await saveProgress();

    // Polite delay between batches (skip after the last one)
    if (i + BATCH_SIZE < jobPostings.length && !scrapeState.stopRequested) {
      await sleep(BATCH_DELAY);
    }
  }

  scrapeState.isRunning = false;
  scrapeState.status    = scrapeState.stopRequested ? 'stopped' : 'complete';
  await saveProgress();
  removeOverlay();
  console.log(`[JOBVIS/Ashby] Done. ${scrapedJobs.length} jobs scraped.`);
}

// ─── Message handler (popup → content) ───────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'start') {
    if (scrapeState.isRunning) {
      reply({ ok: false, reason: 'already_running' });
      return true;
    }

    // Reset state
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
      source: 'ashby',
      startedAt: new Date().toISOString(),
    };
    chrome.storage.local.set({ [STORAGE_JOBS_KEY]: [] });
    runScraping();
    reply({ ok: true });

  } else if (msg.action === 'stop') {
    scrapeState.stopRequested = true;
    const statusEl = document.getElementById('jobvis-status-text');
    if (statusEl) statusEl.textContent = 'Stopping after current batch…';
    const stopBtn = document.getElementById('jobvis-stop-btn');
    if (stopBtn) stopBtn.disabled = true;
    reply({ ok: true });

  } else if (msg.action === 'ping') {
    reply({ ok: true, isRunning: scrapeState.isRunning, source: 'ashby' });
  }

  return true;
});

console.log('[JOBVIS] Ashby content script ready');
