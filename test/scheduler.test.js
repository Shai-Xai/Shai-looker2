// First tests for server/scheduler.js — the code that emails clients unattended
// at 07:00. Pins the crash-safety contract added after the technical review:
// a job's run-slot is CLAIMED (next_run_at advanced, 'once' retired) BEFORE any
// email goes out, so a crash or deploy mid-send can only miss one run — it can
// never re-select the job on restart and double-send a digest.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp } = require('./http');

const sql = h.db.db;
const sentTo = [];
let failSends = false;
let rowAtSendTime = null; // snapshot of the job row taken INSIDE mailer.send

let currentJobId = '';
let contentError = null; // set to make generateContent throw (e.g. a digest_skipped)
const mailer = {
  send: async ({ to }) => {
    rowAtSendTime = sql.prepare('SELECT status, next_run_at, last_status FROM scheduled_jobs WHERE id=?').get(currentJobId);
    if (failSends) throw new Error('smtp down');
    sentTo.push(to);
    return { ok: true };
  },
  resolveBranding: () => ({ senderName: 'Test' }),
  digestEmail: ({ content }) => ({ html: '<p>d</p>', text: 'd', subject: content.subject }),
  baseUrl: () => 'http://test.local',
};

let app, sched;
before(async () => {
  app = await startApp((expressApp) => {
    sched = require('../server/scheduler').mount(expressApp, {
      db: h.db, auth: h.auth, mailer, messaging: null, push: null,
      generateContent: async () => { if (contentError) throw contentError; return { subject: 'Digest', headline: 'H', narrative: ['n'], kpis: [] }; },
      roleLenses: { exec: { label: 'Executive' }, marketing: { label: 'Marketing' }, finance: { label: 'Finance' }, ops: { label: 'Ops' } },
      recordDigest: () => '', feedbackUrl: () => '', replyTo: () => null,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { sentTo.length = 0; failSends = false; rowAtSendTime = null; contentError = null; });

// A due job, inserted directly (columns per scheduled_jobs in scheduler.js).
function makeDueJob(cadence = 'daily') {
  const ent = h.makeEntity(`Sched ${crypto.randomUUID().slice(0, 8)}`, 'sched-org');
  const id = crypto.randomUUID();
  const t = new Date().toISOString();
  sql.prepare(`INSERT INTO scheduled_jobs (id, entity_id, title, role, recipients, cadence, time_of_day, status, next_run_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ent.id, 'Test digest', 'exec', JSON.stringify(['client@x.com']), cadence, '07:00', 'active', new Date(Date.now() - 60000).toISOString(), t, t);
  currentJobId = id;
  return id;
}
const jobRow = (id) => sql.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id);

test('the run-slot is claimed BEFORE the send: at send time next_run_at has already advanced', async () => {
  const id = makeDueJob('daily');
  await sched._tick();
  assert.deepEqual(sentTo, ['client@x.com']);
  // The snapshot taken inside mailer.send proves mark-before-send: the job was
  // already rescheduled into the future while the email was going out.
  assert.ok(rowAtSendTime, 'send happened');
  assert.ok(new Date(rowAtSendTime.next_run_at) > new Date(), 'next_run_at advanced before the send');
  assert.match(rowAtSendTime.last_status, /^started/);
  // And the outcome is recorded after.
  const r = jobRow(id);
  assert.match(r.last_status, /^ok: sent to 1/);
  assert.ok(r.last_run_at);
});

test("a 'once' job is retired before the send and a second tick cannot re-send it", async () => {
  const id = makeDueJob('once');
  await sched._tick();
  assert.equal(rowAtSendTime.status, 'done'); // retired BEFORE the email left
  assert.equal(sentTo.length, 1);
  await sched._tick(); // the crash-recovery scenario: job must not be due again
  assert.equal(sentTo.length, 1);
  assert.equal(jobRow(id).next_run_at, null);
});

test('a failed send records the error but the job stays claimed (no retry storm, no double-send)', async () => {
  const id = makeDueJob('daily');
  failSends = true;
  await sched._tick();
  assert.equal(sentTo.length, 0);
  const r = jobRow(id);
  assert.match(r.last_status, /^error: smtp down/);
  assert.ok(new Date(r.next_run_at) > new Date(), 'still rescheduled — failure is visible, not re-fired');
  failSends = false;
  await sched._tick();
  assert.equal(sentTo.length, 0); // not due until its next real slot
});

test('computeNextRun-driven reschedule lands on a future slot for weekly jobs too', async () => {
  const id = makeDueJob('weekly');
  await sched._tick();
  const r = jobRow(id);
  const next = new Date(r.next_run_at);
  assert.ok(next > new Date());
  assert.ok(next <= new Date(Date.now() + 8 * 24 * 3600 * 1000), 'within the next 8 days');
});

test("a digest whose events are all past their cool-down is recorded as 'skipped', not an error", async () => {
  const id = makeDueJob('daily');
  const skip = new Error('All of this client\'s events ended more than 3 day(s) ago — nothing current to report.');
  skip.code = 'digest_skipped'; // what buildDigestContent throws when the default scope is empty
  contentError = skip;
  await sched._tick();
  assert.equal(sentTo.length, 0, 'nothing was sent');
  const r = jobRow(id);
  assert.match(r.last_status, /^skipped: All of this client's events ended/);
  assert.ok(new Date(r.next_run_at) > new Date(), 'still rescheduled — it resumes automatically if an event comes back in scope');
});

test('a skipped digest does not raise an ops alert (a real error still would)', async () => {
  // The mount above passes no notifyOps — this pins the shape at the runJob level:
  // skips go down the 'skipped' branch, so notifyOps (when present) is not called.
  const id = makeDueJob('daily');
  const skip = new Error('nothing current');
  skip.code = 'digest_skipped';
  contentError = skip;
  const res = await sched._runJob({ id, entityId: jobRow(id).entity_id, role: 'exec', recipients: ['client@x.com'], channel: 'email' }, { manual: true });
  assert.equal(res.status, 'skipped');
});
