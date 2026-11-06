/**
 * tests/test-backend.ts
 * Comprehensive automated test suite for EchoTrace backend & services
 */

import { getDb, closeDb } from '../server/database/db.ts';
import { seedDatabaseIfEmpty } from '../server/database/seed.ts';
import { processSoundDetection } from '../server/services/eventProcessor.ts';
import { checkForAlert, acknowledgeAlert, getAlerts, getUnacknowledgedAlertCount } from '../server/services/alertManager.ts';
import { evaluateRecentActivities, getActivities } from '../server/services/activityEngine.ts';
import { getDashboardInsights, generateCsvReport } from '../server/services/reportGenerator.ts';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    testsPassed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('\n--- 1. Testing SQLite Database & Seed Initialization ---');
  const db = getDb();
  assert(db !== null, 'Database connection is established');

  seedDatabaseIfEmpty(true); // reset with sample data
  const countRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
  assert(countRow.count > 0, `Database seeded successfully with ${countRow.count} initial events`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);
  assert(tableNames.includes('events'), 'Table "events" exists');
  assert(tableNames.includes('activities'), 'Table "activities" exists');
  assert(tableNames.includes('alerts'), 'Table "alerts" exists');
  assert(tableNames.includes('settings'), 'Table "settings" exists');

  console.log('\n--- 2. Testing Event Processing & Cooldown ---');
  // Confidence threshold test
  const rejected = processSoundDetection({
    sound_class: 'Door',
    confidence: 0.25, // below 0.40 threshold
    room: 'Hallway',
  });
  assert(rejected.status === 'rejected_threshold', 'Low confidence (<0.40) event was rejected');

  // Valid event creation
  const created = processSoundDetection({
    sound_class: 'Knock',
    confidence: 0.89,
    room: 'Hallway',
    source: 'microphone',
  });
  assert(created.status === 'created' && created.event !== null, 'Valid event was created and inserted');

  // Cooldown duplicate suppression
  const duplicate = processSoundDetection({
    sound_class: 'Knock',
    confidence: 0.91,
    room: 'Hallway',
    source: 'microphone',
  });
  assert(duplicate.status === 'suppressed', 'Identical sound in same room within cooldown was suppressed');

  console.log('\n--- 3. Testing Continuous-Event Grouping ---');
  const footstep1 = processSoundDetection({
    sound_class: 'Footsteps',
    confidence: 0.80,
    room: 'Bedroom',
    duration: 2.0,
    source: 'microphone',
  });
  assert(footstep1.status === 'created', 'First footsteps event created');

  const footstep2 = processSoundDetection({
    sound_class: 'Footsteps',
    confidence: 0.85,
    room: 'Bedroom',
    duration: 2.5,
    source: 'microphone',
  });
  assert(footstep2.status === 'grouped', 'Subsequent footsteps within window grouped into single event');
  assert(footstep2.event?.duration === 4.5, `Grouped event duration updated to ${footstep2.event?.duration}s`);

  console.log('\n--- 4. Testing Caregiver Alert Management ---');
  const alertEvent = processSoundDetection({
    sound_class: 'Smoke detector, smoke alarm',
    confidence: 0.98,
    room: 'Kitchen',
    source: 'microphone',
  });
  assert(alertEvent.status === 'created', 'Smoke detector sound logged');

  const alerts = getAlerts(10, true);
  const smokeAlert = alerts.find((a) => a.alert_type === 'Smoke Detector Activated');
  assert(smokeAlert !== undefined, 'Smoke Detector Activated alert generated');
  assert(smokeAlert?.severity === 'Critical', 'Smoke alert has Critical severity');
  assert(smokeAlert?.acknowledged === 0, 'New alert is unacknowledged');

  if (smokeAlert) {
    const ackSuccess = acknowledgeAlert(smokeAlert.id);
    assert(ackSuccess === true, 'Alert acknowledged successfully');
    const updatedAlerts = getAlerts(10, true);
    assert(
      !updatedAlerts.some((a) => a.id === smokeAlert.id),
      'Acknowledged alert is no longer in unacknowledged list'
    );
  }

  console.log('\n--- 5. Testing Activity Intelligence Engine ---');
  // Trigger kitchen cluster
  processSoundDetection({ sound_class: 'Water tap, faucet', confidence: 0.90, room: 'Kitchen', source: 'simulator' });
  processSoundDetection({ sound_class: 'Dishes, pots, and pans', confidence: 0.88, room: 'Kitchen', source: 'simulator' });

  const activities = getActivities(10, 'Kitchen');
  assert(activities.length > 0, `Interpreted ${activities.length} activity routine(s) in Kitchen`);
  const kitchenAct = activities.find((a) => a.activity_type === 'Kitchen Activity');
  assert(kitchenAct !== undefined, 'Kitchen Activity routine detected from sound cluster');

  console.log('\n--- 6. Testing Dashboard Insights & CSV Report ---');
  const insights = getDashboardInsights();
  assert(insights.totalAllTime > 0, `Total events counted: ${insights.totalAllTime}`);
  assert(insights.topSounds.length > 0, `Top sounds returned: ${insights.topSounds.length}`);
  assert(insights.timeOfDay.morning >= 0, 'Time of day morning bin exists');

  const csvReport = generateCsvReport();
  assert(csvReport.includes('--- EVENTS LOG ---'), 'CSV report includes EVENTS LOG section');
  assert(csvReport.includes('--- INTERPRETED ACTIVITIES ---'), 'CSV report includes ACTIVITIES section');
  assert(csvReport.includes('--- CAREGIVER ALERTS ---'), 'CSV report includes ALERTS section');

  console.log(`\n========================================`);
  console.log(`Test Results: ${testsPassed} Passed, ${testsFailed} Failed`);
  console.log(`========================================\n`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
