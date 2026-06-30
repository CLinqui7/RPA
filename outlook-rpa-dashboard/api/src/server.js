import express from 'express';
import cors from 'cors';
import path from 'node:path';
import multer from 'multer';
import { config } from './config.js';
import { runScan } from './runScan.js';
import { listEvents, markEvent } from './runRepository.js';
import { listDocuments, saveUploadedDocument, downloadDocumentBuffer } from './documentRepository.js';
import { processDownloadedDocuments, listPurchaseOrders } from './po/poRepository.js';
import { createDemoA2000Batch, listDemoBatches } from './a2000/exportBatch.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'outlook-rpa-api',
    port: config.port,
    outlookHeadless: config.outlookHeadless
  });
});

app.use('/exports', express.static(path.resolve(process.cwd(), 'exports')));

app.get('/documents', async (_req, res) => {
  try {
    res.json(await listDocuments());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    const logs = [];
    const document = await saveUploadedDocument(req.file, logs);
    res.json({ document, logs });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/documents/:id/file', async (req, res) => {
  try {
    const { document, buffer } = await downloadDocumentBuffer(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(document.file_name || 'document.pdf').replaceAll('"', '')}"`);
    res.send(buffer);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/events', async (_req, res) => {
  try {
    res.json(await listEvents());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/events/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'reviewed', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    res.json(await markEvent(req.params.id, status));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/demo/process-documents', async (req, res) => {
  try {
    const { limit = 20, documentId = null } = req.body || {};
    res.json(await processDownloadedDocuments({ limit, documentId }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/demo/orders', async (_req, res) => {
  try {
    res.json(await listPurchaseOrders());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/demo/export-a2000-batch', async (req, res) => {
  try {
    const { includeNeedsMapping = true } = req.body || {};
    res.json(await createDemoA2000Batch({ includeNeedsMapping }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/demo/batches', async (_req, res) => {
  try {
    res.json(await listDemoBatches());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

let running = false;

app.post('/run-scan', async (_req, res) => {
  if (running) return res.status(409).json({ error: 'RPA already running' });

  running = true;
  try {
    const result = await runScan();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    running = false;
  }
});

app.listen(config.port, () => {
  console.log(`API running on http://localhost:${config.port}`);
});
