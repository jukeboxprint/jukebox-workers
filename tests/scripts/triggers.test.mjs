// scripts/door/triggers.mjs against a fake Cloudflare API and a fake wrangler: sets the toml's crons after a deploy only
// when they differ from the Worker's, checks them back, and never touches a live Worker for a staging run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.resolve(HERE, '../../scripts/door/triggers.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-'));
const STATE = path.join(dir, 'state.json');          // { [worker name]: [crons] }, the fake account
const CALLS = path.join(dir, 'calls.ndjson');
const FW = path.join(dir, 'fake-wrangler.mjs');
const root = path.join(dir, 'repo');
fs.mkdirSync(path.join(root, 'workers/x'), { recursive: true });
const writeToml = (live, staging) => fs.writeFileSync(path.join(root, 'workers/x/wrangler.toml'),
  `name = "jbx-x"\naccount_id = "acct"\n${live ? `[triggers]\ncrons = ${JSON.stringify(live)}\n` : ''}\n[env.staging]\nname = "jbx-x-staging"\n${staging ? `[env.staging.triggers]\ncrons = ${JSON.stringify(staging)}\n` : ''}`);
fs.writeFileSync(path.join(root, 'workers/x/pipeline.json'), JSON.stringify({ kind: 'passthrough' }));
// The fake wrangler: `triggers deploy [--env staging]` sets that Worker's schedules to the toml's (S.wranglerSets, or the
// toml's when unset), as the real one does; S.wranglerNoop leaves them unchanged.
fs.writeFileSync(FW, `import fs from 'node:fs';
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(a) + '\\n');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
const env = a.includes('--env') ? a[a.indexOf('--env') + 1] : 'live';
if (!st.noop) st[env === 'live' ? 'jbx-x' : 'jbx-x-' + env] = st.next[env] || [];
fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(st));
`);
const api = http.createServer((req, res) => {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const m = req.url.match(/\/accounts\/acct\/workers\/scripts\/([^/]+)\/schedules$/);
  res.setHeader('content-type', 'application/json');
  if (!m || st.apiDown) { res.statusCode = 500; return res.end(JSON.stringify({ success: false, errors: [{ message: 'down' }] })); }
  res.end(JSON.stringify({ success: true, result: { schedules: (st[m[1]] || []).map(cron => ({ cron })) } }));
}).listen(0);
const run = (env, state) => new Promise(resolve => {
  fs.writeFileSync(STATE, JSON.stringify(state)); fs.writeFileSync(CALLS, '');
  const p = spawn(process.execPath, [SCRIPT, '--worker', 'x', '--env', env], { env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: root, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: `http://127.0.0.1:${api.address().port}`, DOOR_WRANGLER: FW }) });
  let out = ''; p.stdout.on('data', d => out += d);
  p.on('close', code => resolve({ code, j: JSON.parse(out.trim().split('\n').pop() || '{}'), calls: fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    state: JSON.parse(fs.readFileSync(STATE, 'utf8')) }));
});
const N = '*/15 10-13 * * *';

test('already the same: nothing run', async () => {
  writeToml([N]);
  const r = await run('live', { 'jbx-x': [N], next: {} });
  assert.equal(r.code, 0); assert.equal(r.j.changed, false); assert.deepEqual(r.calls, []);
});
test('live has none, the toml has one: wrangler triggers deploy, checked back', async () => {
  writeToml([N]);
  const r = await run('live', { 'jbx-x': [], next: { live: [N] } });
  assert.equal(r.code, 0, JSON.stringify(r.j)); assert.equal(r.j.changed, true); assert.deepEqual(r.j.crons, [N]);
  assert.deepEqual(r.calls, [['triggers', 'deploy']]);
});
test('staging: --env staging, and only the staging Worker changes', async () => {
  writeToml([N]);
  const r = await run('staging', { 'jbx-x': ['0 1 * * *'], 'jbx-x-staging': [], next: { staging: [N] } });
  assert.equal(r.code, 0, JSON.stringify(r.j)); assert.deepEqual(r.calls, [['triggers', 'deploy', '--env', 'staging']]);
  assert.deepEqual(r.state['jbx-x'], ['0 1 * * *']); assert.deepEqual(r.state['jbx-x-staging'], [N]);
});
test('the toml dropped its crons: deployed to none', async () => {
  writeToml(null);
  const r = await run('live', { 'jbx-x': [N], next: { live: [] } });
  assert.equal(r.code, 0, JSON.stringify(r.j)); assert.deepEqual(r.state['jbx-x'], []);
});
test('wrangler ran but the schedules did not change: fails', async () => {
  writeToml([N]);
  const r = await run('live', { 'jbx-x': [], noop: true, next: {} });
  assert.equal(r.code, 1); assert.equal(r.j.ok, false);
});
test('schedules unreadable: fails, wrangler not run', async () => {
  writeToml([N]);
  const r = await run('live', { 'jbx-x': [], apiDown: true, next: {} });
  assert.equal(r.code, 1); assert.deepEqual(r.calls, []);
});
test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
