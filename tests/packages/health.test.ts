import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthBody, healthResponse } from '../../packages/health/src/index.ts';

test('only booleans, never values', async () => {
  const b = healthBody({ worker: 'jbx-x', version: 'v2', configured: { DOOR_SECRET: 'very-secret', PUSH_SECRET: '' }, bound: { DB: {}, KV: undefined } });
  assert.deepEqual(b, { ok: true, worker: 'jbx-x', version: 'v2', configured: { DOOR_SECRET: true, PUSH_SECRET: false }, bound: { DB: true, KV: false } });
  const r = healthResponse({ worker: 'jbx-x', configured: { DOOR_SECRET: 'very-secret' } });
  const t = await r.text();
  assert.equal(r.status, 200); assert.ok(!t.includes('very-secret'));
});
