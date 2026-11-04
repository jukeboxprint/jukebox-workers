// scripts/door/queues.mjs against a fake Cloudflare Queues API: sets the toml's consumers after a deploy only when they
// differ, reads them back, never creates a queue, never takes a queue from another Worker, and fails on an answer in an
// unexpected shape before changing anything (v1.0.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.resolve(HERE, '../../scripts/door/queues.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queues-'));
const STATE = path.join(dir, 'state.json');   // { queues: [{ queue_id, queue_name, consumers }], writes: [], noop, reqs: [] }
const root = path.join(dir, 'repo');
fs.mkdirSync(path.join(root, 'workers/x'), { recursive: true });
fs.writeFileSync(path.join(root, 'workers/x/pipeline.json'), JSON.stringify({ kind: 'passthrough' }));
const CONSUMER = (q, dlq) => `queue = "${q}"\nmax_batch_size = 100\nmax_batch_timeout = 5\nmax_retries = 8\n${dlq ? `dead_letter_queue = "${dlq}"\n` : ''}`;
const TOML = `name = "jbx-x"\naccount_id = "acct"\n\n[[queues.consumers]]\n${CONSUMER('rows', 'rows-dlq')}\n[[queues.producers]]\nbinding = "BQ_DLQ"\nqueue = "rows-dlq"\n\n`
  + `[env.staging]\nname = "jbx-x-staging"\n\n[[env.staging.queues.consumers]]\n${CONSUMER('rows-staging', 'rows-dlq-staging')}`;
const writeToml = t => fs.writeFileSync(path.join(root, 'workers/x/wrangler.toml'), t);
const Q = (id, name, consumers = []) => ({ queue_id: id, queue_name: name, created_on: 'x', consumers });
const C = (script, settings, dlq, id = 'c-' + script) => ({ consumer_id: id, type: 'worker', script, dead_letter_queue: dlq, settings });
const GOOD = { batch_size: 100, max_retries: 8, max_wait_time_ms: 5000 };
const ALL = (rows = [], staging = []) => [Q('q-rows', 'rows', rows), Q('q-dlq', 'rows-dlq'), Q('q-rows-s', 'rows-staging', staging), Q('q-dlq-s', 'rows-dlq-staging')];

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    st.reqs.push(`${req.method} ${req.url}`);
    const u = new URL(req.url, 'http://x');
    const ok = result => { fs.writeFileSync(STATE, JSON.stringify(st)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, errors: [], result })); };
    if (st.apiDown) { fs.writeFileSync(STATE, JSON.stringify(st)); res.statusCode = 500; return res.end(JSON.stringify({ success: false, errors: [{ message: 'down' }] })); }
    if (req.method === 'GET' && u.pathname === '/accounts/acct/queues') {
      if (st.shape === 'notList') return ok({ queues: st.queues });
      return ok(st.queues.filter(q => u.searchParams.getAll('name').includes(q.queue_name)));
    }
    const m = u.pathname.match(/^\/accounts\/acct\/queues\/([^/]+)\/consumers(?:\/([^/]+))?$/);
    const q = m && st.queues.find(x => x.queue_id === m[1]);
    if (q && (req.method === 'POST' || req.method === 'PUT')) {
      const b = JSON.parse(body);
      st.writes.push({ method: req.method, queue: q.queue_name, consumer: m[2] || null, body: b });
      if (!st.noop) {
        const c = C(b.script_name, b.settings, b.dead_letter_queue, m[2] || 'c-new');
        q.consumers = req.method === 'POST' ? [...q.consumers, c] : q.consumers.map(x => x.consumer_id === m[2] ? c : x);
      }
      return ok({});
    }
    fs.writeFileSync(STATE, JSON.stringify(st)); res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ message: 'no route' }] }));
  });
}).listen(0);
const run = (env, state, extra = []) => new Promise(resolve => {
  fs.writeFileSync(STATE, JSON.stringify(Object.assign({ writes: [], reqs: [] }, state)));
  const p = spawn(process.execPath, [SCRIPT, '--worker', 'x', '--env', env, ...extra], { env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: root, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: `http://127.0.0.1:${api.address().port}` }) });
  let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('close', code => { const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    let j = {}; try { j = JSON.parse(out.trim().split('\n').pop() || '{}'); } catch (e) { j = { raw: out }; }
    resolve({ code, out, err, j, st }); });
});

test('no consumers in the toml: count 0, and a run reads nothing', async () => {
  writeToml('name = "jbx-x"\naccount_id = "acct"\n\n[env.staging]\nname = "jbx-x-staging"\n');
  const c = await run('live', { queues: [] }, ['--count']);
  assert.equal(c.code, 0); assert.equal(c.out.trim(), '0');
  const r = await run('live', { queues: [] });
  assert.equal(r.code, 0); assert.deepEqual(r.j, { env: 'live', worker: 'jbx-x', step: 'consumers', ok: true, changed: false, consumers: [] });
  assert.deepEqual(r.st.reqs, []);
});
test('--count and --dry need no API', async () => {
  writeToml(TOML);
  assert.equal((await run('staging', { queues: [] }, ['--count'])).out.trim(), '1');
  const d = await run('live', { queues: [] }, ['--dry']);
  assert.equal(d.code, 0); assert.deepEqual(d.j.want, [{ queue: 'rows', dead_letter_queue: 'rows-dlq', batch_size: 100, max_retries: 8, max_wait_time_ms: 5000 }]);
  assert.deepEqual(d.st.reqs, []);
});
test('already the same: nothing written', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: ALL([C('jbx-x', GOOD, 'rows-dlq')]) });
  assert.equal(r.code, 0, JSON.stringify(r.j)); assert.equal(r.j.changed, false); assert.deepEqual(r.st.writes, []);
  assert.ok(r.st.reqs.every(x => x.startsWith('GET ')));
});
test('no consumer yet: POST with wrangler\'s body, read back', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: ALL() });
  assert.equal(r.code, 0, JSON.stringify(r.j)); assert.equal(r.j.changed, true);
  assert.deepEqual(r.st.writes, [{ method: 'POST', queue: 'rows', consumer: null,
    body: { type: 'worker', dead_letter_queue: 'rows-dlq', script_name: 'jbx-x', settings: GOOD } }]);
});
test('different settings: PUT on this Worker\'s consumer, read back', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: ALL([C('jbx-x', { batch_size: 10, max_retries: 3, max_wait_time_ms: 5000 }, 'rows-dlq')]) });
  assert.equal(r.code, 0, JSON.stringify(r.j));
  assert.deepEqual(r.st.writes.map(w => [w.method, w.consumer]), [['PUT', 'c-jbx-x']]);
  assert.deepEqual(r.j.set[0].was, ['batch_size 10, toml 100', 'max_retries 3, toml 8']);
});
test('staging: only the staging queue and Worker', async () => {
  writeToml(TOML);
  const r = await run('staging', { queues: ALL([C('jbx-x', GOOD, 'rows-dlq')]) });
  assert.equal(r.code, 0, JSON.stringify(r.j));
  assert.deepEqual(r.st.writes, [{ method: 'POST', queue: 'rows-staging', consumer: null,
    body: { type: 'worker', dead_letter_queue: 'rows-dlq-staging', script_name: 'jbx-x-staging', settings: GOOD } }]);
});
test('a queue that does not exist: fails, named, nothing written (the pipeline never creates queues)', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: [Q('q-rows', 'rows')] });
  assert.equal(r.code, 1); assert.deepEqual(r.st.writes, []);
  assert.match(r.j.why, /queue rows-dlq does not exist: create it in the dashboard or with `wrangler queues create rows-dlq`, on Tyler's word/);
});
test('a queue held by another Worker: refused, nothing written', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: ALL([C('jbx-x-staging', GOOD, 'rows-dlq')]) });
  assert.equal(r.code, 1); assert.deepEqual(r.st.writes, []); assert.match(r.j.why, /consumed by jbx-x-staging, not jbx-x: refused/);
});
test('unexpected shapes fail before anything is written', async () => {
  writeToml(TOML);
  for (const [why, state, re] of [
    ['list is not an array', { queues: ALL(), shape: 'notList' }, /not a list/],
    ['no consumers list', { queues: [{ queue_id: 'q-rows', queue_name: 'rows' }, Q('q-dlq', 'rows-dlq')] }, /no queue_id or consumers list/],
    ['consumer without settings', { queues: ALL([{ consumer_id: 'c1', type: 'worker', script: 'jbx-x' }]) }, /unexpected shape/],
    ['settings as strings', { queues: ALL([C('jbx-x', { batch_size: '100', max_retries: 8, max_wait_time_ms: 5000 }, 'rows-dlq')]) }, /unexpected shape/],
    ['dead_letter_queue as an id', { queues: ALL([C('jbx-x', GOOD, 'q-dlq')]) }, /reads as an id/],
    ['API down', { queues: ALL(), apiDown: true }, /HTTP 500/],
  ]) {
    const r = await run('live', state);
    assert.equal(r.code, 1, why); assert.deepEqual(r.st.writes, [], why); assert.match(r.j.why, re, why);
  }
});
test('the API took the write but nothing changed: fails on the read back', async () => {
  writeToml(TOML);
  const r = await run('live', { queues: ALL(), noop: true });
  assert.equal(r.code, 1); assert.equal(r.j.ok, false); assert.equal(r.st.writes.length, 1); assert.match(r.j.why, /rows: not set/);
});
test('a toml key the pipeline does not handle, or staging naming live\'s queue: refused (exit 2), nothing read', async () => {
  writeToml(TOML.replace('max_retries = 8\n', 'max_retries = 8\nmax_concurrency = 2\n'));
  let r = await run('live', { queues: ALL() });
  assert.equal(r.code, 2); assert.match(r.err, /max_concurrency is not handled/); assert.deepEqual(r.st.reqs, []);
  writeToml(TOML.replace('queue = "rows-staging"', 'queue = "rows"'));
  r = await run('staging', { queues: ALL() });
  assert.equal(r.code, 2); assert.match(r.err, /names live's queue rows/);
});
test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
