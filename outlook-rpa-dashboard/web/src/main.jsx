import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  Inbox,
  LayoutDashboard,
  LogOut,
  MailCheck,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserRound,
  X
} from 'lucide-react';
import './styles.css';

const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

const USERS = [
  { id: 'admin', name: 'Admin Operativo', role: 'admin', password: 'admin123', aliases: ['admin'] },
  { id: 'carlos', name: 'Carlos Linqui', role: 'user', password: 'carlos123', aliases: ['carlos', 'carlos linqui', 'linqui', '@carlos', 'linquicarloss@gmail.com', 'carlos.linqui@axnygroup.com'] },
  { id: 'routing', name: 'Routing', role: 'user', password: 'routing123', aliases: ['routing', '@routing', 'routing@axnygroup.com'] },
  { id: 'warehouse', name: 'Warehouse', role: 'user', password: 'warehouse123', aliases: ['warehouse', '@warehouse', 'bodega'] },
  { id: 'shipping', name: 'Shipping', role: 'user', password: 'shipping123', aliases: ['shipping', '@shipping'] }
];

const NAV_ITEMS = [
  { id: 'today', label: 'Hoy', icon: LayoutDashboard, helper: 'Prioridad del día' },
  { id: 'unanswered', label: 'Sin respuesta', icon: Clock3, helper: 'Requiere seguimiento' },
  { id: 'urgent', label: 'Urgentes', icon: Bell, helper: 'Urgente o fecha crítica' },
  { id: 'orders', label: 'Órdenes', icon: Inbox, helper: 'PO/PT y adjuntos' },
  { id: 'responses', label: 'Respondidos', icon: MailCheck, helper: 'Con respuesta detectada' },
  { id: 'all', label: 'Todos', icon: CheckCircle2, helper: 'Vista completa' }
];

function normalize(value = '') {
  return String(value).toLowerCase().trim();
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  try {
    return new Date(value).toLocaleString('es-SV', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value;
  }
}

function getAnalysis(event) {
  return event.analysis || event.raw?.analysis || {};
}

function isClosed(event) {
  return event.status === 'closed';
}

function isAwaiting(event) {
  const analysis = getAnalysis(event);
  return !isClosed(event) && analysis.responseStatus === 'awaiting_response';
}

function isUrgent(event) {
  const analysis = getAnalysis(event);
  return !isClosed(event) && analysis.priority === 'high';
}

function isOrder(event) {
  const analysis = getAnalysis(event);
  return analysis.messageType === 'order' || event.message_type === 'order';
}

function isResponse(event) {
  const analysis = getAnalysis(event);
  return analysis.messageType === 'response' || analysis.responseStatus === 'responded' || event.message_type === 'response';
}

function matchesUser(event, user) {
  if (!user || user.role === 'admin') return true;
  const analysis = getAnalysis(event);
  const haystack = [
    event.sender_email,
    event.sender_name,
    event.operator_name,
    analysis.operatorName,
    analysis.assignmentLabel,
    ...(analysis.explicitMentionHandles || []),
    ...(analysis.assignedTo || []).map(person => `${person.id} ${person.name} ${person.email || ''}`),
    analysis.summary,
    event.snippet,
    event.body_text
  ].join(' ').toLowerCase();

  return user.aliases.some(alias => haystack.includes(alias.toLowerCase())) || isUrgent(event);
}

function statusInfo(event) {
  const analysis = getAnalysis(event);
  if (event.status === 'closed') return { label: 'Cerrado', className: 'closed' };
  if (analysis.responseStatus === 'awaiting_response') return { label: 'Sin respuesta', className: 'pending' };
  if (analysis.responseStatus === 'responded') return { label: 'Respondido', className: 'done' };
  if (analysis.priority === 'high') return { label: 'Urgente', className: 'urgent' };
  return { label: 'Revisar', className: 'review' };
}

function Badge({ children, tone = 'default' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    const user = USERS.find(candidate => candidate.id === normalize(username) && candidate.password === password);
    if (!user) {
      setError('Usuario o contraseña incorrecta');
      return;
    }
    localStorage.setItem('rpaUser', JSON.stringify(user));
    onLogin(user);
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">Outlook RPA Monitor</p>
        <h1>Centro operativo</h1>
        <p>Admin ve toda la bandeja. Cada usuario ve lo urgente y lo que aparece asignado con @.</p>
        <form onSubmit={submit} className="login-form">
          <label>Usuario<input value={username} onChange={e => setUsername(e.target.value)} /></label>
          <label>Contraseña<input value={password} onChange={e => setPassword(e.target.value)} type="password" /></label>
          {error && <div className="notice error"><AlertTriangle size={16}/>{error}</div>}
          <button className="primary" type="submit"><ShieldCheck size={18}/> Entrar</button>
        </form>
        <div className="demo-users">
          <span>admin/admin123</span>
          <span>carlos/carlos123</span>
          <span>routing/routing123</span>
        </div>
      </section>
    </main>
  );
}

function CompactEvent({ event, selected, onSelect, onMark }) {
  const analysis = getAnalysis(event);
  const status = statusInfo(event);
  const title = analysis.displayTitle || analysis.cleanSubject || event.subject || 'Correo operativo';
  const important = (analysis.importantReasons || []).slice(0, 2);
  const assignment = analysis.hasExplicitMention ? analysis.assignmentLabel : 'No hay @ / No asignado';

  return (
    <article className={`event-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(event)}>
      <div className="event-priority" data-priority={analysis.priority || 'low'} />
      <div className="event-content">
        <div className="event-topline">
          <h3>{title}</h3>
          <span className={`status-pill ${status.className}`}>{status.label}</span>
        </div>
        <p className="event-summary">{analysis.summary || event.snippet || 'Sin resumen disponible.'}</p>
        <div className="event-meta">
          <span>{event.sender_email || event.sender_name || 'Remitente desconocido'}</span>
          <span>{formatDate(event.created_at)}</span>
        </div>
        <div className="event-facts">
          <span><strong>Asignación:</strong> {assignment}</span>
          {analysis.cancelDate?.label && <span><strong>Cancel Date:</strong> {analysis.cancelDate.label}</span>}
          {analysis.shipWindow?.label && <span><strong>Ship Window:</strong> {analysis.shipWindow.label}</span>}
        </div>
        {important.length > 0 && <p className="event-action">{important.join(' · ')} · {analysis.recommendedAction}</p>}
      </div>
      <div className="event-actions" onClick={e => e.stopPropagation()}>
        <button onClick={() => onSelect(event)}><Eye size={15}/> Detalle</button>
        <button onClick={() => onMark(event.id, 'reviewed')}>Revisado</button>
        <button onClick={() => onMark(event.id, 'closed')}>Cerrar</button>
      </div>
    </article>
  );
}

function DetailPanel({ event, onClose, onMark }) {
  const analysis = getAnalysis(event || {});
  if (!event) {
    return (
      <aside className="detail-panel empty-detail">
        <Inbox size={28}/>
        <h2>Selecciona un correo</h2>
        <p>Abre una tarjeta para ver datos extraídos, acción sugerida y texto original.</p>
      </aside>
    );
  }

  const assignment = analysis.hasExplicitMention ? analysis.assignmentLabel : 'No hay @ en el correo. No fue asignado a nadie.';
  const status = statusInfo(event);

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span className={`status-pill ${status.className}`}>{status.label}</span>
          <h2>{analysis.displayTitle || event.subject || 'Correo operativo'}</h2>
        </div>
        <button className="icon-button" onClick={onClose}><X size={18}/></button>
      </div>

      <section className="next-action">
        <span>Siguiente acción</span>
        <p>{analysis.recommendedAction || 'Revisar y marcar según corresponda.'}</p>
      </section>

      <div className="detail-grid">
        <Field label="Cliente" value={analysis.customerName} />
        <Field label="PO" value={analysis.poNumber || event.po_number} />
        <Field label="PT" value={analysis.ptNumber || event.raw?.ptNumber} />
        <Field label="Asignación" value={assignment} />
        <Field label="Operador" value={analysis.operatorName || event.operator_name} />
        <Field label="Remitente" value={event.sender_email || event.sender_name} />
        <Field label="Cancel Date" value={analysis.cancelDate?.label} />
        <Field label="Ship Window" value={analysis.shipWindow?.label || event.raw?.shipWindow?.label} />
        <Field label="Adjuntos" value={event.has_attachments ? 'Sí' : 'No'} />
        <Field label="Detectado" value={formatDate(event.created_at)} />
        <Field label="Respondió" value={analysis.respondedBy ? `${analysis.respondedBy} · ${formatDate(analysis.respondedAt)}` : null} />
      </div>

      {(analysis.importantReasons || []).length > 0 && (
        <section className="reason-box">
          <h4>Por qué aparece aquí</h4>
          <ul>{analysis.importantReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </section>
      )}

      <section className="message-box">
        <h4>Resumen operativo</h4>
        <p>{analysis.summary || event.snippet}</p>
      </section>

      <details className="message-box raw">
        <summary>Ver correo original</summary>
        <p>{event.body_text || event.snippet || 'Sin texto original disponible.'}</p>
      </details>

      <div className="detail-actions">
        <button onClick={() => onMark(event.id, 'reviewed')}>Marcar revisado</button>
        <button onClick={() => onMark(event.id, 'closed')}>Cerrar alerta</button>
      </div>
    </aside>
  );
}

function Stat({ label, value, tone = 'neutral' }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function App() {
  const [authUser, setAuthUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rpaUser')); } catch { return null; }
  });
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanLog, setScanLog] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState('today');
  const [query, setQuery] = useState('');

  async function loadEvents() {
    const res = await fetch(`${API_URL}/events`);
    if (!res.ok) throw new Error('No se pudieron cargar los eventos');
    const data = await res.json();
    setEvents(data);
    if (selected) {
      const updated = data.find(item => item.id === selected.id);
      if (updated) setSelected(updated);
    }
  }

  async function runScan() {
    setLoading(true);
    setError('');
    setScanLog('Ejecutando revisión de Outlook...');
    try {
      const res = await fetch(`${API_URL}/run-scan`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error ejecutando RPA');
      const logPreview = Array.isArray(data.logs) && data.logs.length ? ` Último log: ${data.logs[data.logs.length - 1]}` : '';
      setScanLog(`Revisión terminada. Leídos: ${data.run.scanned_count}. Nuevos: ${data.run.inserted_count}.${logPreview}`);
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

  function logout() {
    localStorage.removeItem('rpaUser');
    setAuthUser(null);
  }

  useEffect(() => {
    if (authUser) loadEvents().catch(e => setError(e.message));
  }, [authUser]);

  const scopedEvents = useMemo(() => events.filter(event => matchesUser(event, authUser)), [events, authUser]);

  const stats = useMemo(() => ({
    total: scopedEvents.length,
    urgent: scopedEvents.filter(isUrgent).length,
    unanswered: scopedEvents.filter(isAwaiting).length,
    orders: scopedEvents.filter(isOrder).length,
    responses: scopedEvents.filter(isResponse).length,
    unassigned: scopedEvents.filter(e => !getAnalysis(e).hasExplicitMention).length
  }), [scopedEvents]);

  const counts = useMemo(() => ({
    today: scopedEvents.filter(e => isUrgent(e) || isAwaiting(e) || e.status === 'new').length,
    unanswered: stats.unanswered,
    urgent: stats.urgent,
    orders: stats.orders,
    responses: stats.responses,
    all: stats.total
  }), [scopedEvents, stats]);

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopedEvents.filter(event => {
      const analysis = getAnalysis(event);
      const byTab =
        tab === 'all' ? true :
        tab === 'today' ? (isUrgent(event) || isAwaiting(event) || event.status === 'new') :
        tab === 'unanswered' ? isAwaiting(event) :
        tab === 'urgent' ? isUrgent(event) :
        tab === 'orders' ? isOrder(event) :
        tab === 'responses' ? isResponse(event) : true;
      if (!byTab) return false;
      if (!q) return true;
      const haystack = [
        analysis.displayTitle,
        analysis.summary,
        analysis.customerName,
        analysis.poNumber,
        analysis.ptNumber,
        analysis.operatorName,
        analysis.assignmentLabel,
        event.sender_email,
        event.snippet,
        event.body_text
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [scopedEvents, tab, query]);

  if (!authUser) return <Login onLogin={setAuthUser} />;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">PO</div>
          <div>
            <strong>Tracking</strong>
            <span>Outlook Monitor</span>
          </div>
        </div>

        <nav className="nav-list">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
                <Icon size={18}/>
                <span>{item.label}</span>
                <em>{counts[item.id] || 0}</em>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-block"><UserRound size={16}/><span>{authUser.name}</span></div>
          <button onClick={logout}><LogOut size={16}/> Salir</button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Centro operativo</p>
            <h1>{NAV_ITEMS.find(item => item.id === tab)?.label || 'Dashboard'}</h1>
            <p>Solo lo necesario afuera. El detalle completo queda a un clic.</p>
          </div>
          <div className="top-actions">
            <label className="search"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar cliente, PO, PT o correo" /></label>
            <button className="primary" disabled={loading} onClick={runScan}><RefreshCcw size={18} className={loading ? 'spin' : ''}/>{loading ? 'Revisando...' : 'Revisar Outlook'}</button>
          </div>
        </header>

        <section className="stats-row">
          <Stat label="Sin respuesta" value={stats.unanswered} tone="pending" />
          <Stat label="Urgentes" value={stats.urgent} tone="urgent" />
          <Stat label="Órdenes" value={stats.orders} />
          <Stat label="Sin @ asignado" value={stats.unassigned} />
        </section>

        {scanLog && <div className="notice ok">{scanLog}</div>}
        {error && <div className="notice error"><AlertTriangle size={18}/>{error}</div>}

        <section className="content-grid">
          <div className="event-list">
            <div className="list-head">
              <div><h2>Bandeja priorizada</h2><p>{filteredEvents.length} correos en esta vista</p></div>
              <button onClick={() => loadEvents().catch(e => setError(e.message))}>Actualizar</button>
            </div>
            {filteredEvents.length === 0 ? (
              <div className="empty-list"><CheckCircle2 size={24}/><p>No hay correos para este filtro.</p></div>
            ) : filteredEvents.map(event => (
              <CompactEvent key={event.id} event={event} selected={selected?.id === event.id} onSelect={setSelected} onMark={mark} />
            ))}
          </div>
          <DetailPanel event={selected} onClose={() => setSelected(null)} onMark={mark} />
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
