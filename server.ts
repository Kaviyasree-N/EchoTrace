import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';

import { getDb, DbEvent } from './server/database/db';
import { seedDatabaseIfEmpty } from './server/database/seed';
import { processSoundDetection } from './server/services/eventProcessor';
import { getAlerts, acknowledgeAlert, acknowledgeAllAlerts, getUnacknowledgedAlertCount } from './server/services/alertManager';
import { getActivities } from './server/services/activityEngine';
import { getDashboardInsights, generateCsvReport } from './server/services/reportGenerator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const AI_SERVICE_PORT = 5000;
const AI_SERVICE_HOST = '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'audio/*', limit: '10mb' }));

// Initialize persistent SQLite database & seed if empty
const db = getDb();
seedDatabaseIfEmpty();

// ── Spawn Background Python AI Service ────────────────────────────────────────
let aiServiceProcess: ChildProcess | null = null;
let isAiServiceRunning = false;

function startPythonAiService() {
  try {
    const aiScript = path.join(process.cwd(), 'ai-service', 'main.py');
    console.log(`[EchoTrace] Launching Python YAMNet AI Service: ${aiScript}`);

    aiServiceProcess = spawn('python3', [aiScript], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    aiServiceProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[AI-Service] ${msg}`);
      if (msg.includes('EchoTrace AI Inference Service running')) {
        isAiServiceRunning = true;
      }
    });

    aiServiceProcess.stderr?.on('data', (data) => {
      console.warn(`[AI-Service STDERR] ${data.toString().trim()}`);
    });

    aiServiceProcess.on('exit', (code) => {
      console.warn(`[AI-Service] Exited with code ${code}`);
      isAiServiceRunning = false;
    });
  } catch (err) {
    console.warn(`[EchoTrace] Could not spawn Python AI service directly:`, err);
  }
}

startPythonAiService();

// Clean up child process on exit
process.on('exit', () => {
  if (aiServiceProcess) {
    aiServiceProcess.kill();
  }
});

// Helper to query Python AI service
function callAiService(pathname: string, method: string = 'GET', data?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : null;
    const req = http.request(
      {
        hostname: AI_SERVICE_HOST,
        port: AI_SERVICE_PORT,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI service request timed out'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ── REST API ROUTES ──────────────────────────────────────────────────────────

// 1. AI Service Status & Health
app.get('/api/ai/status', async (_req, res) => {
  try {
    const health = await callAiService('/health', 'GET');
    const isReady = Boolean(health && health.status === 'ready' && health.is_neural_network);
    isAiServiceRunning = isReady;

    res.json({
      ready: isReady,
      model: isReady ? 'YAMNet' : (health?.model || 'YAMNet'),
      status: health?.status || (isReady ? 'ready' : 'connecting'),
      is_neural_network: Boolean(health?.is_neural_network),
      inference_engine: health?.inference_engine || (isReady ? 'yamnet_neural_network' : 'unknown'),
      classes_count: health?.classes_count || 0,
      details: health,
    });
  } catch {
    res.json({
      ready: false,
      model: 'YAMNet',
      status: 'offline',
      is_neural_network: false,
      inference_engine: 'offline',
      details: 'Python AI inference service not responding on port 5000',
    });
  }
});

// 2. Audio Classification Gateway
app.post('/api/ai/classify', async (req, res) => {
  const { samples, audio_base64, room, source = 'microphone', sample_rate = 16000 } = req.body;
  const targetRoom = room || 'Living Room';

  try {
    // Forward to Python YAMNet AI Service
    let aiResponse;
    try {
      aiResponse = await callAiService('/classify', 'POST', { samples, audio_base64, sample_rate });
    } catch {
      aiResponse = null;
    }

    if (aiResponse && aiResponse.detected && aiResponse.sound_class) {
      // Process sound through intelligent event processor
      const processResult = processSoundDetection({
        sound_class: aiResponse.sound_class,
        confidence: aiResponse.confidence,
        room: targetRoom,
        duration: aiResponse.duration || 1.0,
        source: source === 'simulator' ? 'simulator' : 'microphone',
      });

      return res.json({
        success: true,
        detected: true,
        prediction: aiResponse,
        eventResult: processResult,
      });
    }

    res.json({
      success: true,
      detected: false,
      message: 'No target sound detected above threshold',
      prediction: aiResponse,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'AI classification failed', details: err.message });
  }
});

// 3. Stats & Dashboard Insights
app.get('/api/stats', (req, res) => {
  const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;

  const insights = getDashboardInsights(startDate, endDate);

  res.json({
    total: insights.totalAllTime,
    today: insights.totalToday,
    thisWeek: insights.totalThisWeek,
    top_sounds: insights.topSounds.map((s) => ({ sound_class: s.sound_class, n: s.count })),
    roomDistribution: insights.roomDistribution,
    timeOfDay: insights.timeOfDay,
    alertsSummary: insights.alertsSummary,
    activitiesCount: insights.activitiesCount,
  });
});

// 4. Events Search & Query
app.get('/api/events', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const roomFilter = typeof req.query.room === 'string' ? req.query.room.trim() : '';
  const sourceFilter = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
  const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  let sql = `SELECT * FROM events WHERE 1=1`;
  const params: any[] = [];

  if (query) {
    sql += ` AND (LOWER(sound_class) LIKE ? OR LOWER(room) LIKE ?)`;
    params.push(`%${query}%`, `%${query}%`);
  }

  if (roomFilter && roomFilter !== 'All Rooms') {
    sql += ` AND room = ?`;
    params.push(roomFilter);
  }

  if (sourceFilter && sourceFilter !== 'All') {
    sql += ` AND source = ?`;
    params.push(sourceFilter);
  }

  if (startDate) {
    sql += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    sql += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as DbEvent[];
  res.json(rows);
});

// 5. Insert New Event (with Cooldown, Temporal Smoothing, and Grouping)
app.post('/api/events', (req, res) => {
  const { sound_class, confidence, room, timestamp, duration, source, session_id } = req.body;

  if (!sound_class) {
    return res.status(400).json({ error: 'sound_class is required' });
  }

  const result = processSoundDetection({
    sound_class: String(sound_class),
    confidence: Number(confidence) || 0.8,
    room: room || 'Living Room',
    timestamp,
    duration: Number(duration) || 1.0,
    source: source === 'simulator' ? 'simulator' : 'microphone',
    session_id: session_id || '',
  });

  res.status(201).json(result);
});

// 6. Caregiver Alerts
app.get('/api/alerts', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const onlyUnack = req.query.onlyUnacknowledged === 'true';
  const alerts = getAlerts(limit, onlyUnack);
  const unackCount = getUnacknowledgedAlertCount();
  res.json({ alerts, unacknowledgedCount: unackCount });
});

// Acknowledge single alert
app.post('/api/alerts/:id/ack', (req, res) => {
  const id = Number(req.params.id);
  const success = acknowledgeAlert(id);
  if (success) {
    res.json({ success: true, message: `Alert #${id} acknowledged` });
  } else {
    res.status(404).json({ error: `Alert #${id} not found` });
  }
});

// Acknowledge all unacknowledged alerts
app.post('/api/alerts/ack-all', (_req, res) => {
  const count = acknowledgeAllAlerts();
  res.json({ success: true, count, message: `${count} alert(s) acknowledged` });
});


// 7. Interpreted Activities
app.get('/api/activities', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const roomFilter = typeof req.query.room === 'string' ? req.query.room : undefined;
  const activities = getActivities(limit, roomFilter);
  res.json(activities);
});

// 8. Monitored Rooms
app.get('/api/rooms', (_req, res) => {
  const defaultRooms = [
    'Living Room',
    'Kitchen',
    'Bedroom',
    'Bathroom',
    'Hallway',
    'Garden',
    'Dining Room',
    'Office',
  ];
  const recorded = db.prepare(`SELECT DISTINCT room FROM events ORDER BY room`).all() as Array<{ room: string }>;
  const allRooms = Array.from(new Set([...defaultRooms, ...recorded.map((r) => r.room)]));
  res.json(allRooms);
});

// 9. CSV Report Export
app.get('/api/reports/csv', (req, res) => {
  const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;

  const csv = generateCsvReport(startDate, endDate);
  const filename = `echotrace-report-${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// 10. Clear Database History (Requires Explicit Confirmation)
app.delete('/api/events', (req, res) => {
  const { confirm } = req.body || {};
  if (!confirm) {
    return res.status(400).json({
      error: 'Confirmation required. Pass { confirm: true } to clear event history.',
    });
  }

  db.exec(`
    DELETE FROM alerts;
    DELETE FROM activities;
    DELETE FROM events;
  `);

  res.json({ message: 'All event logs, activities, and alerts cleared successfully.' });
});

// 11. Reset Sample Data (Requires Explicit Confirmation)
app.post('/api/reset', (req, res) => {
  const { confirm } = req.body || {};
  if (!confirm) {
    return res.status(400).json({
      error: 'Confirmation required. Pass { confirm: true } to reset sample data.',
    });
  }

  seedDatabaseIfEmpty(true);
  res.json({ message: 'Sample database reset with fresh activity and alert records.' });
});

// 12. Settings
app.get('/api/settings', (_req, res) => {
  const rows = db.prepare(`SELECT setting_key, setting_value FROM settings`).all() as Array<{ setting_key: string; setting_value: string }>;
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.setting_key] = r.setting_value;
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value required' });
  }

  db.prepare(`
    INSERT INTO settings (setting_key, setting_value)
    VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `).run(String(key), String(value));

  res.json({ success: true, key, value });
});

// ── VITE / STATIC SERVING ────────────────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[EchoTrace] Application running at http://${HOST}:${PORT}`);
  });
}

startServer();
