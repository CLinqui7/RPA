import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Inbox, RefreshCcw, CheckCircle2, AlertCircle, Mail } from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

function formatDate(value) {
  if (!value) return 'Sin fecha';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function Badge({ children, type = 'neutral' }) {
  return <span className={`badge ${type}`}>{children}</span>;
}

function App() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanLog, setScanLog] = useState('');
  const [error, setError] = useState('');

  async function loadEvents() {
    const res = await fetch(`${API_URL}/events`);
    if (!res.ok) throw new Error('No se pudieron cargar los eventos');
    setEvents(await res.json());
  }

  async function runScan() {
    setLoading(true);
    setError('');
    setScanLog('Ejecutando RPA...');
    try {
      const res = await fetch(`${API_URL}/run-scan`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error ejecutando RPA');
      setScanLog(`Revisión terminada. Leídos: ${data.run.scanned_count}. Nuevos: ${data.run.inserted_count}.`);
      await loadEvents();
    } catch (e) {
      setError(e.message);
      setScanLog('');
    } finally {
      setLoading(false);
    }
  }

  async function mark(id, status) {
    await fetch(`${API_URL}/events/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    await loadEvents();
  }

  useEffect(() => { loadEvents().catch(e => setError(e.message)); }, []);

  const stats = useMemo(() => {
    const newCount = events.filter(e => e.status === 'new').length;
    const responses = events.filter(e => e.message_type === 'response').length;
    const orders = events.filter(e => e.message_type === 'order').length;
    return { newCount, responses, orders, total: events.length };
  }, [events]);

  return (
    <main className="app">
      <section className="hero">
        <div>
          <p className="eyebrow">Outlook RPA Monitor</p>
          <h1>Dashboard de órdenes y respuestas</h1>
          <p className="sub">Revisa el Outlook monitor, filtra correos de órdenes y guarda alertas en Supabase.</p>
        </div>
        <button className="primary" disabled={loading} onClick={runScan}>
          <RefreshCcw size={18} className={loading ? 'spin' : ''} />
          {loading ? 'Ejecutando...' : 'Ejecutar revisión Outlook'}
        </button>
      </section>

      <section className="cards">
        <div className="card urgent"><Bell/><span>{stats.newCount}</span><p>Alertas nuevas</p></div>
        <div className="card"><Mail/><span>{stats.responses}</span><p>Respuestas detectadas</p></div>
        <div className="card"><Inbox/><span>{stats.orders}</span><p>Órdenes detectadas</p></div>
        <div className="card"><CheckCircle2/><span>{stats.total}</span><p>Total registros</p></div>
      </section>

      {scanLog && <div className="notice ok">{scanLog}</div>}
      {error && <div className="notice error"><AlertCircle size={18}/>{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2>Bandeja operativa</h2>
          <button className="secondary" onClick={() => loadEvents().catch(e => setError(e.message))}>Actualizar</button>
        </div>

        <div className="table">
          {events.length === 0 ? (
            <div className="empty">Todavía no hay eventos. Ejecuta la primera revisión.</div>
          ) : events.map(event => (
            <article className={`row ${event.status === 'new' ? 'is-new' : ''}`} key={event.id}>
              <div className="row-main">
                <div className="row-title">
                  <strong>{event.subject || 'Sin asunto'}</strong>
                  {event.status === 'new' && <Badge type="red">Nuevo</Badge>}
                  <Badge>{event.message_type}</Badge>
                  {event.po_number && <Badge type="blue">PO {event.po_number}</Badge>}
                </div>
                <p>{event.snippet || event.body_text || 'Sin vista previa'}</p>
                <small>{event.sender_email || event.sender_name || 'Remitente desconocido'} · {formatDate(event.created_at)}</small>
              </div>
              <div className="actions">
                <button onClick={() => mark(event.id, 'reviewed')}>Revisado</button>
                <button onClick={() => mark(event.id, 'closed')}>Cerrar</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
