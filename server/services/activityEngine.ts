import { getDb, type DbActivity, type DbEvent } from '../database/db.ts';

export function evaluateRecentActivities(targetRoom: string): DbActivity | null {
  const db = getDb();

  // Read configurable window
  const windowRow = db.prepare(`SELECT setting_value FROM settings WHERE setting_key = 'activity_window_min'`).get() as { setting_value: string } | undefined;
  const windowMin = windowRow ? parseInt(windowRow.setting_value, 10) : 15;

  const cutoff = new Date(Date.now() - windowMin * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Fetch recent events in this room
  const recentEvents = db.prepare(`
    SELECT * FROM events
    WHERE room = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(targetRoom, cutoff) as DbEvent[];

  if (recentEvents.length < 2) return null;

  const eventSoundClasses = new Set(recentEvents.map((e) => e.sound_class));
  const eventIds = recentEvents.map((e) => e.id);
  const startTime = recentEvents[0].timestamp;
  const endTime = recentEvents[recentEvents.length - 1].timestamp;

  // Average confidence
  const avgConfidence = Math.round(
    (recentEvents.reduce((acc, curr) => acc + curr.confidence, 0) / recentEvents.length) * 100
  ) / 100;

  let activityType: string | null = null;
  let description: string | null = null;

  // Rule 1: Kitchen Preparation / Mealtime
  if (targetRoom === 'Kitchen') {
    const kitchenSounds = ['Water tap, faucet', 'Dishes, pots, and pans', 'Coffee maker', 'Microwave oven', 'Cupboard', 'Stove', 'Frying (food)'];
    const matched = kitchenSounds.filter((s) => eventSoundClasses.has(s));
    if (matched.length >= 2 || (matched.length >= 1 && eventSoundClasses.has('Footsteps'))) {
      activityType = 'Kitchen Activity';
      description = `Possible kitchen or meal preparation observed in Kitchen (${matched.join(', ')}).`;
    }
  }

  // Rule 2: Bathroom Hygiene Routine
  if (targetRoom === 'Bathroom') {
    const bathroomSounds = ['Water tap, faucet', 'Toilet flush', 'Shower', 'Bathtub (filling or washing)'];
    const matched = bathroomSounds.filter((s) => eventSoundClasses.has(s));
    if (matched.length >= 1) {
      activityType = 'Hygiene Routine';
      description = `Possible personal hygiene routine detected in Bathroom (${matched.join(', ')}).`;
    }
  }

  // Rule 3: Room Transition / Movement
  if (eventSoundClasses.has('Door') || eventSoundClasses.has('Keys jingling') || eventSoundClasses.has('Knock') || eventSoundClasses.has('Sliding door')) {
    if (eventSoundClasses.has('Footsteps') || eventSoundClasses.has('Keys jingling') || eventSoundClasses.has('Door')) {
      activityType = 'Room Transition / Movement';
      description = `Possible movement, door access, or room transition observed in ${targetRoom}.`;
    }
  }

  // Rule 4: Leisure / Media
  if (eventSoundClasses.has('Television') || eventSoundClasses.has('Radio')) {
    activityType = 'Media & Leisure';
    description = `Possible television or radio entertainment activity in ${targetRoom}.`;
  }

  // Rule 5: Unusual Disturbance
  if (eventSoundClasses.has('Glass breaking') || eventSoundClasses.has('Crying, sobbing') || eventSoundClasses.has('Smoke detector, smoke alarm')) {
    activityType = 'Unusual Ambient Sound Pattern';
    description = `Potential unusual sound cluster detected in ${targetRoom}. Caregiver attention recommended.`;
  }

  if (!activityType || !description) return null;

  // Check if an identical activity was already logged within the last 15 minutes to avoid duplicates
  const existing = db.prepare(`
    SELECT * FROM activities
    WHERE activity_type = ? AND room = ?
    ORDER BY end_time DESC LIMIT 1
  `).get(activityType, targetRoom) as DbActivity | undefined;

  if (existing) {
    const lastEndMs = new Date(existing.end_time).getTime();
    const currentStartMs = new Date(startTime).getTime();
    // If overlapping or within 10 minutes, update existing activity
    if (Math.abs(currentStartMs - lastEndMs) < 10 * 60 * 1000) {
      // Merge related events
      const prevIds: number[] = JSON.parse(existing.related_event_ids || '[]');
      const combinedIds = Array.from(new Set([...prevIds, ...eventIds]));

      db.prepare(`
        UPDATE activities
        SET end_time = ?, related_event_ids = ?, confidence = ?
        WHERE id = ?
      `).run(endTime, JSON.stringify(combinedIds), avgConfidence, existing.id);

      return {
        ...existing,
        end_time: endTime,
        related_event_ids: JSON.stringify(combinedIds),
        confidence: avgConfidence,
      };
    }
  }

  // Insert new activity
  const insertStmt = db.prepare(`
    INSERT INTO activities (activity_type, description, room, start_time, end_time, confidence, related_event_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    activityType,
    description,
    targetRoom,
    startTime,
    endTime,
    avgConfidence,
    JSON.stringify(eventIds)
  );

  return {
    id: Number(result.lastInsertRowid),
    activity_type: activityType,
    description,
    room: targetRoom,
    start_time: startTime,
    end_time: endTime,
    confidence: avgConfidence,
    related_event_ids: JSON.stringify(eventIds),
  };
}

export function getActivities(limit: number = 30, roomFilter?: string): DbActivity[] {
  const db = getDb();
  let query = `SELECT * FROM activities`;
  const params: unknown[] = [];

  if (roomFilter && roomFilter !== 'All Rooms') {
    query += ` WHERE room = ?`;
    params.push(roomFilter);
  }

  query += ` ORDER BY end_time DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as DbActivity[];
}
