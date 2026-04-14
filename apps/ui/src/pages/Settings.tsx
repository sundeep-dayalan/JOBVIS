import { useState } from 'react'
import './Settings.css'

// ─── Pipeline Step Data ───────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  {
    id: 'ingest',
    icon: '⬇',
    label: 'INGEST',
    sublabel: 'Job Injection',
    description: 'Raw job payload received from provider (LinkedIn scrape or Ashby API). Mapped to internal schema via dedicated data mappers.',
    color: 'var(--step-ingest)',
    details: ['linkedinDataMapper', 'ashbyDataMapper', 'source_id extraction'],
  },
  {
    id: 'dedup',
    icon: '⊘',
    label: 'DEDUP',
    sublabel: 'Deduplication',
    description: 'O(1) DB lookup against all known source_ids. Existing ACTIVE→ACTIVE and IGNORED→IGNORED jobs are vaporized. Only new or force-rescanned jobs advance.',
    color: 'var(--step-dedup)',
    details: ['DB cache hit check', 'force_rescan support', 'IGNORED→ACTIVE upserts'],
  },
  {
    id: 'title',
    icon: '🔤',
    label: 'TITLE FILTER',
    sublabel: 'Keyword Pre-screen',
    description: 'Title matched against include/exclude keyword lists from filter.yml. Mismatched titles are immediately IGNORED before any expensive processing.',
    color: 'var(--step-title)',
    details: ['include_any keywords', 'exclude_any keywords', 'Case-insensitive match'],
  },
  {
    id: 'jd',
    icon: '📄',
    label: 'JD FILTER',
    sublabel: 'Description Screen',
    description: 'Full job description is inspected using configurable keyword rules. Jobs matching exclusion terms (e.g. "citizenship") are discarded.',
    color: 'var(--step-jd)',
    details: ['Positive keyword gate', 'Exclusion term rejection', 'Missing JD passthrough'],
  },
  {
    id: 'stripper',
    icon: '✂',
    label: 'JD STRIPPER',
    sublabel: 'Noise Reduction',
    description: 'Preprocessor that removes boilerplate, legalese, and filler from job descriptions before LLM token consumption — reducing noise and cost.',
    color: 'var(--step-strip)',
    details: ['strip_jd()', 'Boilerplate removal', 'Token optimisation'],
  },
  {
    id: 'llm',
    icon: '🤖',
    label: 'AI SCORING',
    sublabel: 'LLM Evaluation',
    description: 'Surviving jobs are sent to the configured LLM (Ollama local or cloud). The JobMatchAnalyst prompt evaluates CV fit and returns a JSON score + reason.',
    color: 'var(--step-llm)',
    details: ['temperature=0.0', 'JSON response format', 'Semaphore concurrency'],
  },
  {
    id: 'threshold',
    icon: '⚡',
    label: 'THRESHOLD',
    sublabel: 'Score Gate',
    description: 'AI score compared against threshold (default 2.5/5). Jobs below threshold are marked IGNORED with reason "AI Score < 2.5". High scorers pass.',
    color: 'var(--step-threshold)',
    details: ['Score ≥ 2.5 → ACTIVE', 'Score < 2.5 → IGNORED', 'Configurable threshold'],
  },
  {
    id: 'persist',
    icon: '💾',
    label: 'PERSIST',
    sublabel: 'Database Write',
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
    description: 'Jobs are scraped client-side via the JOBVIS Chrome Extension from LinkedIn job search pages. Raw JSON is POST-ed to /api/deepscan.',
    badge: 'SCRAPER',
    color: '#0a66c2',
  },
  {
    id: 'ashby',
    name: 'Ashby HQ',
    type: 'Server-side API',
    status: 'active',
    icon: 'AQ',
    description: 'Companies tracked in portals.yml are crawled server-side via Ashby\'s public job board API. Listing + description fetched per org slug.',
    badge: 'API',
    color: '#7c3aed',
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function Settings() {
  const [activeStep, setActiveStep] = useState<string | null>(null)

  return (
    <div className="settings-page">
      {/* Page Header */}
      <div className="settings-header">
        <div className="settings-header-left">
          <span className="settings-breadcrumb">SYS_CONFIG /</span>
          <h1 className="settings-title">SETTINGS</h1>
        </div>
        <div className="settings-version">
          <span className="version-tag">JOBVIS v0.1.0-alpha</span>
        </div>
      </div>

      {/* ── PIPELINE SECTION ─────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="section-label-row">
          <div className="section-label-line" />
          <span className="section-label">PIPELINE</span>
          <div className="section-label-line" />
        </div>
        <p className="section-desc">
          Visual representation of every stage a job passes through the moment it is injected into the evaluation pipeline.
          Click any node to inspect its logic.
        </p>

        {/* Flow Diagram */}
        <div className="pipeline-flow">
          {PIPELINE_STEPS.map((step, idx) => (
            <div key={step.id} className="pipeline-flow-item">
              {/* Step node */}
              <button
                className={`pipeline-node ${activeStep === step.id ? 'pipeline-node--active' : ''}`}
                style={{ '--step-color': step.color } as React.CSSProperties}
                onClick={() => setActiveStep(activeStep === step.id ? null : step.id)}
                id={`pipeline-step-${step.id}`}
              >
                <div className="pipeline-node-icon">{step.icon}</div>
                <div className="pipeline-node-body">
                  <div className="pipeline-node-label">{step.label}</div>
                  <div className="pipeline-node-sublabel">{step.sublabel}</div>
                </div>
                <div className="pipeline-node-index">
                  {String(idx + 1).padStart(2, '0')}
                </div>
              </button>

              {/* Connector arrow (between nodes) */}
              {idx < PIPELINE_STEPS.length - 1 && (
                <div className="pipeline-connector">
                  <div className="pipeline-connector-line" />
                  <div className="pipeline-connector-arrow">▼</div>
                </div>
              )}
            </div>
          ))}

          {/* Terminal node */}
          <div className="pipeline-flow-item">
            <div className="pipeline-connector">
              <div className="pipeline-connector-line" />
              <div className="pipeline-connector-arrow">▼</div>
            </div>
            <div className="pipeline-terminal">
              <span className="pipeline-terminal-icon">✅</span>
              <span className="pipeline-terminal-label">RESULT</span>
              <span className="pipeline-terminal-sub">Job Card in UI</span>
            </div>
          </div>
        </div>

        {/* Detail panel — expands when a step is selected */}
        {activeStep && (() => {
          const step = PIPELINE_STEPS.find(s => s.id === activeStep)!
          return (
            <div className="pipeline-detail-panel" style={{ '--step-color': step.color } as React.CSSProperties}>
              <div className="pipeline-detail-header">
                <span className="pipeline-detail-icon">{step.icon}</span>
                <div>
                  <div className="pipeline-detail-title">{step.label}</div>
                  <div className="pipeline-detail-subtitle">{step.sublabel}</div>
                </div>
                <button className="pipeline-detail-close" onClick={() => setActiveStep(null)}>✕</button>
              </div>
              <p className="pipeline-detail-desc">{step.description}</p>
              <div className="pipeline-detail-tags">
                {step.details.map(d => (
                  <span key={d} className="pipeline-detail-tag">{d}</span>
                ))}
              </div>
            </div>
          )
        })()}
      </section>

      {/* ── PROVIDERS SECTION ────────────────────────────────────────────── */}
      <section className="settings-section">
        <div className="section-label-row">
          <div className="section-label-line" />
          <span className="section-label">DATA PROVIDERS</span>
          <div className="section-label-line" />
        </div>
        <p className="section-desc">
          Supported job sources. These are the platforms JOBVIS currently pulls jobs from.
        </p>

        <div className="providers-grid">
          {PROVIDERS.map(p => (
            <div key={p.id} className="provider-card" id={`provider-${p.id}`}>
              <div className="provider-card-top">
                <div className="provider-logo" style={{ background: p.color }}>
                  {p.icon}
                </div>
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
