import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Mail,
  PackageCheck,
  RefreshCcw,
  SplitSquareHorizontal,
  UploadCloud
} from 'lucide-react';
import './styles.css';

const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es-SV', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value;
  }
}

function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return value;
  return `$${number.toFixed(2)}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function qtyMatrix(line) {
  const raw = line.raw_json || {};
  const fromRaw = raw.size_qty || raw.sizeQty || raw.size_matrix;
  if (fromRaw && typeof fromRaw === 'object') {
    const entries = Object.entries(fromRaw).filter(([, value]) => value !== null && value !== undefined && value !== '');
    if (entries.length) return entries.map(([size, qty]) => `${size}:${qty}`).join(' · ');
  }
  const values = [];
  for (let i = 1; i <= 18; i += 1) {
    const value = line[`qty_sz${i}`];
    if (value !== null && value !== undefined && value !== '') values.push(`SZ${i}:${value}`);
  }
  return values.join(' · ') || '—';
}

function exportUrl(filePath) {
  if (!filePath) return '#';
  const marker = '/exports/';
  const pos = filePath.indexOf(marker);
  if (pos >= 0) return `${API_URL}/exports/${filePath.slice(pos + marker.length)}`;
  if (filePath.startsWith('exports/')) return `${API_URL}/${filePath}`;
  return '#';
}

function urlFromExportResult(urlOrPath) {
  if (!urlOrPath) return '#';
  if (String(urlOrPath).startsWith('/exports/')) return `${API_URL}${urlOrPath}`;
  return exportUrl(urlOrPath);
}

async function downloadCsv(url, fileName) {
  if (!url || url === '#') return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No pude descargar ${fileName}: HTTP ${response.status}`);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName || 'a2000-export.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 3000);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      message = json.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function StatusBadge({ status }) {
  const clean = status || 'pending';
  return <span className={`status-badge ${clean}`}>{clean.replaceAll('_', ' ')}</span>;
}

function MiniStat({ label, value, icon: Icon }) {
  return (
    <div className="mini-stat">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MissingList({ value }) {
  const header = asArray(value?.header);
  const lines = asArray(value?.lines);
  const conflicts = asArray(value?.conflicts);

  if (!header.length && !lines.length && !conflicts.length) {
    return <p className="muted">Sin faltantes detectados.</p>;
  }

  return (
    <div className="missing-list">
      {header.length > 0 && (
        <div>
          <strong>Header</strong>
          <p>{header.join(', ')}</p>
        </div>
      )}
      {lines.length > 0 && (
        <div>
          <strong>Lines</strong>
          {lines.slice(0, 6).map((line, index) => (
            <p key={index}>Línea {line.line_no || index + 1}: {asArray(line.missing).join(', ') || 'revisar'}</p>
          ))}
          {lines.length > 6 && <p>+ {lines.length - 6} líneas más.</p>}
        </div>
      )}
      {conflicts.length > 0 && (
        <div>
          <strong>Conflictos</strong>
          {conflicts.slice(0, 4).map((item, index) => (
            <p key={index}>{item.field || 'campo'}: {item.message || JSON.stringify(item)}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentList({ documents, selectedId, onSelect }) {
  if (!documents.length) {
    return (
      <div className="empty-card">
        <FileText size={30} />
        <h3>No hay facturas todavía</h3>
        <p>Sube un PDF o ejecuta el RPA de Outlook para llenar esta bandeja.</p>
      </div>
    );
  }

  return (
    <div className="doc-list">
      {documents.map(doc => (
        <button key={doc.id} className={`doc-row ${selectedId === doc.id ? 'active' : ''}`} onClick={() => onSelect(doc.id)}>
          <div className="doc-icon"><FileText size={18} /></div>
          <div className="doc-main">
            <strong>{doc.file_name || 'PDF sin nombre'}</strong>
            <span>{doc.subject || doc.source || 'manual upload'} · {formatDate(doc.created_at)}</span>
            <small>{doc.detected_customer || 'customer pendiente'} {doc.detected_po ? `· PO ${doc.detected_po}` : ''}</small>
          </div>
          <StatusBadge status={doc.status} />
        </button>
      ))}
    </div>
  );
}

function UploadBox({ onUploaded }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function uploadFiles(files) {
    const pdfs = [...files].filter(file => /\.pdf$/i.test(file.name));
    if (!pdfs.length) return;
    setUploading(true);
    try {
      for (const file of pdfs) {
        const form = new FormData();
        form.append('file', file);
        await api('/documents/upload', { method: 'POST', body: form });
      }
      await onUploaded();
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div
      className={`upload-box ${dragging ? 'dragging' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); uploadFiles(event.dataTransfer.files); }}
    >
      <UploadCloud size={24} />
      <div>
        <strong>Subir facturas de prueba</strong>
        <p>Arrastra PDFs aquí o selecciónalos manualmente.</p>
      </div>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple onChange={event => uploadFiles(event.target.files)} />
      <button disabled={uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="spin" size={16} /> : <UploadCloud size={16} />}
        {uploading ? 'Subiendo...' : 'Subir PDF'}
      </button>
    </div>
  );
}

function PdfViewer({ document }) {
  if (!document) {
    return (
      <div className="pdf-empty">
        <Eye size={28} />
        <p>Selecciona una factura para verla aquí.</p>
      </div>
    );
  }

  return (
    <iframe
      title={document.file_name || 'Factura PDF'}
      className="pdf-frame"
      src={`${API_URL}/documents/${document.id}/file#toolbar=1&navpanes=0`}
    />
  );
}

function OrderDetail({ document, order, onProcessOne }) {
  if (!document) {
    return (
      <aside className="detail-card empty-card">
        <SplitSquareHorizontal size={30} />
        <h3>Datos extraídos</h3>
        <p>Aquí veremos header, líneas, faltantes y conflictos.</p>
      </aside>
    );
  }

  if (!order) {
    return (
      <aside className="detail-card">
        <div className="section-title">
          <div>
            <span>Documento</span>
            <h2>{document.file_name}</h2>
          </div>
          <StatusBadge status={document.status} />
        </div>
        <div className="notice warning">
          <AlertCircle size={18} />
          <p>Este PDF todavía no tiene datos procesados. Puedes procesarlo individualmente.</p>
        </div>
        <button className="primary wide" onClick={() => onProcessOne(document.id)}>
          <PackageCheck size={17} /> Procesar esta factura
        </button>
      </aside>
    );
  }

  const lines = order.purchase_order_lines || [];
  const totals = order.totals || order.raw_json?.totals || {};

  return (
    <aside className="detail-card">
      <div className="section-title">
        <div>
          <span>Orden extraída</span>
          <h2>{order.order_no || 'PO pendiente'}</h2>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="field-grid">
        <Field label="Parser" value={order.parser_name} />
        <Field label="Cliente raw" value={order.customer_raw} />
        <Field label="Customer A2000" value={order.customer_code || 'pendiente'} muted={!order.customer_code} />
        <Field label="Store raw" value={order.store_raw} />
        <Field label="Store A2000" value={order.store_code || 'pendiente'} muted={!order.store_code} />
        <Field label="Dept" value={order.dept_raw || order.dept_code} />
        <Field label="Order date" value={order.order_date} />
        <Field label="Start / Ship" value={order.start_date} />
        <Field label="Cancel" value={order.cancel_date} />
        <Field label="Terms raw" value={order.terms_raw} />
        <Field label="Terms A2000" value={order.terms_code || 'pendiente'} muted={!order.terms_code} />
        <Field label="Warehouse" value={order.warehouse_code || 'pendiente'} muted={!order.warehouse_code} />
      </div>

      <div className="totals-row">
        <MiniStat label="Líneas" value={lines.length} icon={FileSpreadsheet} />
        <MiniStat label="Qty" value={totals.total_qty ?? lines.reduce((acc, line) => acc + Number(line.qty_total || 0), 0)} icon={PackageCheck} />
        <MiniStat label="Total" value={money(totals.total_amount)} icon={Archive} />
      </div>

      <section className="panel-block">
        <h3>Faltantes para A2000</h3>
        <MissingList value={order.missing_fields} />
      </section>

      {order.conflicts?.length > 0 && (
        <section className="panel-block danger-block">
          <h3>Conflictos</h3>
          {order.conflicts.map((item, index) => <p key={index}>{item.field}: {item.message}</p>)}
        </section>
      )}

      <section className="panel-block">
        <h3>Líneas extraídas</h3>
        <div className="lines-table-wrap">
          <table className="lines-table wide-lines-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Style A2000</th>
                <th>Color A2000</th>
                <th>Style raw</th>
                <th>Color raw</th>
                <th>Cust style / SKU</th>
                <th>Sizes / Qty</th>
                <th>Qty total</th>
                <th>Sale price</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {lines.length ? lines.map(line => (
                <tr key={line.id || line.line_no}>
                  <td>{line.line_no}</td>
                  <td><strong>{line.style_code || 'pendiente'}</strong></td>
                  <td><strong>{line.color_code || 'pendiente'}</strong></td>
                  <td>{line.style_raw || '—'}</td>
                  <td>{line.color_raw || '—'}</td>
                  <td>{line.customer_sku || line.ticket_sku || '—'}</td>
                  <td><span className="size-matrix">{qtyMatrix(line)}</span></td>
                  <td>{line.qty_total ?? line.qty_sz1 ?? '—'}</td>
                  <td>{money(line.sales_price)}</td>
                  <td>{line.description || '—'}</td>
                </tr>
              )) : (
                <tr><td colSpan="10">No se extrajeron líneas todavía.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  );
}

function Field({ label, value, muted = false }) {
  return (
    <div className={`field ${muted ? 'muted-value' : ''}`}>
      <span>{label}</span>
      <strong>{value || '—'}</strong>
    </div>
  );
}

function BatchPanel({ batches }) {
  return (
    <section className="batch-panel">
      <div className="section-title small-title">
        <div>
          <span>A2000 exports</span>
          <h2>Batches generados</h2>
        </div>
      </div>
      {!batches.length ? (
        <p className="muted">Todavía no hay exports. Genera un batch para descargar header y lines.</p>
      ) : (
        <div className="batch-list">
          {batches.slice(0, 5).map(batch => (
            <article key={batch.id} className="batch-row">
              <div>
                <strong>{formatDate(batch.created_at)}</strong>
                <span>{batch.orders_count || 0} órdenes · {batch.header_rows_count || 0} headers · {batch.line_rows_count || 0} lines</span>
              </div>
              <div className="batch-actions">
                <a href={exportUrl(batch.header_file_path)} target="_blank" rel="noreferrer"><Download size={15} /> Header CSV</a>
                <a href={exportUrl(batch.lines_file_path)} target="_blank" rel="noreferrer"><Download size={15} /> Lines CSV</a>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function App() {
  const [documents, setDocuments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [batches, setBatches] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState(null);

  const selectedDocument = useMemo(() => documents.find(doc => doc.id === selectedId) || documents[0] || null, [documents, selectedId]);
  const selectedOrder = useMemo(() => {
    if (!selectedDocument) return null;
    return orders.find(order => order.document_id === selectedDocument.id) || null;
  }, [orders, selectedDocument]);

  async function refresh() {
    setLoading(true);
    try {
      const [docData, orderData, batchData] = await Promise.all([
        api('/documents'),
        api('/demo/orders'),
        api('/demo/batches')
      ]);
      setDocuments(docData || []);
      setOrders(orderData || []);
      setBatches(batchData || []);
      if (!selectedId && docData?.length) setSelectedId(docData[0].id);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function runScan() {
    setWorking('scan');
    setMessage(null);
    try {
      const result = await api('/run-scan', { method: 'POST' });
      setMessage({ type: 'ok', text: `RPA terminado. Descargó ${result.documents?.length || 0} PDF(s).` });
      await refresh();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setWorking('');
    }
  }

  async function processDocuments(documentId = null) {
    setWorking(documentId ? `process-${documentId}` : 'process');
    setMessage(null);
    try {
      const result = await api('/demo/process-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documentId ? { documentId } : { limit: 50 })
      });
      setMessage({ type: 'ok', text: `Procesadas ${result.processed_count || 0} factura(s).` });
      await refresh();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setWorking('');
    }
  }

  async function exportBatch() {
    setWorking('export');
    setMessage(null);
    try {
      const result = await api('/demo/export-a2000-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeNeedsMapping: true, includeAlreadyBatched: true, forceDemo: true })
      });

      const headerUrl = result.header_url ? `${API_URL}${result.header_url}` : urlFromExportResult(result.header_file_path);
      const linesUrl = result.lines_url ? `${API_URL}${result.lines_url}` : urlFromExportResult(result.lines_file_path);
      const headerName = result.header_file_name || 'A2000_DEMO_HEADER_BATCH.csv';
      const linesName = result.lines_file_name || 'A2000_DEMO_LINES_BATCH.csv';

      await downloadCsv(headerUrl, headerName);
      await downloadCsv(linesUrl, linesName);

      setMessage({
        type: 'ok',
        text: `Export generado y descargado: ${result.header_rows_count || 0} headers y ${result.line_rows_count || 0} lines.`
      });
      await refresh();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setWorking('');
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">American Exchange · A2000 Demo</p>
          <h1>Facturas → Supabase → Header & Lines CSV</h1>
          <p>Una web limpia para probar PDFs, revisar datos extraídos y exportar los dos imports para A2000.</p>
        </div>
        <div className="hero-actions">
          <button onClick={refresh} disabled={loading}><RefreshCcw className={loading ? 'spin' : ''} size={16} /> Refrescar</button>
          <button onClick={runScan} disabled={!!working}>{working === 'scan' ? <Loader2 className="spin" size={16} /> : <Mail size={16} />} Leer Outlook</button>
          <button onClick={() => processDocuments()} disabled={!!working}>{working === 'process' ? <Loader2 className="spin" size={16} /> : <PackageCheck size={16} />} Procesar PDFs</button>
          <button className="primary" onClick={exportBatch} disabled={!!working}>{working === 'export' ? <Loader2 className="spin" size={16} /> : <Download size={16} />} Exportar CSV</button>
        </div>
      </header>

      {message && (
        <div className={`toast ${message.type}`}>
          {message.type === 'ok' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          {message.text}
        </div>
      )}

      <UploadBox onUploaded={refresh} />

      <section className="stats-grid">
        <MiniStat label="Documentos" value={documents.length} icon={FileText} />
        <MiniStat label="Órdenes" value={orders.length} icon={PackageCheck} />
        <MiniStat label="Líneas" value={orders.reduce((acc, order) => acc + (order.purchase_order_lines?.length || 0), 0)} icon={SplitSquareHorizontal} />
        <MiniStat label="Batches" value={batches.length} icon={FileSpreadsheet} />
      </section>

      <section className="workspace-grid">
        <aside className="left-panel panel">
          <div className="panel-head">
            <div>
              <span>Inbox de documentos</span>
              <h2>Facturas PDF</h2>
            </div>
          </div>
          <DocumentList documents={documents} selectedId={selectedDocument?.id} onSelect={setSelectedId} />
        </aside>

        <section className="pdf-panel panel">
          <div className="panel-head">
            <div>
              <span>Vista previa</span>
              <h2>{selectedDocument?.file_name || 'Factura'}</h2>
            </div>
            {selectedDocument && (
              <a className="link-button" href={`${API_URL}/documents/${selectedDocument.id}/file`} target="_blank" rel="noreferrer">
                <Download size={15} /> Abrir PDF
              </a>
            )}
          </div>
          <PdfViewer document={selectedDocument} />
        </section>

        <OrderDetail document={selectedDocument} order={selectedOrder} onProcessOne={processDocuments} />
      </section>

      <BatchPanel batches={batches} />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
