// scripts/door/worker.mjs wantBindings: what a version for each env must carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantBindings } from '../../scripts/door/worker.mjs';

const toml = {
  name: 'jbx-x', vars: { A: '1' }, hyperdrive: [{ binding: 'MYSQL', id: 'h'.repeat(32) }],
  kv_namespaces: [{ binding: 'KV', id: 'k1' }],
  env: { staging: { name: 'jbx-x-staging', vars: { A: '1' }, kv_namespaces: [{ binding: 'KV', id: 'k2' }] } },
};
test('hyperdrive: live carries it', () => {
  assert.ok(wantBindings(toml, 'live').includes('hyperdrive MYSQL ' + 'h'.repeat(32)));
});
test('hyperdrive: never inherited by an env (staging without its own has none)', () => {
  assert.ok(!wantBindings(toml, 'staging').some(b => b.startsWith('hyperdrive ')));
});
test('hyperdrive: an env with its own gets its own', () => {
  const t = structuredClone(toml); t.env.staging.hyperdrive = [{ binding: 'MYSQL', id: 's'.repeat(32) }];
  assert.deepEqual(wantBindings(t, 'staging').filter(b => b.startsWith('hyperdrive ')), ['hyperdrive MYSQL ' + 's'.repeat(32)]);
});
test('a TBD hyperdrive id shows as TBD (drift and proof refuse it, as for KV and D1)', () => {
  const t = structuredClone(toml); t.hyperdrive[0].id = 'TBD';
  assert.ok(wantBindings(t, 'live').some(b => b === 'hyperdrive MYSQL TBD'));
});

// pollHealth: health after a deploy is polled until it answers ok, within health_wait_s.
import { pollHealth } from '../../scripts/door/worker.mjs';
const seq = answers => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)]; };
const noSleep = async () => {};
test('pollHealth: ok at once is one read', async () => {
  assert.deepEqual(await pollHealth(seq(['ok']), { wait_s: 90, poll_s: 5, sleep: noSleep }), { ok: true, why: 'ok', tries: 1 });
});
test('pollHealth: the old version first, then the new one: ok on the third read', async () => {
  const r = await pollHealth(seq(['/health version is "v3", want "v4"', '/health answered 0', 'ok']), { wait_s: 90, poll_s: 5, sleep: noSleep });
  assert.deepEqual(r, { ok: true, why: 'ok', tries: 3 });
});
test('pollHealth: never ok within the limit: fails with the last reason and the number of reads', async () => {
  const slept = [];
  const r = await pollHealth(seq(['/health answered 503']), { wait_s: 20, poll_s: 5, sleep: async ms => { slept.push(ms); } });
  assert.equal(r.ok, false); assert.equal(r.tries, 5);
  assert.equal(r.why, '/health answered 503 (5 reads over 20 s)');
  assert.deepEqual(slept, [5000, 5000, 5000, 5000]);
});
test('pollHealth: wait_s 0 is one read, as before', async () => {
  const r = await pollHealth(seq(['/health answered 500', 'ok']), { wait_s: 0, poll_s: 5, sleep: noSleep });
  assert.deepEqual([r.ok, r.tries], [false, 1]);
});
test('pollHealth: missing settings default to 90 s every 5 s (19 reads)', async () => {
  const r = await pollHealth(seq(['no']), { sleep: noSleep });
  assert.equal(r.tries, 19);
});

// retryRead: an analytics read that fails is retried before the rollout counts it as unreadable.
import { retryRead } from '../../scripts/door/worker.mjs';
const flaky = outcomes => { let i = 0; return async () => { const o = outcomes[Math.min(i++, outcomes.length - 1)]; if (o instanceof Error) throw o; return o; }; };
test('retryRead: a good first read is one read, no retry', async () => {
  const seen = [];
  assert.deepEqual(await retryRead(flaky([['n', 'o']]), { tries: 3, wait_s: 10, sleep: noSleep, onRetry: a => seen.push(a) }), ['n', 'o']);
  assert.deepEqual(seen, []);
});
test('retryRead: one timeout, then a good read: the good read, one retry told, one wait', async () => {
  const seen = [], slept = [];
  const r = await retryRead(flaky([new Error('The operation was aborted due to timeout'), ['n', 'o']]), { tries: 3, wait_s: 10, sleep: async ms => { slept.push(ms); }, onRetry: (a, e) => seen.push([a, e.message]) });
  assert.deepEqual(r, ['n', 'o']); assert.deepEqual(seen, [[2, 'The operation was aborted due to timeout']]); assert.deepEqual(slept, [10000]);
});
test('retryRead: unreadable every time: throws the last error after tries reads', async () => {
  let reads = 0;
  await assert.rejects(retryRead(async () => { reads++; throw new Error('timeout ' + reads); }, { tries: 3, wait_s: 10, sleep: noSleep }), /timeout 3/);
  assert.equal(reads, 3);
});
test('retryRead: missing settings default to 3 tries; tries 1 is one read, as before', async () => {
  let reads = 0;
  await assert.rejects(retryRead(async () => { reads++; throw new Error('x'); }, { sleep: noSleep }));
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(retryRead(async () => { reads++; throw new Error('x'); }, { tries: 1, sleep: noSleep }));
  assert.equal(reads, 1);
});

// Cron triggers: the toml's [triggers] crons per env, checked and compared.
import { cronsFor, validCron, cronPlan } from '../../scripts/door/worker.mjs';
test('cronsFor: top-level crons, inherited by an env that sets none; an env\'s own replace them', () => {
  const t = { name: 'jbx-x', triggers: { crons: ['*/15 10-13 * * *'] }, env: { staging: { name: 'jbx-x-staging' } } };
  assert.deepEqual(cronsFor(t, 'live'), ['*/15 10-13 * * *']);
  assert.deepEqual(cronsFor(t, 'staging'), ['*/15 10-13 * * *']);
  t.env.staging.triggers = { crons: [] };
  assert.deepEqual(cronsFor(t, 'staging'), []);
  assert.deepEqual(cronsFor({ name: 'jbx-y' }, 'live'), []);
});
test('validCron: five fields; ranges, lists, steps and names; typos refused', () => {
  for (const ok of ['*/15 10-13 * * *', '0 3 * * 1-5', '30 2 1,15 * MON', '0 */6 * * *']) assert.ok(validCron(ok), ok);
  for (const bad of ['*/15 10-13 * *', '0 3 * * * *', '0 3 * * ?', '', '0 3 ** * *']) assert.ok(!validCron(bad), bad);
});
test('cronPlan: same set in any order is same; added, removed or changed is set', () => {
  assert.equal(cronPlan(['0 3 * * *', '0 4 * * *'], ['0 4 * * *', '0 3 * * *']), 'same');
  assert.equal(cronPlan([], []), 'same');
  assert.equal(cronPlan(['0 3 * * *'], []), 'set');
  assert.equal(cronPlan([], ['0 3 * * *']), 'set');
  assert.equal(cronPlan(['0 3 * * *'], ['0 4 * * *']), 'set');
});
