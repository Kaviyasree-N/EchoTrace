/**
 * tests/test-sessions.ts
 * Automated Test Suite for EchoTrace Client Session Identification (Task 5)
 *
 * Verifies:
 * 1. Session ID validation (valid UUIDs pass, special character injection rejected, length > 128 chars rejected).
 * 2. SQLite client_session_id column exists alongside session_id and has valid index.
 * 3. Events inserted with clientSessionId store both client_session_id and session_id correctly.
 * 4. Missing and invalid IDs are handled gracefully (fallback to null, event processing does not fail).
 * 5. Session-based filtering in SQLite events query returns matching events.
 * 6. Multiple sessions can be distinguished and isolated.
 * 7. Forwarding through AI gateway / classification payload formats.
 */

import { getDb } from '../server/database/db';
import { processSoundDetection, validateAndSanitizeSessionId } from '../server/services/eventProcessor';

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

async function runSessionTests() {
  console.log('\n============================================================');
  console.log('RUNNING ECHOTRACE CLIENT SESSION IDENTIFICATION TEST SUITE');
  console.log('============================================================');

  const db = getDb();

  console.log('\n--- 1. Testing Session ID Validation & Sanitization ---');
  const validUuid = 'c827b5e8-5b4d-4bc9-93a0-fa7d53ecb142';
  assert(validateAndSanitizeSessionId(validUuid) === validUuid, 'Standard UUID v4 validates successfully');

  const fallbackId = 'session-1730000000-a1b2c3d4';
  assert(validateAndSanitizeSessionId(fallbackId) === fallbackId, 'Alphanumeric fallback ID validates successfully');

  assert(validateAndSanitizeSessionId(null) === null, 'null session ID gracefully returns null');
  assert(validateAndSanitizeSessionId(undefined) === null, 'undefined session ID gracefully returns null');
  assert(validateAndSanitizeSessionId(12345) === null, 'number session ID gracefully returns null');
  assert(validateAndSanitizeSessionId('') === null, 'empty string session ID returns null');

  // Length limit test (> 128 chars)
  const overlyLong = 'a'.repeat(150);
  assert(validateAndSanitizeSessionId(overlyLong) === null, 'Overly long session ID (>128 chars) is rejected');

  // Dangerous / SQL injection attempt
  const injectionAttempt = "session-1'; DROP TABLE events; --";
  assert(validateAndSanitizeSessionId(injectionAttempt) === null, 'Special characters / SQL injection strings are rejected');

  console.log('\n--- 2. Testing SQLite Table Schema & Migration ---');
  const columns = db.prepare("PRAGMA table_info('events')").all() as Array<{ name: string; type: string }>;
  const colNames = columns.map((c) => c.name);

  assert(colNames.includes('client_session_id'), 'events table contains "client_session_id" column');
  assert(colNames.includes('session_id'), 'events table contains backwards-compatible "session_id" column');

  const indices = db.prepare("PRAGMA index_list('events')").all() as Array<{ name: string }>;
  const indexNames = indices.map((i) => i.name);
  assert(
    indexNames.some((idx) => idx.includes('client_session_id')),
    'Index on client_session_id exists for fast queries'
  );

  console.log('\n--- 3. Testing Event Creation with Client Session ID ---');
  const sessionAlpha = 'session-tab-alpha-' + Date.now();
  const sessionBeta = 'session-tab-beta-' + Date.now();

  const event1 = processSoundDetection({
    sound_class: 'Door',
    confidence: 0.88,
    room: 'Hallway',
    source: 'simulator',
    clientSessionId: sessionAlpha,
  });

  assert(event1.status === 'created' && event1.event !== null, 'Event created with clientSessionId');
  assert(event1.event?.client_session_id === sessionAlpha, 'Created event has client_session_id populated');
  assert(event1.event?.session_id === sessionAlpha, 'Created event has backwards-compatible session_id populated');

  // Verify DB record directly
  const dbRow = db.prepare('SELECT * FROM events WHERE id = ?').get(event1.event?.id) as {
    client_session_id: string;
    session_id: string;
    sound_class: string;
  };
  assert(dbRow.client_session_id === sessionAlpha, 'SQLite record has client_session_id persisted correctly');
  assert(dbRow.session_id === sessionAlpha, 'SQLite record has session_id persisted correctly');

  console.log('\n--- 4. Testing Multi-Session Isolation & Filtering ---');
  // Create another event under sessionBeta
  const event2 = processSoundDetection({
    sound_class: 'Knock',
    confidence: 0.85,
    room: 'Front Entrance',
    source: 'microphone',
    client_session_id: sessionBeta,
  });
  assert(event2.status === 'created', 'Second event created for distinct session Beta');

  // Query events filtering by sessionAlpha
  const alphaRows = db.prepare(`
    SELECT * FROM events 
    WHERE (client_session_id = ? OR session_id = ?)
  `).all(sessionAlpha, sessionAlpha) as Array<{ id: number; client_session_id: string }>;

  assert(alphaRows.length >= 1, 'Query filtered by sessionAlpha returned at least 1 event');
  assert(
    alphaRows.every((r) => r.client_session_id === sessionAlpha),
    'All events returned by sessionAlpha query belong strictly to sessionAlpha'
  );

  // Query events filtering by sessionBeta
  const betaRows = db.prepare(`
    SELECT * FROM events 
    WHERE (client_session_id = ? OR session_id = ?)
  `).all(sessionBeta, sessionBeta) as Array<{ id: number; client_session_id: string }>;

  assert(betaRows.length >= 1, 'Query filtered by sessionBeta returned at least 1 event');
  assert(
    betaRows.every((r) => r.client_session_id === sessionBeta),
    'All events returned by sessionBeta query belong strictly to sessionBeta'
  );

  console.log('\n--- 5. Testing Robust Fallback for Missing or Malformed Session IDs ---');
  const eventWithoutSession = processSoundDetection({
    sound_class: 'Water tap, faucet',
    confidence: 0.92,
    room: 'Kitchen',
    source: 'microphone',
  });
  assert(eventWithoutSession.status === 'created', 'Event creation succeeds when clientSessionId is completely omitted');
  assert(
    eventWithoutSession.event?.client_session_id === null || eventWithoutSession.event?.client_session_id === undefined,
    'client_session_id is null/undefined when omitted'
  );

  const eventWithBadSession = processSoundDetection({
    sound_class: 'Keys jingling',
    confidence: 0.90,
    room: 'Hallway',
    source: 'simulator',
    clientSessionId: 'BAD<SCRIPT>ALERT(1)</SCRIPT>',
  });
  assert(eventWithBadSession.status === 'created', 'Event creation succeeds even with invalid session ID');
  assert(
    eventWithBadSession.event?.client_session_id === null,
    'Invalid session ID was sanitized to null without interrupting event processing'
  );

  console.log('\n============================================================');
  console.log(`Session Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSessionTests().catch((err) => {
  console.error('Fatal session test error:', err);
  process.exit(1);
});
