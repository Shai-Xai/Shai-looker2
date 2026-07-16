// Release notes (server/releaseNotes.js) — the pure planning brain behind the
// auto-drafter: grouping GitHub-API commits into release-timezone days, and the
// create/refresh/leave-alone decision per day. The fixes these lock in: a day is
// drafted from ALL its commits (GitHub API, not the shallow deploy clone), an
// unpublished auto-draft refreshes when its day gains commits, and published or
// human-edited notes are NEVER touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupCommitsByDay, planDrafts } = require('../server/releaseNotes');

test('groupCommitsByDay(): groups into SAST days, newest sha wins, trailers ride along', () => {
  const days = groupCommitsByDay([
    // 23:30 UTC = 01:30 SAST the NEXT day — must land on the 6th, not the 5th.
    { sha: 'ccc', date: '2026-07-05T23:30:00Z', subject: 'Late-night fix', body: '' },
    { sha: 'bbb', date: '2026-07-05T18:00:00Z', subject: 'Evening feature', body: 'how-to: open Engage → Links\nmore prose' },
    { sha: 'aaa', date: '2026-07-05T09:00:00Z', subject: 'Morning feature', body: '' },
  ]);
  assert.deepEqual(days.map((d) => d.date), ['2026-07-06', '2026-07-05']);
  const jul5 = days.find((d) => d.date === '2026-07-05');
  assert.equal(jul5.sha, 'bbb', 'newest commit of the day is the day sha');
  assert.equal(jul5.commits.length, 2, 'ALL of the day\'s commits are included');
  assert.match(jul5.commits[0], /how-to: open Engage → Links/, 'how-to trailer surfaced to the model');
});

test('planDrafts(): uncovered day → create; sha-moved unpublished auto-draft → refresh', () => {
  const commitDays = [
    { date: '2026-07-07', sha: 'new7', commits: ['a', 'b'] },
    { date: '2026-07-06', sha: 'new6', commits: ['c'] },
    { date: '2026-07-05', sha: 'same5', commits: ['d'] },
  ];
  const notes = [
    { id: 'n6', date: '2026-07-06', published: false, source: 'auto', lastSha: 'old6', updatedAt: '2026-07-06T00:10:00Z' },
    { id: 'n5', date: '2026-07-05', published: false, source: 'auto', lastSha: 'same5', updatedAt: '2026-07-05T00:10:00Z' },
  ];
  const plan = planDrafts({ commitDays, notes, minAgeMs: 0 });
  assert.deepEqual(plan.create.map((d) => d.date), ['2026-07-07'], 'day with no note is created');
  assert.deepEqual(plan.refresh.map((r) => r.day.date), ['2026-07-06'], 'stale unpublished auto-draft refreshes');
  // sha unchanged → left alone (no churn, no wasted AI calls)
  assert.ok(!plan.refresh.some((r) => r.day.date === '2026-07-05'));
});

test('planDrafts(): published or human-edited notes are NEVER refreshed', () => {
  const commitDays = [{ date: '2026-07-06', sha: 'newer', commits: ['x'] }];
  const published = planDrafts({ commitDays, notes: [{ id: 'p', date: '2026-07-06', published: true, source: 'auto', lastSha: 'old', updatedAt: '2026-07-06T00:00:00Z' }], minAgeMs: 0 });
  assert.equal(published.refresh.length, 0, 'published note frozen');
  assert.equal(published.create.length, 0, 'covered day not re-created');
  const edited = planDrafts({ commitDays, notes: [{ id: 'm', date: '2026-07-06', published: false, source: 'manual', lastSha: 'old', updatedAt: '2026-07-06T00:00:00Z' }], minAgeMs: 0 });
  assert.equal(edited.refresh.length, 0, 'human-edited (manual) note frozen');
});

test('planDrafts(): the age damper skips a recently-touched note (deploy storms don\'t churn)', () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  const commitDays = [{ date: '2026-07-06', sha: 'newer', commits: ['x'] }];
  const note = { id: 'n', date: '2026-07-06', published: false, source: 'auto', lastSha: 'old', updatedAt: '2026-07-06T11:30:00Z' }; // 30 min ago
  const damped = planDrafts({ commitDays, notes: [note], minAgeMs: 45 * 60 * 1000, now });
  assert.equal(damped.refresh.length, 0, 'refreshed 30 min ago + 45-min damper → wait');
  const due = planDrafts({ commitDays, notes: [note], minAgeMs: 20 * 60 * 1000, now });
  assert.equal(due.refresh.length, 1, 'past the damper → refresh');
});
