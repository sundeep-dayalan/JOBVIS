'use strict';

const STORAGE_STATE_KEY = 'jobvis_state';
const STORAGE_JOBS_KEY  = 'jobvis_jobs';

// ─── Source definitions ───────────────────────────────────────

const SOURCES = {
  linkedin: {
    name: 'LinkedIn',
    color: '#0a66c2',
    matchUrl: url => url?.includes('linkedin.com/jobs'),
    hasConfig: true,          // Show max-pages + delay config
    startMessage: 'Scraping started…',
    errorMessage: 'Navigate to a LinkedIn Jobs search page first.',
  },
  ashby: {
    name: 'Ashby',
    color: '#6c63ff',
    matchUrl: url => url?.includes('jobs.ashbyhq.com'),
    hasConfig: false,         // One-shot — no pagination config needed
    startMessage: 'Reading Ashby job board…',
    errorMessage: 'Navigate to an Ashby job board (jobs.ashbyhq.com/…) first.',
  },
};

// ─── Element references ───────────────────────────────────────
const startBtn       = document.getElementById('startBtn');
const stopBtn        = document.getElementById('stopBtn');
const downloadBtn    = document.getElementById('downloadBtn');
const copyBtn        = document.getElementById('copyBtn');
const clearBtn       = document.getElementById('clearBtn');
const statusBadge    = document.getElementById('statusBadge');
const phasePill      = document.getElementById('phasePill');
const stat1Label     = document.getElementById('stat1Label');
const stat1Value     = document.getElementById('stat1Value');
const stat2Label     = document.getElementById('stat2Label');
const stat2Value     = document.getElementById('stat2Value');
const totalScrapedEl = document.getElementById('totalScraped');
const progressFill   = document.getElementById('progressFill');
const messageEl      = document.getElementById('message');
const startedAtEl    = document.getElementById('startedAt');
const maxPagesInput  = document.getElementById('maxPages');
const delayInput     = document.getElementById('delay');
const sourceBar      = document.getElementById('sourceBar');
const sourceDot      = document.getElementById('sourceDot');
const sourceLabel    = document.getElementById('sourceLabel');
const configSection  = document.getElementById('configSection');

let pollInterval = null;
let currentJobs  = [];
let activeSource = null; // 'linkedin' | 'ashby' | null

// ─── Helpers ─────────────────────────────────────────────────

function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.style.color = isError ? '#ef5350' : '#4caf50';
  if (text) setTimeout(() => { if (messageEl.textContent === text) messageEl.textContent = ''; }, 4000);
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try { return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

async function getActiveTab() {
  return new Promise(resolve =>
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]))
  );
}

/** Detect which source the user is currently on */
function detectSource(url) {
  for (const [key, def] of Object.entries(SOURCES)) {
    if (def.matchUrl(url)) return key;
  }
  return null;
}

/** Apply source-specific styling to the popup */
function applySourceTheme(sourceKey) {
  const src = SOURCES[sourceKey];
  if (!src) {
    sourceDot.style.background = '#444466';
    sourceLabel.textContent = 'Navigate to a supported job board';
    configSection.style.display = 'none';
    startBtn.disabled = true;
    return;
  }

  sourceDot.style.background = src.color;
  sourceLabel.textContent = `${src.name} Job Board`;

  // Show config only for sources that need it (LinkedIn)
  configSection.style.display = src.hasConfig ? '' : 'none';

  // Tint the progress bar + start button color dynamically
  document.documentElement.style.setProperty('--source-color', src.color);
}

// ─── UI update ───────────────────────────────────────────────

function updateUI(state, jobs) {
  currentJobs = jobs || [];

  const status    = state?.status    || 'idle';
  const isRunning = state?.isRunning || false;
  const source    = state?.source    || activeSource;

  statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  statusBadge.className   = `status-badge ${status}`;
  startedAtEl.textContent = state?.startedAt ? `Started ${formatTime(state.startedAt)}` : '';

  // Phase pill — only for LinkedIn's two-phase scrape
  if (state && isRunning && source === 'linkedin') {
    phasePill.style.display = 'inline-block';
    if (state.phase === 2) {
      phasePill.textContent = 'PHASE 2';
      phasePill.className   = 'phase-pill phase2';
      stat1Label.textContent = 'To fetch';
      stat1Value.textContent = state.totalToFetch ?? '—';
      stat2Label.textContent = 'IDs found';
      stat2Value.textContent = state.totalIdsCollected ?? '—';
      const pct = state.totalToFetch
        ? Math.round((state.totalScraped / state.totalToFetch) * 100) : 0;
      progressFill.style.width = pct + '%';
    } else {
      phasePill.textContent = 'PHASE 1';
      phasePill.className   = 'phase-pill';
      stat1Label.textContent = 'Page';
      stat1Value.textContent = state.currentPage ?? '—';
      stat2Label.textContent = 'IDs found';
      stat2Value.textContent = state.totalIdsCollected ?? '—';
      progressFill.style.width = '0%';
    }
  } else if (state && isRunning && source === 'ashby') {
    phasePill.style.display = 'inline-block';
    phasePill.textContent   = 'ASHBY';
    phasePill.className     = 'phase-pill ashby';
    stat1Label.textContent  = 'Found';
    stat1Value.textContent  = state.totalIdsCollected ?? '—';
    stat2Label.textContent  = 'Fetching';
    stat2Value.textContent  = state.totalToFetch ?? '—';
    const pct = state.totalToFetch
      ? Math.round((state.totalScraped / state.totalToFetch) * 100) : 0;
    progressFill.style.width = pct + '%';
  } else {
    phasePill.style.display = 'none';
    stat1Label.textContent  = 'Page';
    stat1Value.textContent  = '—';
    stat2Label.textContent  = 'IDs found';
    stat2Value.textContent  = '—';
    if (!isRunning) progressFill.style.width = '0%';
  }

  if (state) totalScrapedEl.textContent = state.totalScraped ?? 0;

  startBtn.disabled   = isRunning || !activeSource;
  stopBtn.disabled    = !isRunning;
  maxPagesInput.disabled = isRunning;
  delayInput.disabled    = isRunning;

  const hasJobs = currentJobs.length > 0;
  downloadBtn.disabled = !hasJobs;
  copyBtn.disabled     = !hasJobs;

  if (!isRunning && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    if (status === 'complete') showMessage(`Done! ${currentJobs.length} jobs scraped.`);
    if (status === 'stopped')  showMessage(`Stopped. ${currentJobs.length} jobs saved.`);
  }
}

// ─── Polling ─────────────────────────────────────────────────

function pollStorage() {
  chrome.storage.local.get([STORAGE_STATE_KEY, STORAGE_JOBS_KEY], result => {
    updateUI(result[STORAGE_STATE_KEY], result[STORAGE_JOBS_KEY] || []);
  });
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollStorage, 900);
}

// ─── Event listeners ─────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  const sourceKey = detectSource(tab?.url);

  if (!sourceKey) {
    showMessage('Navigate to LinkedIn Jobs or an Ashby job board first.', true);
    return;
  }

  const src = SOURCES[sourceKey];

  const config = {
    maxPages: parseInt(maxPagesInput.value) || 1000,
    delay:    parseInt(delayInput.value)    || 1000,
  };

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'start', config });
    if (res?.ok) {
      startPolling();
      showMessage(src.startMessage);
    } else {
      showMessage(res?.reason || 'Could not start scraper.', true);
    }
  } catch {
    showMessage('Cannot connect. Reload the tab and try again.', true);
  }
});

stopBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'stop' });
    showMessage('Stopping after current job…');
  } catch {
    showMessage('Could not send stop signal.', true);
  }
});

downloadBtn.addEventListener('click', () => {
  if (!currentJobs.length) return;
  const json = JSON.stringify(currentJobs, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const source = currentJobs[0]?.source || 'jobs';
  a.href     = url;
  a.download = `${source}_jobs_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showMessage(`Downloaded ${currentJobs.length} jobs as JSON`);
});

copyBtn.addEventListener('click', async () => {
  if (!currentJobs.length) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentJobs, null, 2));
    showMessage(`Copied ${currentJobs.length} jobs to clipboard`);
  } catch {
    showMessage('Clipboard access denied.', true);
  }
});

clearBtn.addEventListener('click', async () => {
  if (currentJobs.length > 0) {
    const confirmed = confirm(`Clear all ${currentJobs.length} scraped jobs?`);
    if (!confirmed) return;
  }
  await chrome.storage.local.remove([STORAGE_STATE_KEY, STORAGE_JOBS_KEY]);
  updateUI(null, []);
  showMessage('Data cleared.');
});

// ─── Init ─────────────────────────────────────────────────────

async function init() {
  const tab = await getActiveTab();
  activeSource = detectSource(tab?.url);
  applySourceTheme(activeSource);

  chrome.storage.local.get([STORAGE_STATE_KEY, STORAGE_JOBS_KEY], result => {
    const state = result[STORAGE_STATE_KEY];
    const jobs  = result[STORAGE_JOBS_KEY] || [];
    updateUI(state, jobs);
    if (state?.isRunning) startPolling();
  });
}

init();
