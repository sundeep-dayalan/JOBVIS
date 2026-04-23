import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import Home from './pages/Home'
import DeepScan from './pages/DeepScan'
import History from './pages/History'
import Settings from './pages/Settings'
import './index.css'

function App() {
  return (
    <Router>
      <div className="layout-container">
        <header className="header">
          <Link to="/" className="logo">
            JOBVIS-PROD
          </Link>
          <nav>
            <Link to="/history" className="btn" style={{ marginRight: '1rem' }}>
              HISTORY
            </Link>
            <Link to="/settings" className="btn" style={{ marginRight: '1rem' }}>
              SETTINGS
            </Link>
            <Link to="/deep-scan" className="btn btn-accent">
              DEEP SCAN_
            </Link>
          </nav>
        </header>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/deep-scan" element={<DeepScan />} />
          </Routes>
        </main>
      </div>
    </Router>
  )
}

export default App
