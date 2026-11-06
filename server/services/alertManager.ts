import { getDb, DbAlert, DbEvent } from '../database/db';

export interface AlertRule {
  soundMatch: string[];
  alertType: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  descriptionTemplate: (event: DbEvent) => string;
}

const ALERT_RULES: AlertRule[] = [
  {
    soundMatch: ['Smoke detector, smoke alarm'],
    alertType: 'Smoke Detector Activated',
    severity: 'Critical',
    descriptionTemplate: (e) =>
      `CRITICAL: Smoke detector alarm sound detected in ${e.room} (confidence: ${Math.round(e.confidence * 100)}%). Immediate caregiver check required!`,
  },
  {
    soundMatch: ['Fire alarm'],
    alertType: 'Fire Alarm Triggered',
    severity: 'Critical',
    descriptionTemplate: (e) =>
      `CRITICAL: Fire alarm detected in ${e.room} (confidence: ${Math.round(e.confidence * 100)}%). Check resident safety immediately!`,
  },
  {
    soundMatch: ['Glass breaking'],
    alertType: 'Glass Breaking / Potential Shatter',
    severity: 'High',
    descriptionTemplate: (e) =>
      `Potential glass breaking or fallen item in ${e.room}. Caregiver inspection advised to prevent injury.`,
  },
  {
    soundMatch: ['Loud impacts', 'Impact', 'Crash'],
    alertType: 'Loud Impact / Possible Fall',
    severity: 'High',
    descriptionTemplate: (e) =>
      `Sudden heavy impact sound detected in ${e.room}. Verify resident has not fallen or dropped a heavy object.`,
  },
  {
    soundMatch: ['Crying, sobbing'],
    alertType: 'Distress Vocalization',
    severity: 'Medium',
    descriptionTemplate: (e) =>
      `Crying or sobbing sounds detected in ${e.room}. Resident may be experiencing anxiety, confusion, or distress.`,
  },
];

export function checkForAlert(event: DbEvent): DbAlert | null {
  const db = getDb();

  const rule = ALERT_RULES.find((r) =>
    r.soundMatch.some((match) => event.sound_class.toLowerCase().includes(match.toLowerCase()))
  );

  if (!rule) return null;

  // Prevent duplicate unacknowledged alerts for the same room & alert type within 3 minutes
  const recentAlert = db.prepare(`
    SELECT a.* FROM alerts a
    LEFT JOIN events e ON a.event_id = e.id
    WHERE a.alert_type = ? AND a.acknowledged = 0 AND (e.room = ? OR e.room IS NULL)
    ORDER BY a.timestamp DESC LIMIT 1
  `).get(rule.alertType, event.room) as DbAlert | undefined;

  if (recentAlert) {
    const timeDiff = Math.abs(new Date(event.timestamp).getTime() - new Date(recentAlert.timestamp).getTime());
    if (timeDiff < 3 * 60 * 1000) {
      return null; // Suppress duplicate unacknowledged alert
    }
  }

  const desc = rule.descriptionTemplate(event);

  const insertStmt = db.prepare(`
    INSERT INTO alerts (event_id, alert_type, severity, description, timestamp, acknowledged, acknowledged_at, source)
    VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
  `);

  const result = insertStmt.run(
    event.id,
    rule.alertType,
    rule.severity,
    desc,
    event.timestamp,
    event.source
  );

  return {
    id: Number(result.lastInsertRowid),
    event_id: event.id,
    alert_type: rule.alertType,
    severity: rule.severity,
    description: desc,
    timestamp: event.timestamp,
    acknowledged: 0,
    acknowledged_at: null,
    source: event.source,
    room: event.room,
  };
}

export function acknowledgeAlert(alertId: number): boolean {
  const db = getDb();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = db.prepare(`
    UPDATE alerts
    SET acknowledged = 1, acknowledged_at = ?
    WHERE id = ?
  `).run(now, alertId);

  return result.changes > 0;
}

export function acknowledgeAllAlerts(): number {
  const db = getDb();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = db.prepare(`
    UPDATE alerts
    SET acknowledged = 1, acknowledged_at = ?
    WHERE acknowledged = 0
  `).run(now);

  return result.changes;
}

export function getAlerts(limit: number = 50, onlyUnacknowledged: boolean = false): DbAlert[] {
  const db = getDb();
  let query = `
    SELECT a.*, e.room as room
    FROM alerts a
    LEFT JOIN events e ON a.event_id = e.id
  `;
  if (onlyUnacknowledged) {
    query += ` WHERE a.acknowledged = 0`;
  }
  query += ` ORDER BY a.timestamp DESC LIMIT ?`;
  return db.prepare(query).all(limit) as DbAlert[];
}

export function getUnacknowledgedAlertCount(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0`).get() as { count: number };
  return row.count;
}

