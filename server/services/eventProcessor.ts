import { getDb, type DbEvent, type DbAlert } from '../database/db.ts';
import { checkForAlert } from './alertManager.ts';
import { evaluateRecentActivities } from './activityEngine.ts';

export function validateAndSanitizeSessionId(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9_\-:.]+$/.test(trimmed)) return null;
  return trimmed;
}

export interface ProcessEventInput {
  sound_class: string;
  confidence: number;
  room: string;
  timestamp?: string;
  duration?: number;
  source?: 'microphone' | 'simulator';
  session_id?: string;
  client_session_id?: string | null;
  clientSessionId?: string | null;
}

export interface ProcessEventResult {
  status: 'created' | 'grouped' | 'suppressed' | 'rejected_threshold';
  event: DbEvent | null;
  alert?: DbAlert | null;
  message?: string;
}

// Sounds that naturally occur continuously or repeatedly
const CONTINUOUS_SOUND_CLASSES = new Set([
  'Footsteps',
  'Water tap, faucet',
  'Shower',
  'Vacuum cleaner',
  'Television',
  'Radio',
  'Speech',
  'Conversation',
  'Frying (food)',
  'Blender',
  'Snoring',
]);

export function processSoundDetection(input: ProcessEventInput): ProcessEventResult {
  const db = getDb();

  // Read settings
  const thresholdRow = db.prepare(`SELECT setting_value FROM settings WHERE setting_key = 'confidence_threshold'`).get() as { setting_value: string } | undefined;
  const minConfidence = thresholdRow ? parseFloat(thresholdRow.setting_value) : 0.40;

  const cooldownRow = db.prepare(`SELECT setting_value FROM settings WHERE setting_key = 'duplicate_cooldown_sec'`).get() as { setting_value: string } | undefined;
  const cooldownSec = cooldownRow ? parseFloat(cooldownRow.setting_value) : 4.0;

  const groupingWindowRow = db.prepare(`SELECT setting_value FROM settings WHERE setting_key = 'continuous_grouping_window_sec'`).get() as { setting_value: string } | undefined;
  const groupingWindowSec = groupingWindowRow ? parseFloat(groupingWindowRow.setting_value) : 12.0;

  // 1. Confidence check
  if (input.confidence < minConfidence) {
    return {
      status: 'rejected_threshold',
      event: null,
      message: `Confidence ${input.confidence.toFixed(2)} is below threshold ${minConfidence.toFixed(2)}`,
    };
  }

  const timestamp = input.timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nowMs = new Date(timestamp).getTime();
  const source = input.source || 'microphone';
  const duration = input.duration || 1.0;
  const rawSession = input.client_session_id || input.clientSessionId || input.session_id;
  const validatedClientSession = validateAndSanitizeSessionId(rawSession);
  const sessionId = validatedClientSession || (typeof input.session_id === 'string' && input.session_id.length <= 128 ? input.session_id : '');

  // 2. Query most recent identical sound in this room
  const lastEvent = db.prepare(`
    SELECT * FROM events
    WHERE sound_class = ? AND room = ? AND source = ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(input.sound_class, input.room, source) as DbEvent | undefined;

  if (lastEvent) {
    const lastEventTime = new Date(lastEvent.timestamp).getTime();
    const elapsedSec = (nowMs - lastEventTime) / 1000;

    // Check Continuous-event grouping
    const isContinuous = CONTINUOUS_SOUND_CLASSES.has(input.sound_class);
    if (isContinuous && elapsedSec >= 0 && elapsedSec <= (lastEvent.duration + groupingWindowSec)) {
      // Group: extend existing event duration and smooth confidence
      const newDuration = Math.round((lastEvent.duration + duration) * 10) / 10;
      const smoothedConfidence = Math.round(((lastEvent.confidence * 0.7) + (input.confidence * 0.3)) * 100) / 100;

      db.prepare(`
        UPDATE events
        SET duration = ?, confidence = ?
        WHERE id = ?
      `).run(newDuration, smoothedConfidence, lastEvent.id);

      const updatedEvent: DbEvent = {
        ...lastEvent,
        duration: newDuration,
        confidence: smoothedConfidence,
      };

      // Re-evaluate activities with updated event
      evaluateRecentActivities(input.room);

      return {
        status: 'grouped',
        event: updatedEvent,
        message: `Grouped into existing ${input.sound_class} event #${lastEvent.id} (duration: ${newDuration}s)`,
      };
    }

    // Check duplicate cooldown for non-continuous sounds (e.g. rapid multiple knocks or triggers within cooldownSec)
    if (!isContinuous && elapsedSec >= 0 && elapsedSec < cooldownSec) {
      return {
        status: 'suppressed',
        event: lastEvent,
        alert: null,
        message: `Suppressed duplicate sound within cooldown (${elapsedSec.toFixed(1)}s < ${cooldownSec}s)`,
      };
    }

  }

  // 3. Create a new event
  const insertStmt = db.prepare(`
    INSERT INTO events (sound_class, confidence, room, timestamp, duration, source, session_id, client_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    input.sound_class,
    input.confidence,
    input.room,
    timestamp,
    duration,
    source,
    sessionId,
    validatedClientSession
  );

  const newEventId = Number(result.lastInsertRowid);
  const newEvent: DbEvent = {
    id: newEventId,
    sound_class: input.sound_class,
    confidence: input.confidence,
    room: input.room,
    timestamp,
    duration,
    source,
    session_id: sessionId,
    client_session_id: validatedClientSession,
  };

  // 4. Trigger alert evaluation
  const alert = checkForAlert(newEvent);

  // 5. Trigger activity interpretation engine
  evaluateRecentActivities(input.room);

  return {
    status: 'created',
    event: newEvent,
    alert,
  };
}
