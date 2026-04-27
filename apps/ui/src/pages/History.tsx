import { API_BASE, WS_BASE } from '../config'
import { useEffect, useState } from 'react';

function History() {
  const [scans, setScans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchScans = () => {
    setLoading(true);
    fetch(API_BASE + '/api/scans')
      .then(res => res.json())
      .then(data => setScans(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchScans();
  }, []);

  const handleDelete = (id: string) => {
    if(!confirm("Destroy this entire scan? All dynamically related child jobs will be purged immediately.")) return;
    
    fetch(`${API_BASE}/api/scans/${id}`, { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if(data.status === 'success') fetchScans();
      })
      .catch(console.error);
  };

  return (
    <div className="history-container">
      <h2 style={{ marginBottom: '2rem', color: 'var(--text-main)' }}>/// SCAN ARCHIVE</h2>
      {loading && <p>FETCHING DATA LOGS...</p>}
      
      {!loading && scans.length === 0 && <p>NO ARCHIVAL SCANS FOUND.</p>}
      
      {!loading && scans.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Scan ID</th>
              <th>Date Performed</th>
              <th>System Source</th>
              <th>Total Processed</th>
              <th>Active Result</th>
              <th>Ignored</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {scans.map(scan => {
              const meta = (scan.source_meta && scan.source_meta.length > 0) ? scan.source_meta[0] : null;

              return (
                <tr key={scan.id}>
                  <td style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{scan.id.split('-')[0]}...</td>
                  <td>{new Date(scan.created_at).toLocaleString()}</td>
                  <td style={{ textTransform: 'uppercase' }}>{meta ? meta.source : 'UNKNOWN'}</td>
                  
                  <td style={{ color: 'var(--accent)', fontWeight: 'bold' }}>{scan.total_jobs_scanned}</td>
                  
                  <td style={{ color: '#00ffcc', fontWeight: 'bold' }}>{meta ? meta.total_active : scan.total_jobs_saved - scan.total_ignored}</td>
                  <td style={{ color: '#ff4444' }}>{scan.total_ignored}</td>
                  <td>
                    <button onClick={() => handleDelete(scan.id)} className="btn" style={{ padding: '0.3rem 0.8rem', fontSize: '0.7rem', border: '1px solid #ff4444', color: '#ff4444' }}>
                      DESTROY
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default History;
