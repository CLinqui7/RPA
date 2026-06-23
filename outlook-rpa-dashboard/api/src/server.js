import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { runScan } from './runScan.js';
import { listEvents, markEvent } from './runRepository.js';

const app = express();

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'outlook-rpa-api',
    port: config.port,
    outlookHeadless: config.outlookHeadless
  });
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
