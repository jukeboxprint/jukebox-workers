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
