import { useState, useEffect, useRef } from 'react'
import './Settings.css'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Portal {
  source: string
  slug: string
  name: string
  enabled: boolean
}

interface AppSettings {
  pipeline: {
    ai_scoring_enabled: boolean
    ashby_description_fetch_enabled: boolean
    greenhouse_description_fetch_enabled: boolean
  }
  scheduler: {
    ashby: {
      enabled: boolean
      interval_minutes: number
    }
    greenhouse: {
      enabled: boolean
      interval_minutes: number
    }
    lever: {
      enabled: boolean
      interval_minutes: number
    }
  }
}

// ─── Data definitions ─────────────────────────────────────────────────────────

interface FlowStep {
  id: string
  icon: string
  label: string
  sublabel: string
  description: string
  color: string
  details: string[]
  toggleKey?: keyof AppSettings['pipeline']
  toggleLabel?: string
  toggleWarning?: string
}

// ── Ashby-specific ingestion steps ────────────────────────────────────────────
const ASHBY_STEPS: FlowStep[] = [
  {
    id: 'ashby-portals',
    icon: '📋',
    label: 'PORTALS.YML',
    sublabel: 'Company registry',
    description: 'Server reads portals.yml to get the list of enabled Ashby org slugs (e.g. "pinecone"). Only companies with enabled: true (default) are targeted.',
    color: 'var(--step-ashby-1)',
    details: ['config/portals.yml', 'enabled: true filter', 'slug extraction'],
  },
  {
    id: 'ashby-listing',
    icon: '📡',
    label: 'PHASE 1 — LISTING',
    sublabel: 'Parallel GraphQL queries',
    description: 'All org listing queries fire concurrently (up to 5 in parallel) against Ashby\'s public GraphQL API. Returns job IDs + brief metadata. New org listings are collated in parallel — 25 orgs in ~2.5s vs 12.5s sequential.',
    color: 'var(--step-ashby-2)',
    details: ['ApiJobBoardWithTeams query', 'LISTING_CONCURRENCY = 5', 'asyncio.gather() all orgs', 'id · title · location · compensation'],
  },
  {
    id: 'ashby-dedup',
    icon: '⊘',
    label: 'DB SKIP CHECK',
    sublabel: 'Pre-description dedup',
    description: 'Before fetching expensive descriptions, the listing is crossed against all known Ashby source_ids in the DB. Already-known jobs are dropped at this point — no description fetch wasted.',
    color: 'var(--step-ashby-3)',
    details: ['DB query: existing Ashby source_ids', 'O(1) set lookup', 'Skips known job descriptions'],
  },
  {
    id: 'ashby-title',
    icon: '🔤',
    label: 'TITLE PRE-FILTER',
    sublabel: 'Early keyword discard',
    description: 'Title is checked against filter.yml include/exclude rules before fetching descriptions. Jobs guaranteed to be IGNORED are dropped here — saving one HTTP round-trip per job.',
    color: 'var(--step-ashby-4)',
    details: ['apply_preliminary_filters()', 'Reuses same filter.yml rules', 'No description fetch for IGNORED titles'],
  },
  {
    id: 'ashby-desc',
    icon: '📄',
    label: 'PHASE 2 — DESCRIPTIONS',
    sublabel: 'Adaptive batched fetch',
    description: 'Full descriptions are fetched one org at a time to respect rate limits, but within each org descriptions are fetched in adaptive batches. Batch size starts at 2, ramps up to 5 on success, drops back on any 429.',
    color: 'var(--step-ashby-5)',
    details: ['ApiJobBoardJobPosting query', 'Batch: min=2, max=5 (adaptive)', '±25% jitter on all delays', 'HTML → plain text strip', 'Exp. backoff on 429 / 5xx'],
    toggleKey: 'ashby_description_fetch_enabled' as keyof AppSettings['pipeline'],
    toggleLabel: 'Description Fetch',
    toggleWarning: 'When disabled, Phase 2 is skipped entirely. All Ashby jobs are ingested with description: null — no HTTP calls to Ashby are made per-job. The JD Filter and JD Stripper steps will have nothing to work with downstream.',
  },
  {
    id: 'ashby-map',
    icon: '🗺',
    label: 'SCHEMA MAPPER',
    sublabel: 'Normalize to JOBVIS format',
    description: 'Raw Ashby posting fields are mapped to the standard JOBVIS job schema before being handed off to the shared evaluation pipeline.',
    color: 'var(--step-ashby-6)',
    details: ['source: "ashby"', 'source_id · source_url · apply_url', 'workplaceType → Remote/Hybrid/On-site', 'compensationTierSummary → salary_info'],
  },
]

// ── Greenhouse-specific ingestion steps ───────────────────────────────────────
const GREENHOUSE_STEPS: FlowStep[] = [
  {
    id: 'gh-portals',
    icon: '📋',
    label: 'PORTALS.YML',
    sublabel: 'Board registry',
    description: 'Server reads portals.yml to get the list of enabled Greenhouse board tokens (e.g. "amplemarket"). Only companies with enabled: true (default) are targeted.',
    color: 'var(--step-gh-1)',
    details: ['config/portals.yml', 'enabled: true filter', 'slug extraction'],
  },
  {
    id: 'gh-listing',
    icon: '📡',
    label: 'PHASE 1 — LISTING',
    sublabel: 'Parallel REST queries',
    description: 'All board listing queries fire concurrently (up to 3 in parallel) against Greenhouse\'s public REST API. Returns job IDs + brief metadata.',
    color: 'var(--step-gh-2)',
    details: ['GET /v1/boards/{token}/jobs', 'LISTING_CONCURRENCY = 3', 'asyncio.gather() all boards', 'id · title · location · updated_at'],
  },
  {
    id: 'gh-dedup',
    icon: '⊘',
    label: 'DB SKIP CHECK',
    sublabel: 'Pre-description dedup',
    description: 'Before fetching expensive descriptions, the listing is crossed against all known Greenhouse source_ids in the DB. Already-known jobs are dropped — no description fetch wasted.',
    color: 'var(--step-gh-3)',
    details: ['DB query: existing Greenhouse source_ids', 'O(1) set lookup', 'Skips known job descriptions'],
  },
  {
    id: 'gh-title',
    icon: '🔤',
    label: 'TITLE PRE-FILTER',
    sublabel: 'Early keyword discard',
    description: 'Title is checked against filter.yml include/exclude rules before fetching descriptions. Jobs guaranteed to be IGNORED are dropped — saving one HTTP round-trip per job.',
    color: 'var(--step-gh-4)',
    details: ['apply_preliminary_filters()', 'Reuses same filter.yml rules', 'No description fetch for IGNORED titles'],
  },
  {
    id: 'gh-desc',
    icon: '📄',
    label: 'PHASE 2 — DESCRIPTIONS',
    sublabel: 'Adaptive batched fetch',
    description: 'Full descriptions are fetched one board at a time to respect rate limits, but within each board descriptions are fetched in adaptive batches. Batch size starts at 2, ramps up to 5 on success, drops back on any 429.',
    color: 'var(--step-gh-5)',
    details: ['GET /v1/boards/{token}/jobs/{id}', 'Batch: min=2, max=5 (adaptive)', '±25% jitter on all delays', 'HTML → plain text strip', 'Exp. backoff on 429 / 5xx'],
    toggleKey: 'greenhouse_description_fetch_enabled' as keyof AppSettings['pipeline'],
    toggleLabel: 'Description Fetch',
    toggleWarning: 'When disabled, Phase 2 is skipped entirely. All Greenhouse jobs are ingested with description: null — no HTTP calls are made per-job. The JD Filter and JD Stripper steps will have nothing to work with downstream.',
  },
  {
    id: 'gh-map',
    icon: '🗺',
    label: 'SCHEMA MAPPER',
    sublabel: 'Normalize to JOBVIS format',
    description: 'Raw Greenhouse job fields are mapped to the standard JOBVIS job schema before being handed off to the shared evaluation pipeline.',
    color: 'var(--step-gh-6)',
    details: ['source: "greenhouse"', 'source_id · source_url · apply_url', 'absolute_url → source_url', 'location.name → location'],
  },
]

// ── Lever-specific ingestion steps ────────────────────────────────────────────
// Note: Lever returns descriptions inline with every listing — no Phase 2 fetch.
const LEVER_STEPS: FlowStep[] = [
  {
    id: 'lever-portals',
    icon: '📋',
    label: 'PORTALS.YML',
    sublabel: 'Org registry',
    description: 'Server reads portals.yml to get the list of enabled Lever org slugs (e.g. "mistral"). Only companies with enabled: true (default) are targeted.',
    color: 'var(--step-lever-1)',
    details: ['config/portals.yml', 'enabled: true filter', 'slug extraction'],
  },
  {
    id: 'lever-listing',
    icon: '📡',
    label: 'PHASE 1 — LISTING',
    sublabel: 'Parallel REST queries',
    description: 'All org listing queries fire concurrently (up to 3 in parallel) against the Lever public REST API. Unlike Ashby or Greenhouse, the listing response already includes full descriptions — no Phase 2 fetch is needed.',
    color: 'var(--step-lever-2)',
    details: ['GET /v0/postings/{slug}?mode=json', 'LISTING_CONCURRENCY = 3', 'asyncio.gather() all orgs', 'Descriptions included inline ✓'],
  },
  {
    id: 'lever-dedup',
    icon: '⊘',
    label: 'DB SKIP CHECK',
    sublabel: 'Pre-pipeline dedup',
    description: 'Listing is crossed against all known Lever source_ids in the DB. Already-known jobs are dropped before the pipeline — no wasted work.',
    color: 'var(--step-lever-3)',
    details: ['DB query: existing Lever source_ids', 'O(1) set lookup', 'UUID-based job IDs'],
  },
  {
    id: 'lever-title',
    icon: '🔤',
    label: 'TITLE PRE-FILTER',
    sublabel: 'Early keyword discard',
    description: 'Title is checked against filter.yml include/exclude rules before entering the pipeline. Jobs guaranteed to be IGNORED are dropped here.',
    color: 'var(--step-lever-4)',
    details: ['apply_preliminary_filters()', 'Reuses same filter.yml rules', 'posting.text → title field'],
  },
  {
    id: 'lever-map',
    icon: '🗺',
    label: 'SCHEMA MAPPER',
    sublabel: 'Normalize to JOBVIS format',
    description: 'Raw Lever posting fields are mapped to the standard JOBVIS job schema. Descriptions, timestamps (ms epoch → ISO), and workplace type are normalized inline.',
    color: 'var(--step-lever-5)',
    details: ['source: "lever"', 'text → title · hostedUrl → source_url', 'workplaceType → Remote/Hybrid/On-site', 'createdAt (ms) → ISO timestamp', 'descriptionPlain fallback to HTML strip'],
  },
]

// ── LinkedIn-specific ingestion steps ─────────────────────────────────────────
const LINKEDIN_STEPS: FlowStep[] = [
  {
    id: 'li-ext',
    icon: '🔌',
    label: 'CHROME EXTENSION',
    sublabel: 'Client-side scrape',
    description: 'The JOBVIS Chrome extension scrapes job postings directly inside the LinkedIn job search page using the user\'s active session — no API key required.',
    color: 'var(--step-li-1)',
    details: ['Runs in browser tab', 'User LinkedIn session', 'Zero server auth needed'],
  },
  {
    id: 'li-post',
    icon: '📤',
    label: 'POST /api/deepscan',
    sublabel: 'Raw JSON payload',
    description: 'Scraped job objects are bundled into a single JSON payload and POSTed to the /api/deepscan endpoint. The array lives under the "linkedinScrapeData" key.',
    color: 'var(--step-li-2)',
    details: ['POST /api/deepscan', '{ "linkedinScrapeData": [...] }', 'Batch of N jobs'],
  },
  {
    id: 'li-map',
    icon: '🗺',
    label: 'SCHEMA MAPPER',
    sublabel: 'Thin passthrough + raw_data',
    description: 'Since v2 the Chrome extension already outputs standard JOBVIS keys. The mapper just attaches the original payload as raw_data for archival and re-scanning support.',
    color: 'var(--step-li-3)',
    details: ['linkedinDataMapper()', 'source: "linkedin"', 'raw_data archive attached', 'Passthrough — no field renaming'],
  },
  {
    id: 'li-dedup',
    icon: '⊘',
    label: 'DEDUP',
    sublabel: 'Pre-pipeline dedup',
    description: 'O(1) DB lookup against all known source_ids scoped by source. ACTIVE→ACTIVE and IGNORED→IGNORED duplicates are dropped entirely. Only new or force-rescanned jobs advance.',
    color: 'var(--step-li-4)',
    details: ['filter_and_deduplicate()', 'DB cache hit check', 'source: "linkedin"', 'force_rescan support', 'IGNORED→ACTIVE upserts'],
  },
  {
    id: 'li-title',
    icon: '🔤',
    label: 'TITLE PRE-FILTER',
    sublabel: 'Early keyword discard',
    description: 'Title matched against include/exclude keyword lists from filter.yml. Mismatched titles are immediately IGNORED before any expensive processing.',
    color: 'var(--step-li-5)',
    details: ['title_filter()', 'include_any keywords', 'exclude_any keywords', 'Case-insensitive match'],
  },
  {
    id: 'li-loc',
    icon: '📍',
    label: 'LOCATION FILTER',
    sublabel: 'Geo gate',
    description: 'Location checked against the allowed_locations list from filter.yml before any JD fetch. Jobs with non-matching locations are immediately IGNORED to save cost.',
    color: 'var(--step-li-6)',
    details: ['location_filter()', 'Runs before JD fetch', 'include_any locations', 'Case-insensitive match'],
  },
  {
    id: 'li-jd',
    icon: '📄',
    label: 'JD FILTER',
    sublabel: 'Description screen',
    description: 'Full job description is inspected using configurable keyword rules and regex pattern excludes. Jobs matching exclusion terms (e.g. "$40/hour") are discarded.',
    color: 'var(--step-li-6)',
    details: ['job_description_filter()', 'Positive keyword gate', 'Exclusion term rejection', 'Pattern exclude (regex)', 'Missing JD passthrough'],
  },
  {
    id: 'li-strip',
    icon: '✂',
    label: 'JD STRIPPER',
    sublabel: 'Noise reduction',
    description: 'Preprocessor that removes boilerplate, legalese, and filler from job descriptions before LLM token consumption — reducing noise and API cost.',
    color: 'var(--step-li-7)',
    details: ['strip_jd()', 'Boilerplate removal', 'Token optimisation'],
  },
  {
    id: 'li-llm',
    icon: '🤖',
    label: 'AI SCORING',
    sublabel: 'LLM evaluation',
    description: 'Surviving jobs are sent to the configured LLM (Ollama local or cloud). The JobMatchAnalyst prompt evaluates CV fit and returns a JSON score + reason.',
    color: 'var(--step-li-8)',
    details: ['evaluate_single_job()', 'temperature=0.0', 'JSON response format', 'Semaphore concurrency'],
    toggleKey: 'ai_scoring_enabled',
    toggleLabel: 'AI Scoring',
    toggleWarning: 'When disabled, all jobs that pass keyword filters are saved as ACTIVE with no score. The LLM is never called — pipeline completes instantly.',
  },
  {
    id: 'li-threshold',
    icon: '⚡',
    label: 'THRESHOLD',
    sublabel: 'Score gate',
    description: 'AI score compared against threshold (default 2.5/5). Jobs below threshold are marked IGNORED with reason "AI Score < 2.5". High scorers pass.',
    color: 'var(--step-li-9)',
    details: ['Score ≥ 2.5 → ACTIVE', 'Score < 2.5 → IGNORED', 'Configurable threshold'],
  },
  {
    id: 'li-persist',
    icon: '💾',
    label: 'PERSIST',
    sublabel: 'Database write',
    description: 'Final job record is written to PostgreSQL with full activity log, AI analysis, score, and source metadata. Scan session telemetry is also committed.',
    color: 'var(--step-li-10)',
    details: ['PostgreSQL INSERT/UPDATE', 'Activity log trail', 'ScanSession telemetry', 'source: "linkedin"'],
  },
]

// ── Shared evaluation pipeline steps ─────────────────────────────────────────
const EVAL_STEPS: FlowStep[] = [
  {
    id: 'dedup',
    icon: '⊘',
    label: 'DEDUP',
    sublabel: 'Batch deduplication',
    description: 'O(1) DB lookup against all known source_ids scoped by source. Existing ACTIVE→ACTIVE and IGNORED→IGNORED jobs are vaporized. Only new or force-rescanned jobs advance.',
    color: 'var(--step-dedup)',
    details: ['DB cache hit check', 'force_rescan support', 'IGNORED→ACTIVE upserts'],
  },
  {
    id: 'title',
    icon: '🔤',
    label: 'TITLE FILTER',
    sublabel: 'Keyword pre-screen',
    description: 'Title matched against include/exclude keyword lists from filter.yml. Mismatched titles are immediately IGNORED before any expensive processing.',
    color: 'var(--step-title)',
    details: ['include_any keywords', 'exclude_any keywords', 'Case-insensitive match'],
  },
  {
    id: 'jd',
    icon: '📄',
    label: 'JD FILTER',
    sublabel: 'Description screen',
    description: 'Full job description is inspected using configurable keyword rules. Jobs matching exclusion terms (e.g. "citizenship") are discarded.',
    color: 'var(--step-jd)',
    details: ['Positive keyword gate', 'Exclusion term rejection', 'Missing JD passthrough'],
  },
  {
    id: 'stripper',
    icon: '✂',
    label: 'JD STRIPPER',
    sublabel: 'Noise reduction',
    description: 'Preprocessor that removes boilerplate, legalese, and filler from job descriptions before LLM token consumption — reducing noise and cost.',
    color: 'var(--step-strip)',
    details: ['strip_jd()', 'Boilerplate removal', 'Token optimisation'],
  },
  {
    id: 'llm',
    icon: '🤖',
    label: 'AI SCORING',
    sublabel: 'LLM evaluation',
    description: 'Surviving jobs are sent to the configured LLM (Ollama local or cloud). The JobMatchAnalyst prompt evaluates CV fit and returns a JSON score + reason.',
    color: 'var(--step-llm)',
    details: ['temperature=0.0', 'JSON response format', 'Semaphore concurrency'],
    toggleKey: 'ai_scoring_enabled',
    toggleLabel: 'AI Scoring',
    toggleWarning: 'When disabled, all jobs that pass keyword filters are saved as ACTIVE with no score. The LLM is never called — pipeline completes instantly.',
  },
  {
    id: 'threshold',
    icon: '⚡',
    label: 'THRESHOLD',
    sublabel: 'Score gate',
    description: 'AI score compared against threshold (default 2.5/5). Jobs below threshold are marked IGNORED with reason "AI Score < 2.5". High scorers pass.',
    color: 'var(--step-threshold)',
    details: ['Score ≥ 2.5 → ACTIVE', 'Score < 2.5 → IGNORED', 'Configurable threshold'],
  },
  {
    id: 'persist',
    icon: '💾',
    label: 'PERSIST',
    sublabel: 'Database write',
    description: 'Final job record is written to PostgreSQL with full activity log, AI analysis, score, and source metadata. Scan session telemetry is also committed.',
    color: 'var(--step-persist)',
    details: ['PostgreSQL INSERT/UPDATE', 'Activity log trail', 'ScanSession telemetry'],
  },
]

const PROVIDERS = [
  {
    id: 'linkedin',
    name: 'LinkedIn',
    type: 'Chrome Extension Scrape',
    status: 'active',
    icon: 'in',
    description: 'Jobs scraped client-side via the JOBVIS Chrome Extension from LinkedIn job search pages. Raw JSON POSTed to /api/deepscan.',
    badge: 'SCRAPER',
    color: '#0a66c2',
  },
  {
    id: 'ashby',
    name: 'Ashby HQ',
    type: 'Server-side API',
    status: 'active',
    icon: 'AQ',
    description: "Companies tracked in portals.yml are crawled server-side via Ashby's public GraphQL API. No auth required.",
    badge: 'API',
    color: '#7c3aed',
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    type: 'Server-side API',
    status: 'active',
    icon: 'GH',
    description: "Companies tracked in portals.yml are crawled server-side via Greenhouse's public REST API. No auth required.",
    badge: 'API',
    color: '#22c55e',
  },
  {
    id: 'lever',
    name: 'Lever',
    type: 'Server-side API',
    status: 'active',
    icon: 'LV',
    description: "Companies tracked in portals.yml are crawled server-side via Lever's public REST API. Descriptions are returned inline with every listing — no separate per-job fetch needed.",
    badge: 'API',
    color: '#f97316',
  },
]

// ─── Scheduler interval options ──────────────────────────────────────────────
const INTERVAL_OPTIONS = [
  { label: '~15 min',  minutes: 15   },
  { label: '~30 min',  minutes: 30   },
  { label: '~1 hr',   minutes: 60   },
  { label: '~2 hr',   minutes: 120  },
  { label: '~4 hr',   minutes: 240  },
  { label: '~8 hr',   minutes: 480  },
  { label: '~12 hr',  minutes: 720  },
  { label: '~24 hr',  minutes: 1440 },
]

// ─── Scheduler Control Component ─────────────────────────────────────────────

function SchedulerControl({
  source,
  settings,
  onToggle,
  onInterval,
  saving,
}: {
  source: 'ashby' | 'greenhouse' | 'lever'
  settings: AppSettings | null
  onToggle: (enabled: boolean) => void
  onInterval: (minutes: number) => void
  saving: boolean
}) {
  const enabled = settings?.scheduler?.[source]?.enabled ?? false
  const interval = settings?.scheduler?.[source]?.interval_minutes ?? 60

  // ── Live timing state (polled from backend every 5s) ─────────────────────
  const [nextRunAt, setNextRunAt] = useState<number | null>(null)
  const [sleepDuration, setSleepDuration] = useState<number | null>(null)
  const [jobRunning, setJobRunning] = useState(false)

  // ── Countdown text + progress (ticked locally every second) ──────────────
  const [countdown, setCountdown] = useState('')
  const [progress, setProgress] = useState(0)

  // Poll /api/scheduler/status every 5s when enabled
  useEffect(() => {
    if (!enabled) {
      setNextRunAt(null); setSleepDuration(null)
      setJobRunning(false); setCountdown(''); setProgress(0)
      return
    }
    const poll = () => {
      fetch('http://localhost:8000/api/scheduler/status')
        .then(r => r.json())
        .then(data => {
          const task = data?.tasks?.[source]
          if (!task) return
          setNextRunAt(task.next_run_at ? task.next_run_at * 1000 : null)
          setSleepDuration(task.sleep_duration_secs ?? null)
          setJobRunning(task.state === 'running')
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [enabled, source])

  // Tick every second to compute countdown from local clock (no extra network calls)
  useEffect(() => {
    if (!enabled || !nextRunAt || jobRunning) {
      if (!jobRunning) { setCountdown(''); setProgress(0) }
      return
    }
    const tick = () => {
      const remaining = Math.max(0, Math.floor((nextRunAt - Date.now()) / 1000))
      const mins = Math.floor(remaining / 60)
      const secs = remaining % 60
      setCountdown(mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`)
      if (sleepDuration && sleepDuration > 0) {
        const elapsed = sleepDuration - remaining
        setProgress(Math.min(100, Math.max(0, (elapsed / sleepDuration) * 100)))
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [enabled, nextRunAt, sleepDuration, jobRunning])

  // ── Run Now handler ───────────────────────────────────────────────────────
  const [triggerRunning, setTriggerRunning] = useState(false)

  const handleRunNow = async () => {
    setTriggerRunning(true)
    try {
      await fetch(`http://localhost:8000/api/scheduler/trigger/${source}`, { method: 'POST' })
      setNextRunAt(null)
      setCountdown('')
      setProgress(0)
      setJobRunning(true)
      setTimeout(() => {
        fetch('http://localhost:8000/api/scheduler/status')
          .then(r => r.json())
          .then(data => {
            const task = data?.tasks?.[source]
            if (task) {
              setNextRunAt(task.next_run_at ? task.next_run_at * 1000 : null)
              setSleepDuration(task.sleep_duration_secs ?? null)
              setJobRunning(task.state === 'running')
            }
          })
          .catch(() => {})
      }, 800)
    } catch {
      // silently ignore — the scan still fires on the server
    } finally {
      setTriggerRunning(false)
    }
  }

  const stepColor = source === 'greenhouse' ? 'var(--step-gh-5)' : source === 'lever' ? 'var(--step-lever-5)' : 'var(--step-ashby-5)'

  return (
    <div className="scheduler-control">
      <div className="scheduler-control-header">
        <div className="scheduler-control-left">
          <span className="scheduler-icon">🕐</span>
          <div>
            <div className="scheduler-title">AUTO SCHEDULER</div>
            <div className="scheduler-subtitle">
              {enabled
                ? `Every ~${INTERVAL_OPTIONS.find(o => o.minutes === interval)?.label?.replace('~', '') ?? interval + ' min'} ± 1 min`
                : 'Disabled — manual trigger only'}
            </div>
          </div>
        </div>
        <button
          id={`toggle-${source}-scheduler`}
          className={`toggle-sw ${enabled ? 'toggle-sw--on' : 'toggle-sw--off'}`}
          style={{ '--step-color': stepColor } as React.CSSProperties}
          onClick={() => onToggle(!enabled)}
          disabled={saving}
          aria-label={`Toggle ${source} scheduler`}
        >
          <span className="toggle-sw-thumb" />
        </button>
      </div>

      {/* ── Live countdown block ─────────────────────────────────── */}
      {enabled && (
        <div className="scheduler-countdown-block">
          {jobRunning ? (
            <div className="scheduler-scanning">
              <span className="scheduler-scanning-dot" />
              <span className="scheduler-scanning-label">SCANNING NOW</span>
            </div>
          ) : countdown ? (
            <>
              <div className="scheduler-countdown-row">
                <div>
                  <div className="scheduler-countdown-label">NEXT TRIGGER IN</div>
                  <div className="scheduler-countdown-value">{countdown}</div>
                </div>
                <button
                  id={`btn-run-now-${source}`}
                  className="run-now-btn"
                  onClick={handleRunNow}
                  disabled={triggerRunning || jobRunning}
                  title="Trigger scan now and reset timer"
                >
                  {triggerRunning ? '...' : '▶ RUN NOW'}
                </button>
              </div>
              <div className="scheduler-progress-track">
                <div className="scheduler-progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : (
            <span className="scheduler-countdown-label">Waiting for server...</span>
          )}
        </div>
      )}

      {/* ── Run once when scheduler is disabled ─────────────────── */}
      {!enabled && (
        <div className="scheduler-manual-block">
          <button
            id={`btn-run-once-${source}`}
            className="run-now-btn run-now-btn--manual"
            onClick={handleRunNow}
            disabled={triggerRunning}
          >
            {triggerRunning ? 'TRIGGERING...' : '▶ RUN ONCE NOW'}
          </button>
        </div>
      )}

      {/* ── Interval picker ─────────────────────────────────────── */}
      {enabled && (
        <div className="scheduler-interval-row">
          <span className="scheduler-interval-label">INTERVAL</span>
          <div className="scheduler-interval-options">
            {INTERVAL_OPTIONS.map(opt => (
              <button
                key={opt.minutes}
                id={`interval-${source}-${opt.minutes}`}
                className={`interval-btn ${interval === opt.minutes ? 'interval-btn--active' : ''}`}
                onClick={() => onInterval(opt.minutes)}
                disabled={saving}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PipelineStep({
  step,
  index,
  isOpen,
  onToggle,
  settingValue,
  onSettingToggle,
  saving,
  extraContent,
}: {
  step: FlowStep
  index: number
  isOpen: boolean
  onToggle: () => void
  settingValue?: boolean
  onSettingToggle?: (val: boolean) => void
  saving: boolean
  extraContent?: React.ReactNode
}) {
  const isDisabled = step.toggleKey !== undefined && settingValue === false

  return (
    <div className="step-item">
      <button
        className={`step-node ${isOpen ? 'step-node--open' : ''} ${isDisabled ? 'step-node--bypassed' : ''}`}
        style={{ '--step-color': step.color } as React.CSSProperties}
        onClick={onToggle}
        id={`step-${step.id}`}
        aria-expanded={isOpen}
      >
        <span className="step-num">{String(index + 1).padStart(2, '0')}</span>
        <span className="step-icon">{step.icon}</span>
        <span className="step-body">
          <span className="step-label">{step.label}</span>
          <span className="step-sub">{step.sublabel}</span>
        </span>
        {isDisabled && <span className="step-bypass-pill">BYPASSED</span>}
        <span className={`step-chevron ${isOpen ? 'step-chevron--open' : ''}`}>›</span>
      </button>

      {isOpen && (
        <div
          className="step-detail"
          style={{ '--step-color': step.color } as React.CSSProperties}
        >
          <p className="step-detail-desc">{step.description}</p>
          <div className="step-detail-tags">
            {step.details.map(d => (
              <span key={d} className="step-detail-tag">{d}</span>
            ))}
          </div>

          {step.toggleKey && onSettingToggle && (
            <div className="step-toggle-block">
              <div className="step-toggle-row">
                <div>
                  <div className="step-toggle-label">
                    {settingValue ? 'ENABLED' : 'DISABLED'}
                  </div>
                  <div className="step-toggle-sub">{step.toggleLabel} step</div>
                </div>
                <button
                  id={`toggle-${step.id}`}
                  className={`toggle-sw ${settingValue ? 'toggle-sw--on' : 'toggle-sw--off'}`}
                  onClick={e => { e.stopPropagation(); onSettingToggle(!settingValue) }}
                  disabled={saving}
                  aria-label={`Toggle ${step.toggleLabel}`}
                >
                  <span className="toggle-sw-thumb" />
                </button>
              </div>
              {!settingValue && step.toggleWarning && (
                <p className="step-toggle-warning">⚠ {step.toggleWarning}</p>
              )}
            </div>
          )}

          {extraContent && (
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid color-mix(in srgb, var(--step-color) 14%, rgba(102,252,241,0.07))' }}>
              {extraContent}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Connector({ label }: { label?: string }) {
  return (
    <div className="flow-connector">
      <div className="flow-connector-line" />
      {label
        ? <span className="flow-connector-label">{label}</span>
        : <span className="flow-connector-arrow">▼</span>}
    </div>
  )
}

// ─── CSV parsing helpers ─────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes }
    else if (ch === ',' && !inQuotes) { result.push(current); current = '' }
    else { current += ch }
  }
  result.push(current)
  return result
}

/** Read CSV text → return header list + raw cell values per column-index */
function parseCsvHeaders(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 1) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map(l => splitCsvLine(l).map(c => c.trim().replace(/^"|"$/g, '')))
  return { headers, rows }
}

/** Given rows + a column index, return the raw cell values (non-empty only, max 50) */
function previewColumn(rows: string[][], colIdx: number): string[] {
  return rows
    .map(r => (r[colIdx] ?? '').trim())
    .filter(Boolean)
    .slice(0, 50)
}

type ParsedSlug = { slug: string; name: string }

/** Extract Ashby slugs from a list of URLs */
function extractAshbySlugs(urls: string[]): ParsedSlug[] {
  const seen = new Set<string>()
  const results: ParsedSlug[] = []
  for (const raw of urls) {
    try {
      const u = new URL(raw)
      if (u.hostname !== 'jobs.ashbyhq.com') continue
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 0) continue
      const slug = decodeURIComponent(parts[0]).toLowerCase()
      if (slug.includes(' ')) continue
      if (!seen.has(slug)) { seen.add(slug); results.push({ slug, name: slug }) }
    } catch { /* not a URL */ }
  }
  return results
}

/** Extract Lever org slugs from a list of URLs */
function extractLeverSlugs(urls: string[]): ParsedSlug[] {
  const seen = new Set<string>()
  const results: ParsedSlug[] = []
  for (const raw of urls) {
    try {
      const u = new URL(raw)
      if (!u.hostname.includes('lever.co')) continue
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 0) continue
      const slug = decodeURIComponent(parts[0]).toLowerCase()
      if (slug.includes(' ')) continue
      if (!seen.has(slug)) { seen.add(slug); results.push({ slug, name: slug }) }
    } catch { /* not a URL */ }
  }
  return results
}

/** Extract Greenhouse board-token slugs from a list of URLs */
function extractGreenhouseSlugs(urls: string[]): ParsedSlug[] {
  const seen = new Set<string>()
  const results: ParsedSlug[] = []
  for (const raw of urls) {
    try {
      const u = new URL(raw)
      // job-boards.greenhouse.io/{token}/jobs/...
      if (!u.hostname.includes('greenhouse.io')) continue
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 0) continue
      const slug = decodeURIComponent(parts[0]).toLowerCase()
      if (slug.includes(' ')) continue
      if (!seen.has(slug)) { seen.add(slug); results.push({ slug, name: slug }) }
    } catch { /* not a URL */ }
  }
  return results
}

// ─── Shared CSV column picker component ──────────────────────────────────────

interface CsvColumnPickerProps {
  headers: string[]
  rows: string[][]
  selectedCol: number | null
  onSelect: (idx: number) => void
  urlFilter: (val: string) => boolean   // returns true if cell looks like a matching URL
}

function CsvColumnPicker({ headers, rows, selectedCol, onSelect, urlFilter }: CsvColumnPickerProps) {
  const previewUrls = selectedCol !== null
    ? previewColumn(rows, selectedCol).filter(urlFilter)
    : []

  return (
    <div className="csv-col-picker">
      <div className="csv-col-picker-label">Which column contains the job URLs?</div>
      <div className="csv-col-picker-options">
        {headers.map((h, i) => (
          <button
            key={i}
            className={`csv-col-btn ${selectedCol === i ? 'csv-col-btn--active' : ''}`}
            onClick={() => onSelect(i)}
          >
            {h || `Column ${i + 1}`}
          </button>
        ))}
      </div>
      {selectedCol !== null && (
        <div className="csv-col-preview">
          <div className="csv-col-preview-label">
            {previewUrls.length > 0
              ? `${previewUrls.length} matching URL(s) found in this column:`
              : 'No matching URLs found in this column — try another.'}
          </div>
          {previewUrls.length > 0 && (
            <textarea
              className="csv-col-preview-box"
              readOnly
              rows={Math.min(previewUrls.length, 6)}
              value={previewUrls.join('\n')}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Ashby Portal Panel ───────────────────────────────────────────────────────

function AshbyPortalPanel() {
  const [portals, setPortals]         = useState<Portal[]>([])
  const [loading, setLoading]         = useState(false)
  const [feedback, setFeedback]       = useState<string | null>(null)
  const [feedbackErr, setFeedbackErr] = useState(false)
  const [importing, setImporting]     = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)

  // CSV column-picker state
  const [csvHeaders, setCsvHeaders]   = useState<string[]>([])
  const [csvRows, setCsvRows]         = useState<string[][]>([])
  const [csvColIdx, setCsvColIdx]     = useState<number | null>(null)
  const [csvPending, setCsvPending]   = useState(false)   // waiting for col selection

  const fetchPortals = () => {
    setLoading(true)
    fetch('http://localhost:8000/api/portals')
      .then(r => r.json())
      .then((data: Portal[]) => setPortals(data.filter(p => p.source === 'ashby')))
      .catch(() => setFeedback('Could not load portals — is the server running?'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchPortals() }, [])

  // Step 1 — file chosen → parse headers, show column picker
  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    const { headers, rows } = parseCsvHeaders(text)
    if (headers.length === 0) {
      setFeedback('Could not read CSV headers.')
      setFeedbackErr(true)
      return
    }
    setCsvHeaders(headers)
    setCsvRows(rows)
    setCsvColIdx(null)
    setCsvPending(true)
    setFeedback(null)
  }

  // Step 2 — user confirmed column → extract slugs & import
  const handleConfirmImport = async () => {
    if (csvColIdx === null) return
    const urls = previewColumn(csvRows, csvColIdx)
    const parsed = extractAshbySlugs(urls)
    if (parsed.length === 0) {
      setFeedback('No Ashby URLs found in that column.')
      setFeedbackErr(true)
      setCsvPending(false)
      return
    }
    const existingSlugs = new Set(portals.map(p => p.slug))
    const newEntries = parsed.filter(p => !existingSlugs.has(p.slug))
    if (newEntries.length === 0) {
      setFeedback(`All ${parsed.length} slug(s) already tracked — nothing to import.`)
      setFeedbackErr(false)
      setCsvPending(false)
      return
    }
    setImporting(true)
    setCsvPending(false)
    setFeedback(null)
    try {
      const res = await fetch('http://localhost:8000/api/portals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntries),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setFeedback(`Imported ${result.imported} new portal(s), skipped ${result.skipped} duplicate(s).`)
      setFeedbackErr(false)
      fetchPortals()
    } catch {
      setFeedback('Import failed — server unreachable.')
      setFeedbackErr(true)
    } finally {
      setImporting(false)
    }
  }

  const active   = portals.filter(p => p.enabled)
  const disabled = portals.filter(p => !p.enabled)

  const isAshbyUrl = (v: string) => { try { return new URL(v).hostname === 'jobs.ashbyhq.com' } catch { return false } }

  return (
    <div className="portal-panel">
      <div className="portal-panel-header">
        <span className="portal-panel-count">
          {loading ? 'Loading…' : `${active.length} active · ${disabled.length} disabled`}
        </span>
        <div className="portal-panel-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleCsvFile}
          />
          <button
            className="portal-import-btn"
            onClick={() => { setCsvPending(false); fileInputRef.current?.click() }}
            disabled={importing}
          >
            {importing ? 'Importing…' : '⬆ Import from CSV'}
          </button>
        </div>
      </div>

      {/* ── Column picker (step 1) ── */}
      {csvPending && (
        <div className="csv-import-panel">
          <CsvColumnPicker
            headers={csvHeaders}
            rows={csvRows}
            selectedCol={csvColIdx}
            onSelect={setCsvColIdx}
            urlFilter={isAshbyUrl}
          />
          <div className="csv-import-actions">
            <button
              className="portal-import-btn"
              onClick={handleConfirmImport}
              disabled={csvColIdx === null}
            >
              Import slugs from this column
            </button>
            <button
              className="portal-cancel-btn"
              onClick={() => setCsvPending(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div className={`portal-feedback ${feedbackErr ? 'portal-feedback--err' : 'portal-feedback--ok'}`}>
          {feedback}
        </div>
      )}

      {!loading && portals.length > 0 && (
        <ul className="portal-list">
          {portals.map(p => (
            <li key={p.slug} className={`portal-list-item ${p.enabled ? '' : 'portal-list-item--disabled'}`}>
              <span className="portal-slug">{p.slug}</span>
              <span className="portal-name">{p.name !== p.slug ? p.name : ''}</span>
              <span className={`portal-enabled-badge ${p.enabled ? 'portal-enabled-badge--on' : 'portal-enabled-badge--off'}`}>
                {p.enabled ? 'ON' : 'OFF'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!loading && portals.length === 0 && (
        <p className="portal-empty">No Ashby portals configured yet.</p>
      )}
    </div>
  )
}

// ─── Greenhouse Portal Panel ──────────────────────────────────────────────────

function GreenhousePortalPanel() {
  const [portals, setPortals]         = useState<Portal[]>([])
  const [loading, setLoading]         = useState(false)
  const [feedback, setFeedback]       = useState<string | null>(null)
  const [feedbackErr, setFeedbackErr] = useState(false)
  const [adding, setAdding]           = useState(false)
  const [token, setToken]             = useState('')
  const [name, setName]               = useState('')
  const [submitting, setSubmitting]   = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)

  // CSV column-picker state
  const [csvHeaders, setCsvHeaders]   = useState<string[]>([])
  const [csvRows, setCsvRows]         = useState<string[][]>([])
  const [csvColIdx, setCsvColIdx]     = useState<number | null>(null)
  const [csvPending, setCsvPending]   = useState(false)
  const [importing, setImporting]     = useState(false)

  const fetchPortals = () => {
    setLoading(true)
    fetch('http://localhost:8000/api/portals')
      .then(r => r.json())
      .then((data: Portal[]) => setPortals(data.filter(p => p.source === 'greenhouse')))
      .catch(() => setFeedback('Could not load portals — is the server running?'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchPortals() }, [])

  // Manual add
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = token.trim().toLowerCase()
    const n = name.trim()
    if (!t) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch('http://localhost:8000/api/portals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ source: 'greenhouse', slug: t, name: n || t }]),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      if (result.imported > 0) {
        setFeedback(`Added: ${t}`)
        setFeedbackErr(false)
        setToken(''); setName(''); setAdding(false)
        fetchPortals()
      } else {
        setFeedback(`'${t}' is already tracked.`)
        setFeedbackErr(false)
      }
    } catch {
      setFeedback('Import failed — server unreachable.')
      setFeedbackErr(true)
    } finally {
      setSubmitting(false)
    }
  }

  // CSV step 1 — headers
  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    const { headers, rows } = parseCsvHeaders(text)
    if (headers.length === 0) {
      setFeedback('Could not read CSV headers.')
      setFeedbackErr(true)
      return
    }
    setCsvHeaders(headers); setCsvRows(rows)
    setCsvColIdx(null); setCsvPending(true); setFeedback(null)
  }

  // CSV step 2 — confirm
  const handleConfirmImport = async () => {
    if (csvColIdx === null) return
    const urls = previewColumn(csvRows, csvColIdx)
    const parsed = extractGreenhouseSlugs(urls)
    if (parsed.length === 0) {
      setFeedback('No Greenhouse URLs found in that column.')
      setFeedbackErr(true); setCsvPending(false); return
    }
    const existingSlugs = new Set(portals.map(p => p.slug))
    const newEntries = parsed
      .filter(p => !existingSlugs.has(p.slug))
      .map(p => ({ ...p, source: 'greenhouse' }))
    if (newEntries.length === 0) {
      setFeedback(`All ${parsed.length} slug(s) already tracked — nothing to import.`)
      setFeedbackErr(false); setCsvPending(false); return
    }
    setImporting(true); setCsvPending(false); setFeedback(null)
    try {
      const res = await fetch('http://localhost:8000/api/portals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntries),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setFeedback(`Imported ${result.imported} new portal(s), skipped ${result.skipped} duplicate(s).`)
      setFeedbackErr(false); fetchPortals()
    } catch {
      setFeedback('Import failed — server unreachable.')
      setFeedbackErr(true)
    } finally {
      setImporting(false)
    }
  }

  const active   = portals.filter(p => p.enabled)
  const disabled = portals.filter(p => !p.enabled)

  const isGhUrl = (v: string) => { try { return new URL(v).hostname.includes('greenhouse.io') } catch { return false } }

  return (
    <div className="portal-panel">
      <div className="portal-panel-header">
        <span className="portal-panel-count">
          {loading ? 'Loading…' : `${active.length} active · ${disabled.length} disabled`}
        </span>
        <div className="portal-panel-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleCsvFile}
          />
          <button
            className="portal-import-btn"
            onClick={() => { setCsvPending(false); fileInputRef.current?.click() }}
            disabled={importing}
          >
            {importing ? 'Importing…' : '⬆ Import from CSV'}
          </button>
          <button
            className="portal-import-btn"
            onClick={() => { setAdding(a => !a); setFeedback(null) }}
          >
            {adding ? '✕ Cancel' : '+ Add board'}
          </button>
        </div>
      </div>

      {/* ── CSV column picker ── */}
      {csvPending && (
        <div className="csv-import-panel">
          <CsvColumnPicker
            headers={csvHeaders}
            rows={csvRows}
            selectedCol={csvColIdx}
            onSelect={setCsvColIdx}
            urlFilter={isGhUrl}
          />
          <div className="csv-import-actions">
            <button
              className="portal-import-btn"
              onClick={handleConfirmImport}
              disabled={csvColIdx === null}
            >
              Import slugs from this column
            </button>
            <button className="portal-cancel-btn" onClick={() => setCsvPending(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Manual add form ── */}
      {adding && (
        <form className="gh-add-form" onSubmit={handleAdd}>
          <input
            className="gh-add-input"
            placeholder="board token / slug (e.g. spacex)"
            value={token}
            onChange={e => setToken(e.target.value)}
            required
          />
          <input
            className="gh-add-input"
            placeholder="display name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button className="portal-import-btn" type="submit" disabled={submitting || !token.trim()}>
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      {feedback && (
        <div className={`portal-feedback ${feedbackErr ? 'portal-feedback--err' : 'portal-feedback--ok'}`}>
          {feedback}
        </div>
      )}

      {!loading && portals.length > 0 && (
        <ul className="portal-list">
          {portals.map(p => (
            <li key={p.slug} className={`portal-list-item ${p.enabled ? '' : 'portal-list-item--disabled'}`}>
              <span className="portal-slug">{p.slug}</span>
              <span className="portal-name">{p.name !== p.slug ? p.name : ''}</span>
              <span className={`portal-enabled-badge ${p.enabled ? 'portal-enabled-badge--on' : 'portal-enabled-badge--off'}`}>
                {p.enabled ? 'ON' : 'OFF'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!loading && portals.length === 0 && (
        <p className="portal-empty">No Greenhouse portals configured yet.</p>
      )}
    </div>
  )
}

// ─── Lever Portal Panel ───────────────────────────────────────────────────────

function LeverPortalPanel() {
  const [portals, setPortals]         = useState<Portal[]>([])
  const [loading, setLoading]         = useState(false)
  const [feedback, setFeedback]       = useState<string | null>(null)
  const [feedbackErr, setFeedbackErr] = useState(false)
  const [adding, setAdding]           = useState(false)
  const [token, setToken]             = useState('')
  const [name, setName]               = useState('')
  const [submitting, setSubmitting]   = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)

  // CSV column-picker state
  const [csvHeaders, setCsvHeaders]   = useState<string[]>([])
  const [csvRows, setCsvRows]         = useState<string[][]>([])
  const [csvColIdx, setCsvColIdx]     = useState<number | null>(null)
  const [csvPending, setCsvPending]   = useState(false)
  const [importing, setImporting]     = useState(false)

  const fetchPortals = () => {
    setLoading(true)
    fetch('http://localhost:8000/api/portals')
      .then(r => r.json())
      .then((data: Portal[]) => setPortals(data.filter(p => p.source === 'lever')))
      .catch(() => setFeedback('Could not load portals — is the server running?'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchPortals() }, [])

  // Manual add
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = token.trim().toLowerCase()
    const n = name.trim()
    if (!t) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch('http://localhost:8000/api/portals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ source: 'lever', slug: t, name: n || t }]),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      if (result.imported > 0) {
        setFeedback(`Added: ${t}`)
        setFeedbackErr(false)
        setToken(''); setName(''); setAdding(false)
        fetchPortals()
      } else {
        setFeedback(`'${t}' is already tracked.`)
        setFeedbackErr(false)
      }
    } catch {
      setFeedback('Import failed — server unreachable.')
      setFeedbackErr(true)
    } finally {
      setSubmitting(false)
    }
  }

  // CSV step 1 — parse headers
  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    const { headers, rows } = parseCsvHeaders(text)
    if (headers.length === 0) {
      setFeedback('Could not read CSV headers.')
      setFeedbackErr(true)
      return
    }
    setCsvHeaders(headers); setCsvRows(rows)
    setCsvColIdx(null); setCsvPending(true); setFeedback(null)
  }

  // CSV step 2 — confirm column
  const handleConfirmImport = async () => {
    if (csvColIdx === null) return
    const urls = previewColumn(csvRows, csvColIdx)
    const parsed = extractLeverSlugs(urls)
    if (parsed.length === 0) {
      setFeedback('No Lever URLs found in that column.')
      setFeedbackErr(true); setCsvPending(false); return
    }
    const existingSlugs = new Set(portals.map(p => p.slug))
    const newEntries = parsed
      .filter(p => !existingSlugs.has(p.slug))
      .map(p => ({ ...p, source: 'lever' }))
    if (newEntries.length === 0) {
      setFeedback(`All ${parsed.length} slug(s) already tracked — nothing to import.`)
      setFeedbackErr(false); setCsvPending(false); return
    }
    setImporting(true); setCsvPending(false); setFeedback(null)
    try {
      const res = await fetch('http://localhost:8000/api/portals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntries),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setFeedback(`Imported ${result.imported} new portal(s), skipped ${result.skipped} duplicate(s).`)
      setFeedbackErr(false); fetchPortals()
    } catch {
      setFeedback('Import failed — server unreachable.')
      setFeedbackErr(true)
    } finally {
      setImporting(false)
    }
  }

  const active   = portals.filter(p => p.enabled)
  const disabled = portals.filter(p => !p.enabled)

  const isLeverUrl = (v: string) => { try { return new URL(v).hostname.includes('lever.co') } catch { return false } }

  return (
    <div className="portal-panel">
      <div className="portal-panel-header">
        <span className="portal-panel-count">
          {loading ? 'Loading…' : `${active.length} active · ${disabled.length} disabled`}
        </span>
        <div className="portal-panel-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleCsvFile}
          />
          <button
            className="portal-import-btn"
            onClick={() => { setCsvPending(false); fileInputRef.current?.click() }}
            disabled={importing}
          >
            {importing ? 'Importing…' : '⬆ Import from CSV'}
          </button>
          <button
            className="portal-import-btn"
            onClick={() => { setAdding(a => !a); setFeedback(null) }}
          >
            {adding ? '✕ Cancel' : '+ Add org'}
          </button>
        </div>
      </div>

      {/* ── CSV column picker ── */}
      {csvPending && (
        <div className="csv-import-panel">
          <CsvColumnPicker
            headers={csvHeaders}
            rows={csvRows}
            selectedCol={csvColIdx}
            onSelect={setCsvColIdx}
            urlFilter={isLeverUrl}
          />
          <div className="csv-import-actions">
            <button
              className="portal-import-btn"
              onClick={handleConfirmImport}
              disabled={csvColIdx === null}
            >
              Import slugs from this column
            </button>
            <button className="portal-cancel-btn" onClick={() => setCsvPending(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Manual add form ── */}
      {adding && (
        <form className="gh-add-form" onSubmit={handleAdd}>
          <input
            className="gh-add-input"
            placeholder="org slug (e.g. mistral)"
            value={token}
            onChange={e => setToken(e.target.value)}
            required
          />
          <input
            className="gh-add-input"
            placeholder="display name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button className="portal-import-btn" type="submit" disabled={submitting || !token.trim()}>
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      {feedback && (
        <div className={`portal-feedback ${feedbackErr ? 'portal-feedback--err' : 'portal-feedback--ok'}`}>
          {feedback}
        </div>
      )}

      {!loading && portals.length > 0 && (
        <ul className="portal-list">
          {portals.map(p => (
            <li key={p.slug} className={`portal-list-item ${p.enabled ? '' : 'portal-list-item--disabled'}`}>
              <span className="portal-slug">{p.slug}</span>
              <span className="portal-name">{p.name !== p.slug ? p.name : ''}</span>
              <span className={`portal-enabled-badge ${p.enabled ? 'portal-enabled-badge--on' : 'portal-enabled-badge--off'}`}>
                {p.enabled ? 'ON' : 'OFF'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!loading && portals.length === 0 && (
        <p className="portal-empty">No Lever portals configured yet.</p>
      )}
    </div>
  )
}

// ─── LinkedIn Deep Scan Panel ─────────────────────────────────────────────────

function LinkedInDeepScanPanel() {
  const [jsonData, setJsonData] = useState('')
  const [status, setStatus]     = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const [logs, setLogs]         = useState<string[]>([])
  const [open, setOpen]         = useState(false)

  const wsRef      = useRef<WebSocket | null>(null)
  const termRef    = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
  }, [logs])

  useEffect(() => () => { wsRef.current?.close() }, [])

  const handleSubmit = async () => {
    if (!jsonData.trim()) { setStatus('ERROR: PLEASE ENTER JSON DATA'); return }
    try {
      const parsedData = JSON.parse(jsonData)
      setLoading(true); setStatus(null)
      setLogs(['[SYSTEM] Opening telemetry socket to backend...'])

      const ws = new WebSocket('ws://localhost:8000/ws/deepscan')
      wsRef.current = ws

      ws.onopen = async () => {
        setLogs(prev => [...prev, '[SYSTEM] Socket connected. Transmitting Deep Scan payload...'])
        try {
          const res = await fetch('http://localhost:8000/api/deepscan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linkedinScrapeData: parsedData }),
          })
          if (!res.ok) { setStatus(`ERROR: BACKEND RETURNED ${res.status}`); setLoading(false); ws.close() }
          else { setJsonData('') }
        } catch { setStatus('ERROR: POST FAILED'); setLoading(false); ws.close() }
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          setLogs(prev => [...prev, data.message])
          if (data.type === 'complete') {
            setTimeout(() => { setLoading(false); setOpen(false) }, 2500)
          }
        } catch { /* ignore */ }
      }

      ws.onerror = () => { setStatus('ERROR: SOCKET CONNECTION FAILED'); setLoading(false) }
    } catch {
      setStatus('ERROR: INVALID JSON OR CONNECTION FAILED')
      setLoading(false)
      wsRef.current?.close()
    }
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <button
        className="portal-import-btn"
        style={{ width: '100%', justifyContent: 'center', padding: '0.6rem 1rem', fontSize: '0.8rem', letterSpacing: '1.5px' }}
        onClick={() => { setOpen(o => !o); setStatus(null) }}
        disabled={loading}
      >
        {loading ? '⏳ SCANNING...' : open ? '✕ CLOSE DEEP SCAN' : '⚡ INITIATE DEEP SCAN'}
      </button>

      {open && (
        <div style={{ marginTop: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '1rem', background: 'rgba(0,0,0,0.3)' }}>
          {!loading ? (
            <>
              <label style={{ display: 'block', fontSize: '0.75rem', letterSpacing: '1px', color: '#888', marginBottom: '0.5rem' }}>
                LINKEDIN SCRAPED JSON PAYLOAD
              </label>
              <textarea
                className="form-control"
                placeholder='{"key": "value"}'
                value={jsonData}
                onChange={e => setJsonData(e.target.value)}
                style={{ minHeight: '140px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
                <button className="btn btn-accent" style={{ padding: '0.4rem 1.2rem', fontSize: '0.82rem' }} onClick={handleSubmit}>
                  INITIATE SCAN
                </button>
              </div>
            </>
          ) : (
            <div
              ref={termRef}
              style={{
                backgroundColor: '#000', border: '1px solid var(--accent)', padding: '1rem',
                height: '260px', overflowY: 'auto', fontFamily: 'monospace',
                color: 'var(--accent)', fontSize: '0.8rem', borderRadius: '3px',
              }}
            >
              {logs.map((log, i) => <div key={i} style={{ marginBottom: '0.2rem' }}>&gt; {log}</div>)}
              <div style={{ display: 'inline-block', width: '8px', height: '1em', backgroundColor: 'var(--accent)', animation: 'blink 1s step-end infinite' }} />
            </div>
          )}
          {status && (
            <div className="status-message" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>{status}</div>
          )}
        </div>
      )}

      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  )
}

// ─── Provider card (expandable for Ashby / Greenhouse) ───────────────────────

function ProviderCard({ provider }: { provider: typeof PROVIDERS[number] }) {
  const [open, setOpen] = useState(false)
  const expandable = provider.id === 'ashby' || provider.id === 'greenhouse' || provider.id === 'lever'

  return (
    <div className={`provider-card ${expandable ? 'provider-card--expandable' : ''}`}
      id={`provider-${provider.id}`}>
      <div
        className="provider-card-top"
        style={expandable ? { cursor: 'pointer' } : undefined}
        onClick={expandable ? () => setOpen(o => !o) : undefined}
      >
        <div className="provider-logo" style={{ background: provider.color }}>{provider.icon}</div>
        <div className="provider-info">
          <div className="provider-name">{provider.name}</div>
          <div className="provider-type">{provider.type}</div>
        </div>
        <div className="provider-badges">
          <span className="provider-badge-type">{provider.badge}</span>
          <span className={`provider-status provider-status--${provider.status}`}>
            ● {provider.status.toUpperCase()}
          </span>
          {expandable && (
            <span className="provider-chevron">{open ? '▲' : '▼'}</span>
          )}
        </div>
      </div>
      <p className="provider-desc">{provider.description}</p>
      {provider.id === 'ashby' && open && <AshbyPortalPanel />}
      {provider.id === 'greenhouse' && open && <GreenhousePortalPanel />}
      {provider.id === 'lever' && open && <LeverPortalPanel />}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Settings() {
  const [openStep, setOpenStep] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    fetch('http://localhost:8000/api/settings')
      .then(r => r.json())
      .then(setSettings)
      .catch(() => setSettings({
        pipeline: { ai_scoring_enabled: true, ashby_description_fetch_enabled: true, greenhouse_description_fetch_enabled: true },
        scheduler: {
          ashby: { enabled: false, interval_minutes: 60 },
          greenhouse: { enabled: false, interval_minutes: 60 },
          lever: { enabled: false, interval_minutes: 60 },
        },
      }))
  }, [])

  const toggleSetting = async (key: keyof AppSettings['pipeline'], value: boolean) => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    const prev = settings
    setSettings({ ...settings, pipeline: { ...settings.pipeline, [key]: value } })
    try {
      const res = await fetch('http://localhost:8000/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline: { [key]: value } }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSettings(await res.json())
    } catch {
      setSaveError('Failed to save — server unreachable.')
      setSettings(prev)
    } finally {
      setSaving(false)
    }
  }

  const patchScheduler = async (source: 'ashby' | 'greenhouse' | 'lever', patch: { enabled?: boolean; interval_minutes?: number }) => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    const prev = settings
    setSettings({
      ...settings,
      scheduler: {
        ...settings.scheduler,
        [source]: { ...settings.scheduler?.[source], ...patch } as AppSettings['scheduler'][typeof source],
      },
    })
    try {
      const res = await fetch('http://localhost:8000/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduler: { [source]: patch } }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSettings(await res.json())
    } catch {
      setSaveError('Failed to save — server unreachable.')
      setSettings(prev)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (id: string) => setOpenStep(prev => prev === id ? null : id)

  return (
    <div className="settings-page">

      {/* Header */}
      <div className="settings-header">
        <div className="settings-header-left">
          <span className="settings-breadcrumb">SYS_CONFIG /</span>
          <h1 className="settings-title">SETTINGS</h1>
        </div>
        <div className="settings-header-right">
          {saving && <span className="settings-saving">SAVING...</span>}
          {saveError && <span className="settings-save-error">{saveError}</span>}
          <span className="version-tag">JOBVIS v0.1.0-alpha</span>
        </div>
      </div>

      {/* ── PIPELINE SECTION ────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="section-label-row">
          <div className="section-label-line" />
          <span className="section-label">PIPELINE</span>
          <div className="section-label-line" />
        </div>
        <p className="section-desc">
          Full end-to-end flow from data source through evaluation. Two ingestion paths converge before
          entering the shared evaluation pipeline. Click any node to inspect its logic.
        </p>

        {/* ── Two-column ingestion lanes ──────────────────────────────── */}
        <div className="quad-lane">
          {/* ── Ashby lane ── */}
          <div className="lane lane--ashby">
            <div className="lane-header lane-header--ashby">
              <span className="lane-header-badge ashby-badge">API</span>
              <span className="lane-header-name">Ashby HQ</span>
              <span className="lane-header-sub">Server-side GraphQL scrape</span>
            </div>
            <SchedulerControl
              source="ashby"
              settings={settings}
              onToggle={enabled => patchScheduler('ashby', { enabled })}
              onInterval={minutes => patchScheduler('ashby', { interval_minutes: minutes })}
              saving={saving}
            />
            {ASHBY_STEPS.map((step, i) => (
              <div key={step.id}>
                <PipelineStep
                  step={step}
                  index={i}
                  isOpen={openStep === step.id}
                  onToggle={() => toggle(step.id)}
                  settingValue={step.toggleKey ? settings?.pipeline[step.toggleKey] : undefined}
                  onSettingToggle={step.toggleKey ? (val) => toggleSetting(step.toggleKey!, val) : undefined}
                  saving={saving}
                />
                {i < ASHBY_STEPS.length - 1 && <Connector />}
              </div>
            ))}
          </div>

          {/* ── Greenhouse lane ── */}
          <div className="lane lane--greenhouse">
            <div className="lane-header lane-header--greenhouse">
              <span className="lane-header-badge gh-badge">API</span>
              <span className="lane-header-name">Greenhouse</span>
              <span className="lane-header-sub">Server-side REST scrape</span>
            </div>
            <SchedulerControl
              source="greenhouse"
              settings={settings}
              onToggle={enabled => patchScheduler('greenhouse', { enabled })}
              onInterval={minutes => patchScheduler('greenhouse', { interval_minutes: minutes })}
              saving={saving}
            />
            {GREENHOUSE_STEPS.map((step, i) => (
              <div key={step.id}>
                <PipelineStep
                  step={step}
                  index={i}
                  isOpen={openStep === step.id}
                  onToggle={() => toggle(step.id)}
                  settingValue={step.toggleKey ? settings?.pipeline[step.toggleKey] : undefined}
                  onSettingToggle={step.toggleKey ? (val) => toggleSetting(step.toggleKey!, val) : undefined}
                  saving={saving}
                />
                {i < GREENHOUSE_STEPS.length - 1 && <Connector />}
              </div>
            ))}
          </div>

          {/* ── Lever lane ── */}
          <div className="lane lane--lever">
            <div className="lane-header lane-header--lever">
              <span className="lane-header-badge lever-badge">API</span>
              <span className="lane-header-name">Lever</span>
              <span className="lane-header-sub">Server-side REST scrape</span>
            </div>
            <SchedulerControl
              source="lever"
              settings={settings}
              onToggle={enabled => patchScheduler('lever', { enabled })}
              onInterval={minutes => patchScheduler('lever', { interval_minutes: minutes })}
              saving={saving}
            />
            {LEVER_STEPS.map((step, i) => (
              <div key={step.id}>
                <PipelineStep
                  step={step}
                  index={i}
                  isOpen={openStep === step.id}
                  onToggle={() => toggle(step.id)}
                  saving={saving}
                />
                {i < LEVER_STEPS.length - 1 && <Connector />}
              </div>
            ))}
          </div>

          {/* ── LinkedIn lane ── */}
          <div className="lane lane--linkedin">
            <div className="lane-header lane-header--linkedin">
              <span className="lane-header-badge li-badge">SCRAPER</span>
              <span className="lane-header-name">LinkedIn</span>
              <span className="lane-header-sub">Chrome Extension injection</span>
            </div>
            {LINKEDIN_STEPS.map((step, i) => (
              <div key={step.id}>
                <PipelineStep
                  step={step}
                  index={i}
                  isOpen={openStep === step.id}
                  onToggle={() => toggle(step.id)}
                  settingValue={step.toggleKey ? settings?.pipeline[step.toggleKey] : undefined}
                  onSettingToggle={step.toggleKey ? (val) => toggleSetting(step.toggleKey!, val) : undefined}
                  saving={saving}
                  extraContent={step.id === 'li-ext' ? <LinkedInDeepScanPanel /> : undefined}
                />
                {i < LINKEDIN_STEPS.length - 1 && <Connector />}
              </div>
            ))}
          </div>
        </div>

        {/* ── Merge point ── */}
        <div className="merge-point">
          <div className="merge-lines">
            <div className="merge-line merge-line--left" />
            <div className="merge-line merge-line--right" />
          </div>
          <div className="merge-node">
            <span className="merge-node-icon">⬇</span>
            <span className="merge-node-label">EVALUATION PIPELINE</span>
            <span className="merge-node-sub">shared path — all sources</span>
          </div>
        </div>

        {/* ── Shared evaluation pipeline ── */}
        <div className="eval-pipeline">
          {EVAL_STEPS.map((step, i) => (
            <div key={step.id} className="eval-pipeline-item">
              <PipelineStep
                step={step}
                index={i}
                isOpen={openStep === step.id}
                onToggle={() => toggle(step.id)}
                settingValue={step.toggleKey ? settings?.pipeline[step.toggleKey] : undefined}
                onSettingToggle={step.toggleKey ? (val) => toggleSetting(step.toggleKey!, val) : undefined}
                saving={saving}
              />
              {i < EVAL_STEPS.length - 1 && <Connector />}
            </div>
          ))}

          {/* Terminal */}
          <Connector />
          <div className="pipeline-terminal">
            <span>✅</span>
            <span className="pipeline-terminal-label">RESULT</span>
            <span className="pipeline-terminal-sub">Job Card in UI</span>
          </div>
        </div>
      </section>

      {/* ── PROVIDERS SECTION ────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="section-label-row">
          <div className="section-label-line" />
          <span className="section-label">DATA PROVIDERS</span>
          <div className="section-label-line" />
        </div>
        <p className="section-desc">
          Supported job sources JOBVIS currently pulls from.
        </p>

        <div className="providers-grid">
          {PROVIDERS.map(p => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      </section>
    </div>
  )
}
