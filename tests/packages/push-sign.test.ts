import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signPush, verifyPush, verifyPushRequest, TS_HEADER, SIG_HEADER } from '../../packages/push-sign/src/index.ts';

const S = 'test-push-secret-0123456789';
const NOW = 1_800_000_000_000;

test('format: hex HMAC over purpose.v1.ts.path.body (what n8n signs with node crypto)', async () => {
  const { ts, sig } = await signPush(S, 'jbxingest', '/ingest/snap:x', '{"a":1}', NOW);
  assert.equal(ts, String(NOW));
  assert.equal(sig, createHmac('sha256', S).update(`jbxingest.v1.${NOW}./ingest/snap:x.{"a":1}`).digest('hex'));
});
test('verify and refusals', async () => {
  const { ts, sig } = await signPush(S, 'jbxsync', '/p', 'body', NOW);
  const v = (o: any = {}) => verifyPush({ ts: o.ts ?? ts, sig: o.sig ?? sig }, o.secret ?? S, o.purpose ?? 'jbxsync', o.path ?? '/p', o.body ?? 'body', { now: o.now ?? NOW });
  assert.deepEqual(await v(), { ok: true });
  assert.deepEqual(await v({ secret: '' }), { ok: false, why: 'not_configured' });
  assert.deepEqual(await v({ sig: '' }), { ok: false, why: 'missing' });
  assert.deepEqual(await v({ ts: '123' }), { ok: false, why: 'timestamp' });
  assert.deepEqual(await v({ now: NOW + 120_001 }), { ok: false, why: 'old' });
  assert.deepEqual(await v({ purpose: 'jbxingest' }), { ok: false, why: 'signature' });
  assert.deepEqual(await v({ path: '/q' }), { ok: false, why: 'signature' });
  assert.deepEqual(await v({ body: 'body2' }), { ok: false, why: 'signature' });
  assert.deepEqual(await v({ purpose: 'Bad Purpose' }), { ok: false, why: 'purpose' });
});
test('verifyPushRequest reads the headers and raw body', async () => {
  const body = '{"k":"v"}';
  const { headers } = await signPush(S, 'jbxsync', '/_sync/feeds', body, NOW);
  const req = new Request('https://w.example.invalid/_sync/feeds?x=1', { method: 'POST', headers, body });
  const r = await verifyPushRequest(req, S, 'jbxsync', { now: NOW });
  assert.equal(r.ok, true); assert.equal(r.body, body);
  assert.ok(headers[TS_HEADER] && headers[SIG_HEADER]);
});
