import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';

import { getDb, DbEvent } from './server/database/db';
import { seedDatabaseIfEmpty } from './server/database/seed';
import { processSoundDetection, validateAndSanitizeSessionId } from './server/services/eventProcessor';
import { getAlerts, acknowledgeAlert, acknowledgeAllAlerts, getUnacknowledgedAlertCount } from './server/services/alertManager';
import { getActivities } from './server/services/activityEngine';
import { getDashboardInsights, generateCsvReport } from './server/services/reportGenerator';
import { classifyWaveform, decodeBase64ToSamples } from './server/services/acousticClassifier';

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
      model: isReady ? 'YAMNet' : (health?.model || 'Acoustic-Spectral-Fallback'),
      status: health?.status || (isReady ? 'ready' : 'fallback'),
      is_neural_network: Boolean(health?.is_neural_network),
      inference_engine: health?.inference_engine || (isReady ? 'yamnet_neural_network' : 'acoustic_spectral_fallback'),
      classes_count: health?.classes_count || 521,
      details: health,
    });
  } catch {
    res.json({
      ready: false,
      model: 'Acoustic-Spectral-Fallback',
      status: 'fallback',
      is_neural_network: false,
      inference_engine: 'acoustic_spectral_fallback',
      classes_count: 40,
      details: 'Built-in Node.js Acoustic Spectral Classifier active',
    });
  }
});

// 2. Audio Classification Gateway
app.post('/api/ai/classify', async (req, res) => {
  const {
    samples,
    audio_base64,
    room,
    source = 'microphone',
    sample_rate = 16000,
    clientSessionId,
    client_session_id,
    session_id,
  } = req.body;
  const targetRoom = room || 'Living Room';
  const validatedSessionId = validateAndSanitizeSessionId(
    clientSessionId || client_session_id || session_id
  );

  try {
    // Forward to Python YAMNet AI Service
    let aiResponse;
    try {
      aiResponse = await callAiService('/classify', 'POST', {
        samples,
        audio_base64,
        sample_rate,
        clientSessionId: validatedSessionId,
        client_session_id: validatedSessionId,
      });
    } catch {
      aiResponse = null;
    }

    // Fallback to built-in acoustic classifier if python service is unavailable or returned no detection
    if (!aiResponse || !aiResponse.sound_class) {
      const audioSamples: number[] = Array.isArray(samples) && samples.length > 0
        ? samples
        : typeof audio_base64 === 'string' && audio_base64.length > 0
        ? decodeBase64ToSamples(audio_base64)
        : [];

      if (audioSamples.length > 0) {
        const fallbackResult = classifyWaveform(audioSamples, sample_rate);
        if (fallbackResult.detected && fallbackResult.sound_class) {
          aiResponse = fallbackResult;
        }
      }
    }

    if (aiResponse && aiResponse.detected && aiResponse.sound_class) {
      // Process sound through intelligent event processor
      const processResult = processSoundDetection({
        sound_class: aiResponse.sound_class,
        confidence: aiResponse.confidence,
        room: targetRoom,
        duration: aiResponse.duration || 1.0,
        source: source === 'simulator' ? 'simulator' : 'microphone',
        client_session_id: validatedSessionId,
        session_id: validatedSessionId || '',
      });

      return res.json({
        success: true,
        detected: true,
        prediction: aiResponse,
        eventResult: processResult,
        clientSessionId: validatedSessionId,
      });
    }

    res.json({
      success: true,
      detected: false,
      message: 'No target sound detected above threshold',
      prediction: aiResponse,
      clientSessionId: validatedSessionId,
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
  const sessionFilter = typeof req.query.session === 'string'
    ? req.query.session.trim()
    : typeof req.query.sessionId === 'string'
    ? req.query.sessionId.trim()
    : typeof req.query.clientSessionId === 'string'
    ? req.query.clientSessionId.trim()
    : '';
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

  if (sessionFilter && sessionFilter !== 'All') {
    sql += ` AND (client_session_id = ? OR session_id = ?)`;
    params.push(sessionFilter, sessionFilter);
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

// 4b. Active / Distinct Client Sessions
app.get('/api/sessions', (_req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT COALESCE(NULLIF(client_session_id, ''), NULLIF(session_id, '')) as session_id,
           COUNT(*) as event_count,
           MIN(timestamp) as started_at,
           MAX(timestamp) as last_seen
    FROM events
    WHERE (client_session_id IS NOT NULL AND client_session_id != '')
       OR (session_id IS NOT NULL AND session_id != '')
    GROUP BY COALESCE(NULLIF(client_session_id, ''), NULLIF(session_id, ''))
    ORDER BY last_seen DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// 5. Insert New Event (with Cooldown, Temporal Smoothing, and Grouping)
app.post('/api/events', (req, res) => {
  const {
    sound_class,
    confidence,
    room,
    timestamp,
    duration,
    source,
    session_id,
    clientSessionId,
    client_session_id,
  } = req.body;

  if (!sound_class) {
    return res.status(400).json({ error: 'sound_class is required' });
  }

  const validatedSessionId = validateAndSanitizeSessionId(
    clientSessionId || client_session_id || session_id
  );

  const result = processSoundDetection({
    sound_class: String(sound_class),
    confidence: Number(confidence) || 0.8,
    room: room || 'Living Room',
    timestamp,
    duration: Number(duration) || 1.0,
    source: source === 'simulator' ? 'simulator' : 'microphone',
    session_id: validatedSessionId || (typeof session_id === 'string' && session_id.length <= 128 ? session_id : ''),
    client_session_id: validatedSessionId,
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
function validateSetting(key: string, value: unknown): { valid: boolean; normalizedValue: string; error?: string } {
  const strVal = String(value).trim();
  switch (key) {
    case 'confidence_threshold': {
      const num = parseFloat(strVal);
      if (isNaN(num) || num < 0.0 || num > 1.0) {
        return { valid: false, normalizedValue: '', error: 'Confidence threshold must be a number between 0.0 and 1.0' };
      }
      return { valid: true, normalizedValue: num.toFixed(2) };
    }
    case 'duplicate_cooldown_sec': {
      const num = parseFloat(strVal);
      if (isNaN(num) || num < 1.0 || num > 120.0) {
        return { valid: false, normalizedValue: '', error: 'Duplicate cooldown must be between 1 and 120 seconds' };
      }
      return { valid: true, normalizedValue: String(Math.round(num * 10) / 10) };
    }
    case 'continuous_grouping_window_sec': {
      const num = parseFloat(strVal);
      if (isNaN(num) || num < 2.0 || num > 120.0) {
        return { valid: false, normalizedValue: '', error: 'Continuous grouping window must be between 2 and 120 seconds' };
      }
      return { valid: true, normalizedValue: String(Math.round(num * 10) / 10) };
    }
    case 'activity_window_min': {
      const num = parseInt(strVal, 10);
      if (isNaN(num) || num < 1 || num > 240) {
        return { valid: false, normalizedValue: '', error: 'Activity window must be an integer between 1 and 240 minutes' };
      }
      return { valid: true, normalizedValue: String(num) };
    }
    case 'alerts_critical_enabled':
    case 'alerts_high_enabled':
    case 'notifications_enabled':
    case 'chime_enabled': {
      const lower = strVal.toLowerCase();
      if (lower !== 'true' && lower !== 'false' && lower !== '1' && lower !== '0') {
        return { valid: false, normalizedValue: '', error: `${key} must be a boolean ('true' or 'false')` };
      }
      return { valid: true, normalizedValue: lower === 'true' || lower === '1' ? 'true' : 'false' };
    }
    case 'chime_severity': {
      if (strVal !== 'Critical' && strVal !== 'High') {
        return { valid: false, normalizedValue: '', error: 'Chime severity must be either "Critical" or "High"' };
      }
      return { valid: true, normalizedValue: strVal };
    }
    case 'ai_service_url': {
      return { valid: true, normalizedValue: strVal };
    }
    default:
      return { valid: true, normalizedValue: strVal };
  }
}

// 12. Settings Endpoints
app.get('/api/settings', (_req, res) => {
  const rows = db.prepare(`SELECT setting_key, setting_value FROM settings`).all() as Array<{ setting_key: string; setting_value: string }>;
  const defaultSettings: Record<string, string> = {
    confidence_threshold: '0.40',
    duplicate_cooldown_sec: '4',
    continuous_grouping_window_sec: '12',
    activity_window_min: '15',
    alerts_critical_enabled: 'true',
    alerts_high_enabled: 'true',
    notifications_enabled: 'true',
    chime_enabled: 'false',
    chime_severity: 'Critical',
    ai_service_url: 'http://127.0.0.1:5000',
  };
  for (const r of rows) defaultSettings[r.setting_key] = r.setting_value;
  res.json(defaultSettings);
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  let entries: Array<{ key: string; value: unknown }> = [];

  if (body.settings && typeof body.settings === 'object') {
    entries = Object.entries(body.settings).map(([k, v]) => ({ key: k, value: v }));
  } else if (body.key !== undefined && body.value !== undefined) {
    entries = [{ key: body.key, value: body.value }];
  } else if (typeof body === 'object' && Object.keys(body).length > 0) {
    entries = Object.entries(body).map(([k, v]) => ({ key: k, value: v }));
  }

  if (entries.length === 0) {
    return res.status(400).json({ error: 'No settings provided. Pass { key, value } or { settings: { ... } }' });
  }

  // Validate all entries first
  const validatedEntries: Array<{ key: string; normalizedValue: string }> = [];
  for (const item of entries) {
    const result = validateSetting(item.key, item.value);
    if (!result.valid) {
      return res.status(400).json({ error: result.error, key: item.key });
    }
    validatedEntries.push({ key: item.key, normalizedValue: result.normalizedValue });
  }

  // Persist all in transaction
  const insertStmt = db.prepare(`
    INSERT INTO settings (setting_key, setting_value)
    VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `);

  const saveAll = db.transaction((items: Array<{ key: string; normalizedValue: string }>) => {
    for (const item of items) {
      insertStmt.run(item.key, item.normalizedValue);
    }
  });

  saveAll(validatedEntries);

  // Return full refreshed settings
  const rows = db.prepare(`SELECT setting_key, setting_value FROM settings`).all() as Array<{ setting_key: string; setting_value: string }>;
  const allSettings: Record<string, string> = {};
  for (const r of rows) allSettings[r.setting_key] = r.setting_value;

  const updatedMap: Record<string, string> = {};
  for (const item of validatedEntries) {
    updatedMap[item.key] = item.normalizedValue;
  }

  res.json({ success: true, updated: updatedMap, settings: allSettings });
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
