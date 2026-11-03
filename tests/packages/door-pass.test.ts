import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyDoorPass, signDoorPass } from '../../packages/door-pass/src/index.ts';

const S = 'test-door-secret-0123456789';
const NOW = 1_800_000_000_000;
const ID = { e: 'csr.test@example.invalid', r: 'super', rs: ['super', 'staff'] };

// The live front door's own signing (jbx-front-door v42 identityHeader + b64urlEncode), byte for byte.
function doorSign(secret: string, ident: any, path: string, iat: number) {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ e: ident.e, r: ident.r, rs: ident.rs, iat, p: path }))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'v1.' + payload + '.' + createHmac('sha256', secret).update('jbxid.' + payload).digest('hex');
}

test('a pass signed exactly as the front door signs it verifies', async () => {
  const h = doorSign(S, ID, '/analytics/jbx-customer-ltv', NOW);
  const r = await verifyDoorPass(h, S, { path: '/analytics/jbx-customer-ltv', now: NOW + 1000 });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.ident.e, ID.e); assert.deepEqual(r.ident.rs, ID.rs); }
});
test('signDoorPass = the front door, including non-ASCII', async () => {
  const id = { e: 'zoë@example.invalid', r: 'staff', rs: ['staff'] };
  assert.equal(await signDoorPass(S, id, '/x', NOW), doorSign(S, id, '/x', NOW));
});
test('refusals', async () => {
  const good = await signDoorPass(S, ID, '/a', NOW);
  const v = (h: any, s: any, o: any = {}) => verifyDoorPass(h, s, Object.assign({ path: '/a', now: NOW }, o));
  assert.deepEqual(await v(good, ''), { ok: false, why: 'not_configured' });
  assert.deepEqual(await v('', S), { ok: false, why: 'missing' });
  assert.deepEqual(await v('v2.' + good.slice(3), S), { ok: false, why: 'format' });
  assert.deepEqual(await v(good, 'another-secret-value'), { ok: false, why: 'signature' });
  assert.deepEqual(await v(good.slice(0, -1) + (good.endsWith('0') ? '1' : '0'), S), { ok: false, why: 'signature' });
  assert.deepEqual(await v(good, S, { now: NOW + 5 * 60 * 1000 + 1 }), { ok: false, why: 'age' });
  assert.deepEqual(await v(good, S, { now: NOW - 5 * 60 * 1000 - 1 }), { ok: false, why: 'age' });
  assert.deepEqual(await v(good, S, { path: '/a/' }), { ok: false, why: 'path' });
  assert.deepEqual(await v(good, S, { roles: ['warehouse'] }), { ok: false, why: 'role' });
  assert.equal((await v(good, S, { roles: ['staff'] })).ok, true);
});
