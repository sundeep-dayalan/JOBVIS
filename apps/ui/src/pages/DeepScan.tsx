import { API_BASE, WS_BASE } from '../config'
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

function DeepScan() {
  const [jsonData, setJsonData] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  
  const wsRef = useRef<WebSocket | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    // Auto scroll the terminal log to the bottom
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    // Cleanup socket on unmount
    return () => wsRef.current?.close()
  }, [])

  const handleSubmit = async () => {
    if (!jsonData.trim()) {
      setStatus('ERROR: PLEASE ENTER JSON DATA')
      return
    }

    try {
      const parsedData = JSON.parse(jsonData)
      
      setLoading(true)
      setStatus(null)
      setLogs(["[SYSTEM] Opening telemetry socket to backend..."])

      // Initialize the WebSocket connection tracking this scan
      const ws = new WebSocket(WS_BASE + "/ws/deepscan")
      wsRef.current = ws
      
      ws.onopen = async () => {
          setLogs(prev => [...prev, "[SYSTEM] Socket connected. Transmitting Deep Scan payload..."])
          
          try {
              const response = await fetch(API_BASE + '/api/deepscan', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ jobs: parsedData })
              })
        
              if (!response.ok) {
                setStatus(`ERROR: BACKEND RETURNED ${response.status}`)
                setLoading(false)
                ws.close()
              } else {
                setJsonData('') 
              }
          } catch (err) {
              setStatus('ERROR: POST FAILED')
              setLoading(false)
              ws.close()
          }
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          setLogs(prev => [...prev, data.message])
          
          if (data.type === "complete") {
            setTimeout(() => {
              navigate('/')
            }, 3000)
          }
        } catch (e) {
          // ignore parsing error
        }
      }
      
      ws.onerror = () => {
          setStatus('ERROR: SOCKET CONNECTION FAILED')
          setLoading(false)
      }

    } catch (err) {
      setStatus('ERROR: INVALID JSON OR CONNECTION FAILED')
      setLoading(false)
      wsRef.current?.close()
    }
  }

  return (
    <div className="panel">
      <h2 style={{ marginBottom: '1.5rem', color: 'var(--accent)' }}>
        /// DEEP SCAN MODULE
      </h2>
      
      {!loading ? (
        <div className="form-group">
          <label htmlFor="jsonInput">Linkedin Jobs scrapped json</label>
          <textarea 
            id="jsonInput"
            className="form-control"
            placeholder='{"key": "value"}'
            value={jsonData}
            onChange={(e) => setJsonData(e.target.value)}
          />
        </div>
      ) : (
        <div 
          ref={terminalRef}
          style={{
            backgroundColor: '#000',
            border: '1px solid var(--accent)',
            padding: '1.5rem',
            height: '400px',
            overflowY: 'auto',
            fontFamily: 'monospace',
            color: 'var(--accent)',
            marginBottom: '1.5rem'
          }}
        >
          {logs.map((log, index) => (
            <div key={index} style={{ marginBottom: '0.25rem' }}>
              {'>'} {log}
            </div>
          ))}
          <div style={{ display: 'inline-block', width: '10px', height: '1em', backgroundColor: 'var(--accent)', animation: 'blink 1s step-end infinite' }}></div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button 
          className="btn" 
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? 'SCANNING...' : 'INITIATE SCAN'}
        </button>
      </div>

      {status && (
        <div className="status-message">
          {status}
        </div>
      )}

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}

export default DeepScan
