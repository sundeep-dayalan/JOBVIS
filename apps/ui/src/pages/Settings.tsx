import { useState, useEffect } from 'react'
import './Settings.css'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppSettings {
  pipeline: {
    ai_scoring_enabled: boolean
    ashby_description_fetch_enabled: boolean
  }
  scheduler: {
    ashby: {
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
    details: ['config/portals.yml', 'enabled: true filter', 'org_slug extraction'],
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
  settings,
  onToggle,
  onInterval,
  saving,
}: {
  settings: AppSettings | null
  onToggle: (enabled: boolean) => void
  onInterval: (minutes: number) => void
  saving: boolean
}) {
  const enabled = settings?.scheduler?.ashby?.enabled ?? false
  const interval = settings?.scheduler?.ashby?.interval_minutes ?? 60

  // ── Live timing state (polled from backend every 5s) ─────────────────────
  const [nextRunAt, setNextRunAt] = useState<number | null>(null)       // epoch ms
  const [sleepDuration, setSleepDuration] = useState<number | null>(null) // seconds
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
          const ashby = data?.tasks?.ashby
          if (!ashby) return
          setNextRunAt(ashby.next_run_at ? ashby.next_run_at * 1000 : null)
          setSleepDuration(ashby.sleep_duration_secs ?? null)
          setJobRunning(ashby.state === 'running')
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [enabled])

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
      await fetch('http://localhost:8000/api/scheduler/trigger/ashby', { method: 'POST' })
      // Immediately wipe the countdown — it'll repopulate from the next status poll
      setNextRunAt(null)
      setCountdown('')
      setProgress(0)
      setJobRunning(true)
      // Poll status after a short delay to get the updated state
      setTimeout(() => {
        fetch('http://localhost:8000/api/scheduler/status')
          .then(r => r.json())
          .then(data => {
            const ashby = data?.tasks?.ashby
            if (ashby) {
              setNextRunAt(ashby.next_run_at ? ashby.next_run_at * 1000 : null)
              setSleepDuration(ashby.sleep_duration_secs ?? null)
              setJobRunning(ashby.state === 'running')
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
          id="toggle-ashby-scheduler"
          className={`toggle-sw ${enabled ? 'toggle-sw--on' : 'toggle-sw--off'}`}
          style={{ '--step-color': 'var(--step-ashby-5)' } as React.CSSProperties}
          onClick={() => onToggle(!enabled)}
          disabled={saving}
          aria-label="Toggle Ashby scheduler"
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
                  id="btn-run-now"
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
            id="btn-run-once"
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
                id={`interval-${opt.minutes}`}
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
}: {
  step: FlowStep
  index: number
  isOpen: boolean
  onToggle: () => void
  settingValue?: boolean
  onSettingToggle?: (val: boolean) => void
  saving: boolean
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
        pipeline: { ai_scoring_enabled: true, ashby_description_fetch_enabled: true },
        scheduler: { ashby: { enabled: false, interval_minutes: 60 } },
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

  const patchScheduler = async (patch: { enabled?: boolean; interval_minutes?: number }) => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    const prev = settings
    setSettings({
      ...settings,
      scheduler: {
        ashby: { ...settings.scheduler?.ashby, ...patch } as AppSettings['scheduler']['ashby'],
      },
    })
    try {
      const res = await fetch('http://localhost:8000/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduler: { ashby: patch } }),
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
        <div className="ingestion-label-row">
          <div className="lane-header lane-header--ashby">
            <span className="lane-header-badge ashby-badge">API</span>
            <span className="lane-header-name">Ashby HQ</span>
            <span className="lane-header-sub">Server-side GraphQL scrape</span>
          </div>
          <div className="lane-divider" />
          <div className="lane-header lane-header--linkedin">
            <span className="lane-header-badge li-badge">SCRAPER</span>
            <span className="lane-header-name">LinkedIn</span>
            <span className="lane-header-sub">Chrome Extension injection</span>
          </div>
        </div>

        <div className="dual-lane">
          {/* ── Ashby lane ── */}
          <div className="lane lane--ashby">
            <SchedulerControl
              settings={settings}
              onToggle={enabled => patchScheduler({ enabled })}
              onInterval={minutes => patchScheduler({ interval_minutes: minutes })}
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

          {/* ── LinkedIn lane ── */}
          <div className="lane lane--linkedin">
            {LINKEDIN_STEPS.map((step, i) => (
              <div key={step.id}>
                <PipelineStep
                  step={step}
                  index={i}
                  isOpen={openStep === step.id}
                  onToggle={() => toggle(step.id)}
                  saving={saving}
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
            <div key={p.id} className="provider-card" id={`provider-${p.id}`}>
              <div className="provider-card-top">
                <div className="provider-logo" style={{ background: p.color }}>{p.icon}</div>
                <div className="provider-info">
                  <div className="provider-name">{p.name}</div>
                  <div className="provider-type">{p.type}</div>
                </div>
                <div className="provider-badges">
                  <span className="provider-badge-type">{p.badge}</span>
                  <span className={`provider-status provider-status--${p.status}`}>
                    ● {p.status.toUpperCase()}
                  </span>
                </div>
              </div>
              <p className="provider-desc">{p.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
