import { getDb, DbEvent, DbActivity, DbAlert } from '../database/db';

export interface DashboardInsights {
  totalToday: number;
  totalThisWeek: number;
  totalAllTime: number;
  topSounds: Array<{ sound_class: string; count: number }>;
  roomDistribution: Array<{ room: string; count: number; percentage: number }>;
  timeOfDay: {
    morning: number;   // 06:00 - 11:59
    afternoon: number; // 12:00 - 17:59
    evening: number;   // 18:00 - 23:59
    night: number;     // 00:00 - 05:59
  };
  alertsSummary: {
    total: number;
    unacknowledged: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  activitiesCount: number;
}

export function getDashboardInsights(startDateStr?: string, endDateStr?: string): DashboardInsights {
  const db = getDb();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Date filters if supplied
  let dateClause = '';
  const params: unknown[] = [];
  if (startDateStr && endDateStr) {
    dateClause = ' WHERE timestamp >= ? AND timestamp <= ?';
    params.push(startDateStr, endDateStr);
  } else if (startDateStr) {
    dateClause = ' WHERE timestamp >= ?';
    params.push(startDateStr);
  }

  // All time / filtered total
  const totalAllTime = (db.prepare(`SELECT COUNT(*) as c FROM events ${dateClause}`).get(...params) as { c: number }).c;

  // Today
  const totalToday = (db.prepare(`SELECT COUNT(*) as c FROM events WHERE timestamp >= ?`).get(todayStart) as { c: number }).c;

  // This Week
  const totalThisWeek = (db.prepare(`SELECT COUNT(*) as c FROM events WHERE timestamp >= ?`).get(weekStart) as { c: number }).c;

  // Top sounds
  const topSounds = db.prepare(`
    SELECT sound_class, COUNT(*) as count
    FROM events
    ${dateClause}
    GROUP BY sound_class
    ORDER BY count DESC
    LIMIT 8
  `).all(...params) as Array<{ sound_class: string; count: number }>;

  // Room distribution
  const roomRows = db.prepare(`
    SELECT room, COUNT(*) as count
    FROM events
    ${dateClause}
    GROUP BY room
    ORDER BY count DESC
  `).all(...params) as Array<{ room: string; count: number }>;

  const roomDistribution = roomRows.map((r) => ({
    room: r.room,
    count: r.count,
    percentage: totalAllTime > 0 ? Math.round((r.count / totalAllTime) * 100) : 0,
  }));

  // Time of day breakdown (UTC or local time based on ISO string HH)
  const allTimestamps = db.prepare(`SELECT timestamp FROM events ${dateClause}`).all(...params) as Array<{ timestamp: string }>;

  const timeOfDay = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    night: 0,
  };

  for (const item of allTimestamps) {
    try {
      const dt = new Date(item.timestamp);
      const hour = dt.getHours();
      if (hour >= 6 && hour < 12) timeOfDay.morning++;
      else if (hour >= 12 && hour < 18) timeOfDay.afternoon++;
      else if (hour >= 18 && hour < 24) timeOfDay.evening++;
      else timeOfDay.night++;
    } catch {
      // ignore parsing error
    }
  }

  // Alerts summary
  const alertsTotal = (db.prepare(`SELECT COUNT(*) as c FROM alerts`).get() as { c: number }).c;
  const unackAlerts = (db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE acknowledged = 0`).get() as { c: number }).c;
  const criticalAlerts = (db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE severity = 'Critical'`).get() as { c: number }).c;
  const highAlerts = (db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE severity = 'High'`).get() as { c: number }).c;
  const mediumAlerts = (db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE severity = 'Medium'`).get() as { c: number }).c;
  const lowAlerts = (db.prepare(`SELECT COUNT(*) as c FROM alerts WHERE severity = 'Low'`).get() as { c: number }).c;

  // Activities count
  const activitiesCount = (db.prepare(`SELECT COUNT(*) as c FROM activities`).get() as { c: number }).c;

  return {
    totalToday,
    totalThisWeek,
    totalAllTime,
    topSounds,
    roomDistribution,
    timeOfDay,
    alertsSummary: {
      total: alertsTotal,
      unacknowledged: unackAlerts,
      critical: criticalAlerts,
      high: highAlerts,
      medium: mediumAlerts,
      low: lowAlerts,
    },
    activitiesCount,
  };
}

export function generateCsvReport(startDateStr?: string, endDateStr?: string): string {
  const db = getDb();

  let eventQuery = `SELECT * FROM events`;
  const params: unknown[] = [];
  if (startDateStr && endDateStr) {
    eventQuery += ` WHERE timestamp >= ? AND timestamp <= ?`;
    params.push(startDateStr, endDateStr);
  }
  eventQuery += ` ORDER BY timestamp DESC LIMIT 1000`;

  const events = db.prepare(eventQuery).all(...params) as DbEvent[];
  const activities = db.prepare(`SELECT * FROM activities ORDER BY start_time DESC LIMIT 100`).all() as DbActivity[];
  const alerts = db.prepare(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100`).all() as DbAlert[];

  const lines: string[] = [];

  // Header & Metadata
  lines.push('# EchoTrace Caregiver Sound Memory Report');
  lines.push(`# Generated At: ${new Date().toISOString()}`);
  lines.push(`# Reporting Filter: ${startDateStr || 'All'} to ${endDateStr || 'All'}`);
  lines.push(`# Total Events Exported: ${events.length}`);
  lines.push('');

  // 1. Events Table
  lines.push('--- EVENTS LOG ---');
  lines.push('ID,Timestamp,Room,SoundClass,ConfidencePercent,DurationSeconds,Source');
  for (const ev of events) {
    const cleanSound = `"${ev.sound_class.replace(/"/g, '""')}"`;
    const cleanRoom = `"${ev.room.replace(/"/g, '""')}"`;
    lines.push(
      `${ev.id},${ev.timestamp},${cleanRoom},${cleanSound},${Math.round(ev.confidence * 100)},${ev.duration},${ev.source}`
    );
  }
  lines.push('');

  // 2. Interpreted Activities Table
  lines.push('--- INTERPRETED ACTIVITIES ---');
  lines.push('ID,StartTime,EndTime,Room,ActivityType,ConfidencePercent,Description');
  for (const act of activities) {
    const cleanType = `"${act.activity_type.replace(/"/g, '""')}"`;
    const cleanRoom = `"${act.room.replace(/"/g, '""')}"`;
    const cleanDesc = `"${act.description.replace(/"/g, '""')}"`;
    lines.push(
      `${act.id},${act.start_time},${act.end_time},${cleanRoom},${cleanType},${Math.round(act.confidence * 100)},${cleanDesc}`
    );
  }
  lines.push('');

  // 3. Alerts Table
  lines.push('--- CAREGIVER ALERTS ---');
  lines.push('ID,Timestamp,Severity,AlertType,Acknowledged,AcknowledgedAt,Source,Description');
  for (const al of alerts) {
    const cleanType = `"${al.alert_type.replace(/"/g, '""')}"`;
    const cleanDesc = `"${al.description.replace(/"/g, '""')}"`;
    lines.push(
      `${al.id},${al.timestamp},${al.severity},${cleanType},${al.acknowledged ? 'YES' : 'NO'},${al.acknowledged_at || 'N/A'},${al.source},${cleanDesc}`
    );
  }

  return lines.join('\n');
}
