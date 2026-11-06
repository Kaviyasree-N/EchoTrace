import { getDb } from './db.ts';

export function seedDatabaseIfEmpty(forceReset: boolean = false): void {
  const db = getDb();

  const countRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
  if (countRow.count > 0 && !forceReset) {
    return; // Already populated, preserve historical records
  }

  if (forceReset) {
    db.exec(`
      DELETE FROM alerts;
      DELETE FROM activities;
      DELETE FROM events;
    `);
  }

  const now = new Date();

  // Seed sample events across rooms from today and yesterday
  const sampleEvents = [
    // Today - Morning Routine (Kitchen)
    { sound: 'Footsteps', room: 'Kitchen', conf: 0.82, offsetMin: 25, duration: 8.0, source: 'microphone' },
    { sound: 'Water tap, faucet', room: 'Kitchen', conf: 0.91, offsetMin: 23, duration: 15.0, source: 'microphone' },
    { sound: 'Dishes, pots, and pans', room: 'Kitchen', conf: 0.88, offsetMin: 20, duration: 22.0, source: 'microphone' },
    { sound: 'Coffee maker', room: 'Kitchen', conf: 0.94, offsetMin: 18, duration: 45.0, source: 'microphone' },
    { sound: 'Cupboard', room: 'Kitchen', conf: 0.77, offsetMin: 15, duration: 2.0, source: 'microphone' },

    // Today - Living Room Activity
    { sound: 'Door', room: 'Living Room', conf: 0.85, offsetMin: 55, duration: 2.5, source: 'microphone' },
    { sound: 'Keys jingling', room: 'Living Room', conf: 0.93, offsetMin: 54, duration: 3.0, source: 'microphone' },
    { sound: 'Television', room: 'Living Room', conf: 0.79, offsetMin: 80, duration: 120.0, source: 'microphone' },
    { sound: 'Speech', room: 'Living Room', conf: 0.83, offsetMin: 95, duration: 18.0, source: 'microphone' },

    // Today - Bedroom & Hallway
    { sound: 'Drawer', room: 'Bedroom', conf: 0.74, offsetMin: 130, duration: 3.0, source: 'microphone' },
    { sound: 'Footsteps', room: 'Hallway', conf: 0.71, offsetMin: 145, duration: 6.0, source: 'microphone' },

    // Today - Bathroom Hygiene
    { sound: 'Water tap, faucet', room: 'Bathroom', conf: 0.89, offsetMin: 175, duration: 25.0, source: 'microphone' },
    { sound: 'Toilet flush', room: 'Bathroom', conf: 0.96, offsetMin: 170, duration: 8.0, source: 'microphone' },

    // Yesterday - Sample data
    { sound: 'Microwave oven', room: 'Kitchen', conf: 0.84, offsetMin: 1440 + 60, duration: 60.0, source: 'microphone' },
    { sound: 'Knock', room: 'Living Room', conf: 0.90, offsetMin: 1440 + 120, duration: 2.0, source: 'microphone' },
    { sound: 'Doorbell', room: 'Hallway', conf: 0.95, offsetMin: 1440 + 121, duration: 3.0, source: 'microphone' },
    { sound: 'Crying, sobbing', room: 'Bedroom', conf: 0.81, offsetMin: 1440 + 200, duration: 12.0, source: 'microphone' },

    // Simulated test sound examples
    { sound: 'Keys jingling', room: 'Living Room', conf: 0.95, offsetMin: 5, duration: 2.0, source: 'simulator' },
    { sound: 'Knock', room: 'Living Room', conf: 0.89, offsetMin: 2, duration: 1.5, source: 'simulator' },
  ];

  const insertEventStmt = db.prepare(`
    INSERT INTO events (sound_class, confidence, room, timestamp, duration, source, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertedIds: number[] = [];

  for (const item of sampleEvents) {
    const time = new Date(now.getTime() - item.offsetMin * 60 * 1000);
    const result = insertEventStmt.run(
      item.sound,
      item.conf,
      item.room,
      time.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      item.duration,
      item.source,
      'seed-session-1'
    );
    insertedIds.push(Number(result.lastInsertRowid));
  }

  // Seed sample activities interpreted from the events
  const insertActivityStmt = db.prepare(`
    INSERT INTO activities (activity_type, description, room, start_time, end_time, confidence, related_event_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const morningStart = new Date(now.getTime() - 26 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const morningEnd = new Date(now.getTime() - 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  insertActivityStmt.run(
    'Kitchen Activity',
    'Possible breakfast or beverage preparation detected with water running, coffee maker, and dishes.',
    'Kitchen',
    morningStart,
    morningEnd,
    0.89,
    JSON.stringify(insertedIds.slice(0, 5))
  );

  const arrivalStart = new Date(now.getTime() - 56 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const arrivalEnd = new Date(now.getTime() - 53 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  insertActivityStmt.run(
    'Room Transition / Arrival',
    'Door opening and keys jingling indicating potential arrival or movement.',
    'Living Room',
    arrivalStart,
    arrivalEnd,
    0.88,
    JSON.stringify(insertedIds.slice(5, 7))
  );

  const hygieneStart = new Date(now.getTime() - 176 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hygieneEnd = new Date(now.getTime() - 169 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  insertActivityStmt.run(
    'Personal Hygiene Routine',
    'Water tap running and toilet flush indicating typical bathroom routine.',
    'Bathroom',
    hygieneStart,
    hygieneEnd,
    0.92,
    JSON.stringify(insertedIds.slice(11, 13))
  );

  // Seed a sample alert
  const insertAlertStmt = db.prepare(`
    INSERT INTO alerts (event_id, alert_type, severity, description, timestamp, acknowledged, acknowledged_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const cryingEventId = insertedIds[16] || null;
  const cryingTime = new Date(now.getTime() - (1440 + 200) * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  insertAlertStmt.run(
    cryingEventId,
    'Distress Sound Detected',
    'Medium',
    'Vocal distress / crying detected in Bedroom. Check on resident if needed.',
    cryingTime,
    1, // Acknowledged in past
    new Date(now.getTime() - (1440 + 190) * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'microphone'
  );
}
