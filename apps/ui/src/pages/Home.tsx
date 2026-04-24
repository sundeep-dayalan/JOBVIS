import { useEffect, useState } from 'react';

export type JobStatusEnum = 'ACTIVE' | 'IGNORED' | 'ALL';

export interface IAIAnalysis {
  score?: number;
  reason?: string;
}

export interface IJobPosition {
  id: string;
  title: string;
  company_name: string;
  location?: string;
  source_url?: string;
  apply_url?: string;
  job_posted_at?: string;
  job_updated_at?: string;
  source?: string;
  status: JobStatusEnum;
  ignore_reason?: string;
  description?: string;
  ai_score?: number;
  ai_analysis?: IAIAnalysis;
}

function Home() {
  const [jobs, setJobs] = useState<IJobPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatusEnum>('ACTIVE');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedRescanIds, setSelectedRescanIds] = useState<Set<string>>(new Set());
  const [isRescanning, setIsRescanning] = useState(false);
  const [isMovingStatus, setIsMovingStatus] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAshbyScanning, setIsAshbyScanning] = useState(false);
  const [ashbyMessage, setAshbyMessage] = useState<string | null>(null);

  const fetchJobsData = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/jobs');
      if (!res.ok) throw new Error('Response not okay');
      const data = await res.json();
      const jobsArr = Array.isArray(data) ? data : [];
      setJobs(jobsArr);
    } catch (err) {
      setError('Failed to connect to backend database.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobsData();
  }, []);

  const bulkMoveStatus = async (targetStatus: 'ACTIVE' | 'IGNORED') => {
    if (selectedRescanIds.size === 0 || isMovingStatus) return;
    setIsMovingStatus(true);
    try {
      await fetch('http://localhost:8000/api/jobs/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_ids: Array.from(selectedRescanIds),
          status: targetStatus,
          reason: targetStatus === 'IGNORED' ? 'Manually ignored' : null,
        }),
      });
      setSelectedRescanIds(new Set());
      await fetchJobsData();
    } catch (e) {
      console.error('Bulk move status err:', e);
    } finally {
      setIsMovingStatus(false);
    }
  };

  const bulkDeleteJobs = async () => {
    if (selectedRescanIds.size === 0 || isDeleting) return;
    const confirmed = window.confirm(
      `Permanently delete ${selectedRescanIds.size} job(s)? This cannot be undone.`
    );
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      await fetch('http://localhost:8000/api/jobs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: Array.from(selectedRescanIds) }),
      });
      setSelectedRescanIds(new Set());
      await fetchJobsData();
    } catch (e) {
      console.error('Bulk delete err:', e);
    } finally {
      setIsDeleting(false);
    }
  };

  // Update selected job automatically if filter or items totally change
  useEffect(() => {
    const activeJobs = jobs.filter(job => job.status === statusFilter);
    if (activeJobs.length > 0) {
      setSelectedJobId(activeJobs[0].id);
    } else {
      setSelectedJobId(null);
    }
  }, [statusFilter, jobs]);

  useEffect(() => {
    setSelectedRescanIds(new Set());
  }, [statusFilter]);

  const filteredJobs = statusFilter === 'ALL' ? jobs : jobs.filter(job => job.status === statusFilter);
  const selectedJob = filteredJobs.find(job => job.id === selectedJobId) || null;

  return (
    <div className="home-container" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Header Top Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexShrink: 0 }}>
        <h2 style={{ color: 'var(--text-main)', margin: 0 }}>/// JOBS</h2>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <>
            <button
              className="btn"
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
              onClick={() => {
                if (selectedRescanIds.size === filteredJobs.length && filteredJobs.length > 0) {
                  setSelectedRescanIds(new Set());
                } else {
                  setSelectedRescanIds(new Set(filteredJobs.map(j => j.id)));
                }
              }}
            >
              {selectedRescanIds.size === filteredJobs.length && filteredJobs.length > 0 ? 'DESELECT ALL' : 'SELECT ALL'}
            </button>

            <button
              className="btn btn-accent"
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', opacity: selectedRescanIds.size === 0 ? 0.5 : 1 }}
              disabled={selectedRescanIds.size === 0 || isRescanning}
              onClick={async () => {
                if (selectedRescanIds.size === 0) return;
                setIsRescanning(true);
                try {
                  await fetch('http://localhost:8000/api/rescan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_ids: Array.from(selectedRescanIds) })
                  });
                  setSelectedRescanIds(new Set());
                  await fetchJobsData();
                } catch (e) {
                  console.error("Rescan err:", e);
                } finally {
                  setIsRescanning(false);
                }
              }}
            >
              {isRescanning ? 'INITIALIZING...' : `RE-SCAN STRATEGY (${selectedRescanIds.size})`}
            </button>

            {/* ── Bulk Move Status ──────────────────────────────────── */}
            {selectedRescanIds.size > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <span style={{ color: '#555', fontSize: '0.8rem', letterSpacing: '1px', userSelect: 'none' }}>MOVE TO →</span>
                <button
                  className="btn"
                  style={{
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.82rem',
                    borderColor: '#22c55e',
                    color: '#4ade80',
                    opacity: isMovingStatus ? 0.5 : 1,
                  }}
                  disabled={isMovingStatus}
                  onClick={() => bulkMoveStatus('ACTIVE')}
                >
                  {isMovingStatus ? '...' : 'ACTIVE'}
                </button>
                <button
                  className="btn"
                  style={{
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.82rem',
                    borderColor: '#ef4444',
                    color: '#f87171',
                    opacity: isMovingStatus ? 0.5 : 1,
                  }}
                  disabled={isMovingStatus}
                  onClick={() => bulkMoveStatus('IGNORED')}
                >
                  {isMovingStatus ? '...' : 'IGNORED'}
                </button>

                {/* ── Divider ── */}
                <span style={{ color: '#333', fontSize: '0.8rem', padding: '0 0.15rem', userSelect: 'none' }}>|</span>

                {/* ── Delete ── */}
                <button
                  className="btn"
                  style={{
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.82rem',
                    borderColor: '#dc2626',
                    color: '#ef4444',
                    background: 'rgba(220, 38, 38, 0.08)',
                    opacity: isDeleting ? 0.5 : 1,
                    fontWeight: 'bold',
                    letterSpacing: '1px',
                  }}
                  disabled={isDeleting}
                  onClick={bulkDeleteJobs}
                >
                  {isDeleting ? 'DELETING...' : `DELETE (${selectedRescanIds.size})`}
                </button>
              </div>
            )}
          </>

          {/* Ashby Scan Button */}
          <button
            className="btn"
            style={{
              padding: '0.4rem 0.8rem',
              fontSize: '0.85rem',
              borderColor: isAshbyScanning ? 'var(--accent)' : '#6c63ff',
              color: isAshbyScanning ? 'var(--accent)' : '#a78bfa',
              opacity: isAshbyScanning ? 0.7 : 1,
              position: 'relative',
            }}
            disabled={isAshbyScanning}
            onClick={async () => {
              setIsAshbyScanning(true);
              setAshbyMessage(null);
              try {
                const res = await fetch('http://localhost:8000/api/scrape/ashby', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                });
                const data = await res.json();
                const count = data.total_processed ?? data.total_saved ?? 0;
                setAshbyMessage(`ASHBY: ${count} jobs ingested`);
                await fetchJobsData();
              } catch (e) {
                console.error('Ashby scan err:', e);
                setAshbyMessage('ASHBY SCAN FAILED');
              } finally {
                setIsAshbyScanning(false);
                setTimeout(() => setAshbyMessage(null), 4000);
              }
            }}
          >
            {isAshbyScanning ? 'SCANNING ASHBY...' : 'SCAN ASHBY_'}
          </button>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as JobStatusEnum)}
            style={{
              background: 'rgba(0, 0, 0, 0.8)',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              padding: '0.5rem 1rem',
              outline: 'none',
              textTransform: 'uppercase',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            <option value="ALL">VIEW ALL</option>
            <option value="ACTIVE">VIEW ACTIVE</option>
            <option value="IGNORED">VIEW IGNORED</option>
          </select>
        </div>
        {/* Toolbar End */}
      </div>

      {/* Ashby scan feedback toast */}
      {ashbyMessage && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.5rem 1rem',
          background: 'rgba(108, 99, 255, 0.15)',
          border: '1px solid #6c63ff',
          color: '#a78bfa',
          fontSize: '0.85rem',
          letterSpacing: '1px',
          flexShrink: 0,
        }}>
          {ashbyMessage}
        </div>
      )}

      {loading && <p>SCANNING LOCAL RECORDS...</p>}
      {error && <div className="status-message">{error}</div>}

      {!loading && !error && filteredJobs.length === 0 && (
        <p>NO RECORDS FOUND FOR THIS FILTER. PROCEED TO DEEP SCAN.</p>
      )}

      {/* Dual Pane Layout Element */}
      {!loading && !error && filteredJobs.length > 0 && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: '2rem' }}>

          {/* Left Pane (Scrollable Feed) */}
          <div style={{ width: '35%', display: 'flex', flexDirection: 'column', overflowY: 'auto', gap: '1rem', paddingRight: '0.5rem' }}>
            {filteredJobs.map(job => (
              <div
                key={job.id}
                onClick={() => setSelectedJobId(job.id)}
                style={{
                  padding: '1.25rem',
                  border: `1px solid ${selectedJobId === job.id ? 'var(--text-main)' : 'var(--border-color)'}`,
                  background: selectedJobId === job.id ? 'linear-gradient(135deg, rgba(102,252,241,0.1), transparent)' : 'rgba(11, 12, 16, 0.6)',
                  backdropFilter: 'blur(10px)',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  opacity: job.status === 'IGNORED' ? 0.6 : 1,
                  borderLeft: selectedJobId === job.id ? '4px solid var(--text-main)' : '1px solid var(--border-color)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', color: selectedJobId === job.id ? 'var(--text-main)' : 'var(--text-dim)', fontWeight: 'bold', fontSize: '1.1rem', paddingRight: '1rem' }}>

                    <div onClick={(e) => {
                      e.stopPropagation();
                      const next = new Set(selectedRescanIds);
                      if (next.has(job.id)) next.delete(job.id);
                      else next.add(job.id);
                      setSelectedRescanIds(next);
                    }} style={{
                      marginRight: '0.6rem',
                      marginTop: '0.1rem',
                      width: '18px',
                      height: '18px',
                      flexShrink: 0,
                      border: '1px solid var(--accent)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: selectedRescanIds.has(job.id) ? 'var(--accent)' : 'transparent',
                      color: '#000',
                      fontSize: '0.8rem',
                      cursor: 'pointer'
                    }}>
                      {selectedRescanIds.has(job.id) && '✓'}
                    </div>

                    <div>{job.title}</div>
                  </div>
                  {job.ai_score != null && (
                    <div style={{
                      color: job.ai_score >= 75 ? 'var(--text-main)' : job.ai_score >= 50 ? 'var(--accent)' : '#ff5555',
                      fontWeight: 'bold',
                      fontSize: '1rem',
                      background: 'var(--panel-bg)',
                      padding: '0.2rem 0.6rem',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      boxShadow: job.ai_score >= 75 ? 'var(--glow)' : 'none',
                      flexShrink: 0
                    }}>
                      {job.ai_score}
                    </div>
                  )}
                </div>
                <div style={{ color: 'var(--accent)', marginBottom: '0.25rem', fontSize: '0.9rem' }}>{job.company_name}</div>
                <div style={{ fontSize: '0.85rem', color: '#888' }}>{job.location || 'UNKNOWN'}</div>

                {job.status === 'IGNORED' && job.ignore_reason && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.5rem', fontStyle: 'italic' }}>
                    [REASON] {job.ignore_reason}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Right Pane (Deep Dive AI Telemetry Panel) */}
          <div style={{ flex: 1, border: '1px solid var(--border-color)', padding: '2rem', overflowY: 'auto', background: 'var(--panel-bg)', backdropFilter: 'blur(15px)', position: 'relative' }}>
            {selectedJob ? (
              <div>
                {/* Header Profile */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
                  <div>
                    <h1 style={{ color: 'var(--text-main)', margin: '0 0 0.5rem 0', fontSize: '1.8rem' }}>{selectedJob.title}</h1>
                    <div style={{ fontSize: '1.2rem', color: 'var(--accent)', marginBottom: '0.5rem', fontWeight: 'bold' }}>{selectedJob.company_name}</div>
                    <div style={{ color: '#aaa', fontSize: '0.9rem' }}>{selectedJob.location || 'Location Not Provided'} • {selectedJob.source}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {selectedJob.source_url && (
                      <a href={selectedJob.source_url} target="_blank" rel="noreferrer" className="btn" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                        ORIGINAL POST
                      </a>
                    )}
                    {selectedJob.apply_url && (
                      <a href={selectedJob.apply_url} target="_blank" rel="noreferrer" className="btn btn-accent" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                        QUICK APPLY
                      </a>
                    )}
                  </div>
                </div>

                {/* Job Metadata Bar */}
                {(selectedJob.job_posted_at || selectedJob.job_updated_at) && (
                  <div style={{ borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', padding: '0.8rem 0', marginBottom: '2rem', display: 'flex', gap: '2rem', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
                    {selectedJob.job_posted_at && <div><span style={{ color: '#888' }}>POSTED:</span> {selectedJob.job_posted_at}</div>}
                    {selectedJob.job_updated_at && <div><span style={{ color: '#888' }}>UPDATED:</span> {selectedJob.job_updated_at}</div>}
                  </div>
                )}

                {/* AI Core Evaluation */}
                {selectedJob.ai_analysis ? (
                  <div style={{ border: '1px dashed var(--border-color)', padding: '1.5rem', marginBottom: '2.5rem', background: 'rgba(102, 252, 241, 0.05)', borderRadius: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                      <h3 style={{ margin: 0, color: 'var(--text-main)', letterSpacing: '1px' }}>/// AI ANALYSIS</h3>
                      <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: selectedJob.ai_score >= 75 ? 'var(--text-main)' : selectedJob.ai_score >= 50 ? 'var(--accent)' : '#ff5555', textShadow: selectedJob.ai_score >= 75 ? 'var(--glow)' : 'none' }}>
                        SCORE: {selectedJob.ai_score}/5
                      </div>
                    </div>

                    {selectedJob.ai_analysis.reason && (
                      <div style={{ padding: '1rem', background: 'rgba(0,0,0,0.3)', borderLeft: '3px solid var(--text-main)', color: '#fff', fontStyle: 'italic', fontSize: '1.1rem' }}>
                        "{selectedJob.ai_analysis.reason}"
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ border: '1px dashed #555', padding: '1rem', marginBottom: '2.5rem', color: '#888', textAlign: 'center' }}>
                    [NO AI ANALYSIS AVAILABLE FOR THIS RECORD]
                  </div>
                )}

                {/* Raw Readout */}
                <div style={{ marginTop: '3rem' }}>
                  <h3 style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.8rem', color: 'var(--text-main)', marginBottom: '1.5rem', letterSpacing: '1px' }}>RAW DESCRIPTION</h3>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.8', color: '#ccc', fontSize: '1.05rem', fontFamily: 'var(--font-family)' }}>
                    {selectedJob.description || '[Description unavailable]'}
                  </div>
                </div>

              </div>
            ) : (
              <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
                NO JOB SELECTED
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default Home
