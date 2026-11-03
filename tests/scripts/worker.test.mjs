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
