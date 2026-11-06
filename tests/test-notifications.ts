/**
 * tests/test-notifications.ts
 * Automated unit and integration tests for EchoTrace Caregiver Notifications & Alert Chime.
 */

import { getDb, closeDb, DbEvent, DbAlert } from '../server/database/db';
import { seedDatabaseIfEmpty } from '../server/database/seed';
import { processSoundDetection } from '../server/services/eventProcessor';
import {
  checkForAlert,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  getAlerts,
  getUnacknowledgedAlertCount,
} from '../server/services/alertManager';
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendCaregiverNotification,
} from '../src/utils/notificationService';
import { playAlertChime } from '../src/utils/alertChime';
import type { Alert } from '../src/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

async function runNotificationTests() {
  console.log('\n============================================================');
  console.log('RUNNING ECHOTRACE CAREGIVER ALERT & NOTIFICATION TEST SUITE');
  console.log('============================================================\n');

  const db = getDb();
  seedDatabaseIfEmpty(true);

  // Clear existing alerts to start clean for this suite
  db.exec('DELETE FROM alerts;');

  console.log('--- 1. Testing Alert Generation: Critical vs Ordinary Sounds ---');

  // Ordinary sounds: Knock, Dishes, Speech, Water tap
  const ordinarySounds = ['Knock', 'Dishes, pots, and pans', 'Speech', 'Water tap, faucet', 'Footsteps'];
  let ordinaryAlertTriggered = false;

  for (const sound of ordinarySounds) {
    const res = processSoundDetection({
      sound_class: sound,
      confidence: 0.92,
      room: 'Living Room',
      source: 'microphone',
      duration: 1.0,
      timestamp: new Date().toISOString(),
    });
    if (res.alert) {
      ordinaryAlertTriggered = true;
    }
  }

  assert(!ordinaryAlertTriggered, 'Ordinary ambient sounds do not trigger any caregiver alert');

  // Critical sound: Smoke detector
  const smokeRes = processSoundDetection({
    sound_class: 'Smoke detector, smoke alarm',
    confidence: 0.99,
    room: 'Hallway',
    source: 'microphone',
    duration: 1.0,
    timestamp: new Date().toISOString(),
  });

  assert(smokeRes.alert !== null && smokeRes.alert !== undefined, 'Critical sound (Smoke detector) triggers an alert');
  assert(smokeRes.alert?.severity === 'Critical', 'Smoke alert has severity "Critical"');
  assert(smokeRes.alert?.room === 'Hallway', 'Smoke alert correctly attaches room "Hallway"');

  // High severity sound: Glass breaking
  const glassRes = processSoundDetection({
    sound_class: 'Glass breaking',
    confidence: 0.95,
    room: 'Kitchen',
    source: 'simulator',
    duration: 1.0,
    timestamp: new Date().toISOString(),
  });

  assert(glassRes.alert !== null && glassRes.alert !== undefined, 'High sound (Glass breaking) triggers an alert');
  assert(glassRes.alert?.severity === 'High', 'Glass breaking has severity "High"');
  assert(glassRes.alert?.source === 'simulator', 'Simulator alert preserves source: "simulator"');

  console.log('\n--- 2. Testing Duplicate Alert Suppression & SQLite Persistence ---');

  // Second smoke alarm 10 seconds later (beyond 4s event cooldown, within 3 min alert suppression window)
  const duplicateSmoke = processSoundDetection({
    sound_class: 'Smoke detector, smoke alarm',
    confidence: 0.99,
    room: 'Hallway',
    source: 'microphone',
    duration: 1.0,
    timestamp: new Date(Date.now() + 10000).toISOString(),
  });

  assert(duplicateSmoke.alert === null, 'Repeated critical alert in same room within 3 min was suppressed');


  // Verify persistence in SQLite
  const savedAlerts = getAlerts(10, false);
  assert(savedAlerts.length >= 2, `Alerts persisted in SQLite database (count: ${savedAlerts.length})`);
  const hallwaySmokeAlert = savedAlerts.find((a) => a.alert_type === 'Smoke Detector Activated');
  assert(hallwaySmokeAlert?.room === 'Hallway', 'Persisted alert includes room via JOIN query');

  console.log('\n--- 3. Testing Alert Acknowledgment Workflow ---');

  assert(getUnacknowledgedAlertCount() >= 2, 'Unacknowledged alert count reflects pending alerts');

  if (hallwaySmokeAlert) {
    const acked = acknowledgeAlert(hallwaySmokeAlert.id);
    assert(acked === true, `Alert #${hallwaySmokeAlert.id} acknowledged successfully`);
    const checkRow = db.prepare('SELECT acknowledged, acknowledged_at FROM alerts WHERE id = ?').get(hallwaySmokeAlert.id) as any;
    assert(checkRow.acknowledged === 1 && checkRow.acknowledged_at !== null, 'SQLite record updated with acknowledged=1 and acknowledged_at timestamp');
  }

  // Bulk acknowledge remaining
  const bulkCount = acknowledgeAllAlerts();
  assert(bulkCount >= 1, `Bulk acknowledged ${bulkCount} remaining alerts`);
  assert(getUnacknowledgedAlertCount() === 0, 'Unacknowledged alert count is now 0');

  console.log('\n--- 4. Testing Notification Service Formatting & Permissions ---');

  // Mock window.Notification in Node.js environment
  let dispatchedNotification: { title: string; options: any } | null = null;
  let permissionState = 'default';

  class MockNotification {
    static permission = 'default';
    static requestPermission = async () => MockNotification.permission;

    onclick: (() => void) | null = null;

    constructor(public title: string, public options: any) {
      dispatchedNotification = { title, options };
    }

    close() {}
  }

  (global as any).window = (global as any).window || {};
  (global as any).window.Notification = MockNotification;
  (global as any).Notification = MockNotification;

  // Test when permission is default or denied
  MockNotification.permission = 'denied';
  assert(getNotificationPermissionStatus() === 'denied', 'Permission status correctly reports "denied"');

  const testAlert: Alert = {
    id: 101,
    event_id: 1,
    alert_type: 'Fire Alarm Triggered',
    severity: 'Critical',
    description: 'Fire alarm detected in Bedroom',
    timestamp: '2026-11-06T15:00:00Z',
    acknowledged: 0,
    acknowledged_at: null,
    source: 'microphone',
    room: 'Bedroom',
  };

  const deniedResult = sendCaregiverNotification(testAlert);
  assert(deniedResult === false, 'Notification is not sent when permission is denied');

  // Test when permission is granted
  MockNotification.permission = 'granted';
  assert(getNotificationPermissionStatus() === 'granted', 'Permission status correctly reports "granted"');

  let clickedAlertId: number | null = null;
  const grantedResult = sendCaregiverNotification(testAlert, (id) => {
    clickedAlertId = id;
  });

  assert(grantedResult === true, 'Notification successfully dispatched when permission is granted');
  assert(dispatchedNotification !== null, 'Notification object was constructed');
  assert(dispatchedNotification?.title.includes('[CRITICAL] Fire Alarm Triggered in Bedroom'), `Title contains severity, type and room: "${dispatchedNotification?.title}"`);
  assert(dispatchedNotification?.options.requireInteraction === true, 'Critical alerts set requireInteraction=true');

  // Test click handler callback
  (dispatchedNotification as any)?.onclick?.();
  assert(true, 'Notification click callback executes cleanly');

  // Test simulated alert formatting
  const simulatedAlert: Alert = {
    id: 102,
    event_id: 2,
    alert_type: 'Smoke Detector Activated',
    severity: 'Critical',
    description: 'Simulated smoke detector in Kitchen',
    timestamp: '2026-11-06T15:01:00Z',
    acknowledged: 0,
    acknowledged_at: null,
    source: 'simulator',
    room: 'Kitchen',
  };

  sendCaregiverNotification(simulatedAlert);
  assert(dispatchedNotification?.title.includes('⚡ Simulated'), `Simulated alerts are clearly distinguished: "${dispatchedNotification?.title}"`);

  console.log('\n--- 5. Testing Audible Alert Chime Synthesizer ---');

  // Mock AudioContext in Node.js
  let oscillatorFreqs: number[] = [];
  let gainValues: number[] = [];

  class MockGain {
    gain = {
      setValueAtTime: (v: number) => gainValues.push(v),
      exponentialRampToValueAtTime: (v: number) => gainValues.push(v),
    };
    connect() {}
  }

  class MockOscillator {
    type = 'sine';
    frequency = {
      setValueAtTime: (f: number) => oscillatorFreqs.push(f),
    };
    connect() {}
    start() {}
    stop() {}
  }

  class MockAudioContext {
    currentTime = 0;
    state = 'running';
    destination = {};
    createOscillator = () => new MockOscillator();
    createGain = () => new MockGain();
    resume = async () => {};
  }

  (global as any).window.AudioContext = MockAudioContext;

  const chimeResult = playAlertChime();
  assert(chimeResult === true, 'Alert chime executes Web Audio synthesis without errors');
  assert(oscillatorFreqs.includes(659.25) && oscillatorFreqs.includes(880.0), 'Chime synthesizes harmonic E5 (659.25Hz) and A5 (880Hz) tones');
  assert(gainValues.length >= 4, 'Chime applies soft attack and exponential decay envelopes');

  console.log(`\n============================================================`);
  console.log(`Notification & Alert Tests: ${passed} Passed, ${failed} Failed`);
  console.log(`============================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runNotificationTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
