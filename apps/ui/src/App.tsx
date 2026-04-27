import { API_BASE, WS_BASE } from './config'
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Home from './pages/Home'
import History from './pages/History'
import Settings from './pages/Settings'
import './index.css'

function EnvBanner() {
  const [env, setEnv] = useState<'dev' | 'prod' | null>(null)

  useEffect(() => {
    fetch(API_BASE + '/api/env')
      .then(r => r.json())
      .then(d => setEnv(d.env === 'prod' ? 'prod' : 'dev'))
      .catch(() => setEnv('dev')) // default assume dev if unreachable
  }, [])

  if (env !== 'dev') return null

  return (
    <div style={{
      width: '100%',
      background: 'repeating-linear-gradient(45deg, rgba(251,191,36,0.12), rgba(251,191,36,0.12) 10px, rgba(0,0,0,0) 10px, rgba(0,0,0,0) 20px)',
      borderTop: '1px solid rgba(251,191,36,0.45)',
      borderBottom: '1px solid rgba(251,191,36,0.45)',
      padding: '0.3rem 1.5rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      flexShrink: 0,
    }}>
      <span style={{
        fontSize: '0.6rem',
        fontWeight: 700,
        letterSpacing: '3px',
        color: '#fbbf24',
        background: 'rgba(251,191,36,0.15)',
        border: '1px solid rgba(251,191,36,0.45)',
        padding: '0.15rem 0.55rem',
        borderRadius: '2px',
        animation: 'devPulse 2s ease-in-out infinite alternate',
        flexShrink: 0,
      }}>
        ⚠ DEV MODE
      </span>
      <span style={{ fontSize: '0.72rem', color: 'rgba(251,191,36,0.7)', letterSpacing: '0.5px' }}>
        Connected to <strong style={{ color: '#fbbf24' }}>development</strong> database — changes will NOT affect production data
      </span>
      <style>{`
        @keyframes devPulse {
          from { box-shadow: 0 0 0 rgba(251,191,36,0); }
          to   { box-shadow: 0 0 8px rgba(251,191,36,0.5); }
        }
      `}</style>
    </div>
  )
}

function App() {
  const [env, setEnv] = useState<'dev' | 'prod' | null>(null)

  useEffect(() => {
    fetch(API_BASE + '/api/env')
      .then(r => r.json())
      .then(d => {
        const resolvedEnv = d.env === 'prod' ? 'prod' : 'dev'
        setEnv(resolvedEnv)
        document.title = resolvedEnv === 'dev' ? 'JOBVIS - DEV' : 'JOBVIS'
      })
      .catch(() => {
        setEnv('dev')
        document.title = 'JOBVIS - DEV'
      })
  }, [])

  const isDev = env === 'dev'

  return (
    <Router>
      <div className="layout-container">
        <header
          className="header"
          style={isDev ? {
            borderBottom: '1px solid rgba(251,191,36,0.35)',
            boxShadow: '0 1px 16px rgba(251,191,36,0.08)',
          } : undefined}
        >
          <Link to="/" className="logo" style={isDev ? { color: '#fbbf24', textShadow: '0 0 20px rgba(251,191,36,0.4)' } : undefined}>
            JOBVIS
          </Link>
          <nav style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {isDev && (
              <span style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '2px',
                color: '#fbbf24',
                background: 'rgba(251,191,36,0.12)',
                border: '1px solid rgba(251,191,36,0.4)',
                padding: '0.2rem 0.6rem',
                borderRadius: '2px',
              }}>
                DEV
              </span>
            )}
            <Link to="/history" className="btn" style={{ marginRight: '0' }}>
              HISTORY
            </Link>
            <Link to="/settings" className="btn">
              SETTINGS
            </Link>
          </nav>
        </header>

        <EnvBanner />

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </Router>
  )
}

export default App
