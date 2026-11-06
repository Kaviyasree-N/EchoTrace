import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.ECHOTRACE_DB_PATH || path.join(process.cwd(), 'echotrace.db');

export interface DbEvent {
  id: number;
  sound_class: string;
  confidence: number;
  room: string;
  timestamp: string;
  duration: number;
  source: 'microphone' | 'simulator';
  session_id: string;
  client_session_id?: string | null;
}

export interface DbActivity {
  id: number;
  activity_type: string;
  description: string;
  room: string;
  start_time: string;
  end_time: string;
  confidence: number;
  related_event_ids: string; // JSON string array
}

export interface DbAlert {
  id: number;
  event_id: number | null;
  alert_type: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  description: string;
  timestamp: string;
  acknowledged: number; // 0 or 1
  acknowledged_at: string | null;
  source: 'microphone' | 'simulator';
  room?: string;
}

export interface DbSetting {
  id: number;
  setting_key: string;
  setting_value: string;
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');

    initSchema(dbInstance);
  }
  return dbInstance;
}

function initSchema(db: Database.Database) {
  // Table 1: events
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sound_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      room TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration REAL DEFAULT 1.0,
      source TEXT DEFAULT 'microphone',
      session_id TEXT DEFAULT '',
      client_session_id TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_room ON events(room);
    CREATE INDEX IF NOT EXISTS idx_events_sound ON events(sound_class);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
  `);

  // Safe migration for existing databases:
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
    const colNames = tableInfo.map((c) => c.name);
    if (!colNames.includes('client_session_id')) {
      db.exec(`ALTER TABLE events ADD COLUMN client_session_id TEXT DEFAULT NULL;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_client_session_id ON events(client_session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);`);
  } catch (err) {
    console.warn('[EchoTrace] Migration notice:', err);
  }

  // Table 2: activities
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_type TEXT NOT NULL,
      description TEXT NOT NULL,
      room TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      confidence REAL NOT NULL,
      related_event_ids TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_activities_start_time ON activities(start_time);
    CREATE INDEX IF NOT EXISTS idx_activities_room ON activities(room);
  `);

  // Table 3: alerts
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_at TEXT,
      source TEXT DEFAULT 'microphone',
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged);
  `);

  // Table 4: settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT NOT NULL
    );
  `);

  // Default initial settings
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)
  `);

  insertSetting.run('confidence_threshold', '0.40');
  insertSetting.run('continuous_grouping_window_sec', '12');
  insertSetting.run('activity_window_min', '15');
  insertSetting.run('duplicate_cooldown_sec', '4');
  insertSetting.run('ai_service_url', 'http://127.0.0.1:5000');
  insertSetting.run('alerts_critical_enabled', 'true');
  insertSetting.run('alerts_high_enabled', 'true');
  insertSetting.run('notifications_enabled', 'true');
  insertSetting.run('chime_enabled', 'false');
  insertSetting.run('chime_severity', 'Critical');
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
