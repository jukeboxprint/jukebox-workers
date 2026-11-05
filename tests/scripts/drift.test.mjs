// scripts/door/drift.mjs against a fake Cloudflare API. A Worker with no queues reads and answers exactly as v1.0.6 did
// (same requests, same line). With queues (v1.0.7): producer bindings compared like the others, every queue named must
// exist, and consumers are compared with the toml. pipeline.json release_managed.crons (v1.0.8): crons a release adds or
// removes are noted, not refused (byte-identical without the key: drift_parity.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.resolve(HERE, '../../scripts/door/drift.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
const STATE = path.join(dir, 'state.json');
const root = path.join(dir, 'repo');
const WD = path.join(root, 'workers/x');
fs.mkdirSync(WD, { recursive: true });
const SCRIPT_BODY = 'export default { async fetch() { return new Response("x"); } }';
const SHA = crypto.createHash('sha256').update(SCRIPT_BODY).digest('hex');
fs.writeFileSync(path.join(WD, 'release.json'), JSON.stringify({ version: 'v2', sha256: SHA }));
fs.writeFileSync(path.join(WD, 'secrets.json'), JSON.stringify({ live: ['PUSH_SECRET'], staging: { PUSH_SECRET: 'own' } }));
const pipeline = extra => fs.writeFileSync(path.join(WD, 'pipeline.json'), JSON.stringify(Object.assign({ kind: 'passthrough' }, extra)));
const BASE = 'name = "jbx-x"\naccount_id = "acct"\ncompatibility_date = "2026-10-01"\nworkers_dev = true\npreview_urls = false\n\n[vars]\nA = "1"\n\n';
const STAGING = '[env.staging]\nname = "jbx-x-staging"\nworkers_dev = true\npreview_urls = false\n\n[env.staging.vars]\nA = "1"\n\n';
const QUEUES = '[[queues.consumers]]\nqueue = "rows"\nmax_batch_size = 100\nmax_batch_timeout = 5\nmax_retries = 8\ndead_letter_queue = "rows-dlq"\n\n'
  + '[[queues.producers]]\nbinding = "BQ_DLQ"\nqueue = "rows-dlq"\n\n';
const SQUEUES = '[[env.staging.queues.consumers]]\nqueue = "rows-staging"\nmax_batch_size = 100\nmax_batch_timeout = 5\nmax_retries = 8\n\n';
const writeToml = t => fs.writeFileSync(path.join(WD, 'wrangler.toml'), t);
const GOOD = { batch_size: 100, max_retries: 8, max_wait_time_ms: 5000 };
const C = (script, settings = GOOD, dlq = 'rows-dlq') => ({ consumer_id: 'c-' + script, type: 'worker', script, dead_letter_queue: dlq, settings });
const bindings = (extra = []) => [{ type: 'plain_text', name: 'A', text: '1' }, { type: 'secret_text', name: 'PUSH_SECRET' }, ...extra];

const api = http.createServer((req, res) => {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  st.reqs.push(req.url); fs.writeFileSync(STATE, JSON.stringify(st));
  const u = new URL(req.url, 'http://x');
  const ok = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, errors: [], result })); };
  const m = u.pathname.match(/^\/accounts\/acct\/workers\/scripts\/([^/]+)\/(.+)$/);
  if (m && m[2] === 'settings') return ok({ compatibility_date: '2026-10-01', compatibility_flags: [], usage_model: 'standard', bindings: st.bindings[m[1]] || bindings() });
  if (m && m[2] === 'script-settings') return ok({ logpush: false, tail_consumers: [], observability: null });
  if (m && m[2] === 'schedules') return ok({ schedules: (st.crons || []).map(cron => ({ cron })) });
  if (m && m[2] === 'subdomain') return ok({ enabled: true, previews_enabled: false });
  if (m && m[2] === 'content/v2') { res.setHeader('content-type', 'application/javascript'); return res.end(SCRIPT_BODY); }
  if (u.pathname === '/accounts/acct/queues') return ok(st.queues.filter(q => u.searchParams.getAll('name').includes(q.queue_name)));
  res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ message: 'no route ' + req.url }] }));
}).listen(0);
const run = (env, state) => new Promise(resolve => {
  fs.writeFileSync(STATE, JSON.stringify(Object.assign({ reqs: [], bindings: {}, queues: [] }, state)));
  const p = spawn(process.execPath, [SCRIPT, '--worker', 'x', '--env', env], { env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: root, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: `http://127.0.0.1:${api.address().port}` }) });
  let out = ''; p.stdout.on('data', d => out += d);
  p.on('close', code => resolve({ code, out: out.trim(), j: JSON.parse(out.trim().split('\n').pop() || '{}'), reqs: JSON.parse(fs.readFileSync(STATE, 'utf8')).reqs }));
});
const Q = (id, name, consumers = []) => ({ queue_id: id, queue_name: name, consumers });

test('no queues: the same requests and the same line as v1.0.6 (no queue API read)', async () => {
  pipeline(); writeToml(BASE + STAGING);
  const r = await run('live', {});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.reqs, ['settings', 'script-settings', 'schedules', 'subdomain', 'content/v2'].map(x => `/accounts/acct/workers/scripts/jbx-x/${x}`));
  assert.equal(r.out, JSON.stringify({ ok: true, env: 'live', worker: 'jbx-x', deployed: { sha256: SHA, bytes: SCRIPT_BODY.length, is: 'release' },
    release: 'v2', problems: [], notes: ['live observability (dashboard, not changed by a deploy): unset'] }));
});
test('queues on live, all as the toml: ok; the producer binding is compared', async () => {
  pipeline(); writeToml(BASE + QUEUES + STAGING + SQUEUES);
  const live = bindings([{ type: 'queue', name: 'BQ_DLQ', queue_name: 'rows-dlq' }]);
  const r = await run('live', { bindings: { 'jbx-x': live }, queues: [Q('q1', 'rows', [C('jbx-x')]), Q('q2', 'rows-dlq')] });
  assert.equal(r.code, 0, r.out); assert.deepEqual(r.j.problems, []);
  const r2 = await run('live', { queues: [Q('q1', 'rows', [C('jbx-x')]), Q('q2', 'rows-dlq')] });
  assert.equal(r2.code, 1); assert.deepEqual(r2.j.problems, ['missing on live or different: queue BQ_DLQ rows-dlq']);
});
test('a queue the toml names does not exist: refused, named, on staging too', async () => {
  pipeline(); writeToml(BASE + QUEUES + STAGING + SQUEUES);
  const r = await run('staging', { queues: [] });
  assert.equal(r.code, 1);
  assert.deepEqual(r.j.problems, ["queue rows-staging does not exist: create it in the dashboard or with `wrangler queues create rows-staging`, on Tyler's word (the pipeline never creates queues)"]);
});
test('consumer not set yet: noted (the deploy sets it); held by another Worker: refused', async () => {
  pipeline(); writeToml(BASE + QUEUES + STAGING + SQUEUES);
  const live = bindings([{ type: 'queue', name: 'BQ_DLQ', queue_name: 'rows-dlq' }]);
  let r = await run('live', { bindings: { 'jbx-x': live }, queues: [Q('q1', 'rows'), Q('q2', 'rows-dlq')] });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes('queue consumer for rows on live not set yet: the deploy sets it'));
  r = await run('live', { bindings: { 'jbx-x': live }, queues: [Q('q1', 'rows', [C('jbx-other')]), Q('q2', 'rows-dlq')] });
  assert.equal(r.code, 1); assert.match(r.j.problems.join(), /consumed by jbx-other, not jbx-x: refused/);
});
test('consumer settings differ: refused on live, noted on staging, noted when release_managed.queues names it', async () => {
  writeToml(BASE + QUEUES + STAGING + SQUEUES);
  const live = bindings([{ type: 'queue', name: 'BQ_DLQ', queue_name: 'rows-dlq' }]);
  const qs = [Q('q1', 'rows', [C('jbx-x', { batch_size: 10, max_retries: 8, max_wait_time_ms: 5000 })]), Q('q2', 'rows-dlq'),
    Q('q3', 'rows-staging', [C('jbx-x-staging', { batch_size: 10, max_retries: 8, max_wait_time_ms: 5000 }, null)])];
  pipeline();
  let r = await run('live', { bindings: { 'jbx-x': live }, queues: qs });
  assert.equal(r.code, 1); assert.deepEqual(r.j.problems, ['queue consumer rows on live: batch_size 10, toml 100']);
  r = await run('staging', { queues: qs });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes('queue consumer rows-staging on staging: batch_size 10, toml 100'));
  pipeline({ release_managed: { queues: ['rows'] } });
  r = await run('live', { bindings: { 'jbx-x': live }, queues: qs });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes('release sets queue consumer rows: batch_size 10, toml 100'));
});
// release_managed.crons (v1.0.8): live differing from the toml only in those crons is noted, not refused.
const CRONS = '[triggers]\ncrons = ["* * * * *", "*/10 * * * *", "16,45 11 * * *"]\n\n';
const SCRONS = '[env.staging.triggers]\ncrons = ["* * * * *", "*/10 * * * *"]\n\n';
const NOTE = (env, have, adds, drops) => `crons on ${env}: ${JSON.stringify(have)}; the release` + (adds ? ` adds ${JSON.stringify(adds)}` : '')
  + (adds && drops ? ' and' : '') + (drops ? ` removes ${JSON.stringify(drops)}` : '') + ' (release_managed.crons; the deploy sets them)';
test('release_managed.crons: live with exactly the others is noted (live and staging); without the key, refused', async () => {
  writeToml(BASE + CRONS + STAGING + SCRONS);
  pipeline();
  let r = await run('live', { crons: ['* * * * *'] });
  assert.equal(r.code, 1); assert.deepEqual(r.j.problems, ['crons on live: ["* * * * *"], toml ["* * * * *","*/10 * * * *","16,45 11 * * *"]']);
  pipeline({ release_managed: { crons: ['*/10 * * * *', '16,45 11 * * *'] } });
  r = await run('live', { crons: ['* * * * *'] });
  assert.equal(r.code, 0, r.out); assert.deepEqual(r.j.problems, []);
  assert.ok(r.j.notes.includes(NOTE('live', ['* * * * *'], ['*/10 * * * *', '16,45 11 * * *'])), r.out);
  r = await run('staging', { crons: ['* * * * *'] });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes(NOTE('staging', ['* * * * *'], ['*/10 * * * *'])), r.out);
  // Some of them already set (a deploy that set them, then a rollback of the script): still only managed ones differ.
  r = await run('live', { crons: ['* * * * *', '*/10 * * * *'] });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes(NOTE('live', ['* * * * *', '*/10 * * * *'], ['16,45 11 * * *'])), r.out);
  // Live equal to the toml: nothing to note. None set yet: noted as before.
  r = await run('live', { crons: ['16,45 11 * * *', '*/10 * * * *', '* * * * *'] });
  assert.equal(r.code, 0, r.out); assert.ok(!r.j.notes.some(n => /^crons/.test(n)), r.out);
  r = await run('live', {});
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes('crons on live not set yet: the deploy sets ["* * * * *","*/10 * * * *","16,45 11 * * *"]'), r.out);
});
test('release_managed.crons: a managed cron the toml drops is noted; any unmanaged difference is still refused', async () => {
  writeToml(BASE + '[triggers]\ncrons = ["* * * * *"]\n\n' + STAGING);
  pipeline({ release_managed: { crons: ['*/10 * * * *'] } });
  let r = await run('live', { crons: ['* * * * *', '*/10 * * * *'] });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes(NOTE('live', ['* * * * *', '*/10 * * * *'], null, ['*/10 * * * *'])), r.out);
  writeToml(BASE + CRONS + STAGING + SCRONS);
  pipeline({ release_managed: { crons: ['*/10 * * * *', '16,45 11 * * *'] } });
  // An extra cron on live nobody named, the unmanaged cron missing, or changed: refused on live, noted on staging.
  for (const crons of [['* * * * *', '0 3 * * *'], ['*/10 * * * *'], ['*/2 * * * *']]) {
    r = await run('live', { crons });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.j.problems, [`crons on live: ${JSON.stringify(crons)}, toml ["* * * * *","*/10 * * * *","16,45 11 * * *"]`]);
  }
  r = await run('staging', { crons: ['*/2 * * * *'] });
  assert.equal(r.code, 0, r.out); assert.ok(r.j.notes.includes('crons on staging: ["*/2 * * * *"], toml ["* * * * *","*/10 * * * *"]'), r.out);
  // An empty list is the same as no key.
  pipeline({ release_managed: { crons: [] } });
  r = await run('live', { crons: ['* * * * *'] });
  assert.equal(r.code, 1); assert.match(r.j.problems.join(), /^crons on live: \["\* \* \* \* \*"\], toml/);
});
test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
