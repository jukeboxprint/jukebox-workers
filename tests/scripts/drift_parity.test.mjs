// v1.0.8 parity: scripts/door/drift.mjs gained pipeline.json release_managed.crons. A Worker whose pipeline.json has no
// release_managed.crons must get byte-identical drift output (stdout, stderr, exit code) to v1.0.7. The "before" is
// fixtures/drift.v1.0.7.mjs: drift.mjs at the v1.0.7 commit (4a8beef), pinned by sha256 below. Both run against the same
// fake Cloudflare API (as drift.test.mjs fakes it), for four fake Workers, live and staging, across the scenarios below.
// The fixture's imports are pointed at this repo (worker.mjs as it is now, smol-toml from node_modules), so only
// drift.mjs differs between the two runs. A later, intended change to this output: re-pin the fixture in that PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NEW = path.resolve(HERE, '../../scripts/door/drift.mjs');
const FIXTURE = path.join(HERE, 'fixtures/drift.v1.0.7.mjs');
const FIXTURE_SHA = '9913cb4297c9861281363857b744d660795c457f7d9c0c90f4bf753cedb2379c';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-parity-'));
const root = path.join(dir, 'repo');
const OLD = path.join(dir, 'drift.v1.0.7.mjs');
const fixture = fs.readFileSync(FIXTURE);
fs.writeFileSync(OLD, fixture.toString()
  .replace(`from 'smol-toml'`, `from '${import.meta.resolve('smol-toml')}'`)
  .replace(`from './worker.mjs'`, `from '${new URL('../../scripts/door/worker.mjs', import.meta.url).href}'`));

const BODY = 'export default { async fetch() { return new Response("x"); }, async scheduled() {} }';
const SHA = sha(BODY);
// Four Workers, none with release_managed.crons: the front door kind (crons not read), a passthrough with crons (an env
// with its own), a passthrough with no [triggers], and one with other release_managed keys.
const head = (n, extra = '') => `name = "jbx-${n}"\naccount_id = "acct"\ncompatibility_date = "2026-10-01"\nworkers_dev = true\npreview_urls = false\n${extra}\n[vars]\nA = "1"\nB = "2"\n\n`;
const stag = (n, extra = '') => `[env.staging]\nname = "jbx-${n}-staging"\nworkers_dev = true\npreview_urls = false\n${extra}\n[env.staging.vars]\nA = "1"\nB = "2"\n\n`;
const WORKERS = {
  door: { pipe: {}, toml: head('door') + stag('door') },
  jobs: { pipe: { kind: 'passthrough' }, toml: head('jobs', '\n[triggers]\ncrons = ["* * * * *", "0 3 * * *"]\n') + stag('jobs', '\n[env.staging.triggers]\ncrons = ["*/5 * * * *"]\n') },
  plain: { pipe: { kind: 'passthrough' }, toml: head('plain') + stag('plain') },
  mgd: { pipe: { kind: 'passthrough', release_managed: { vars: ['B'] } }, toml: head('mgd', '\n[triggers]\ncrons = ["0 3 * * *"]\n') + stag('mgd') },
};
const CRONS = { jobs: { live: ['* * * * *', '0 3 * * *'], staging: ['*/5 * * * *'] }, mgd: { live: ['0 3 * * *'], staging: ['0 3 * * *'] } };
for (const [w, c] of Object.entries(WORKERS)) {
  const WD = path.join(root, 'workers', w);
  fs.mkdirSync(WD, { recursive: true });
  fs.writeFileSync(path.join(WD, 'pipeline.json'), JSON.stringify(c.pipe));
  fs.writeFileSync(path.join(WD, 'wrangler.toml'), c.toml);
  fs.writeFileSync(path.join(WD, 'release.json'), JSON.stringify({ version: 'v2', sha256: SHA }));
  fs.writeFileSync(path.join(WD, 'secrets.json'), JSON.stringify({ live: ['PUSH_SECRET'], staging: { PUSH_SECRET: 'own' } }));
}

const binds = () => [{ type: 'plain_text', name: 'A', text: '1' }, { type: 'plain_text', name: 'B', text: '2' }, { type: 'secret_text', name: 'PUSH_SECRET' }];
let S = {};
const api = http.createServer((req, res) => {
  const ok = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, errors: [], result })); };
  const m = new URL(req.url, 'http://x').pathname.match(/^\/accounts\/acct\/workers\/scripts\/([^/]+)\/(.+)$/);
  if (m && m[2] === 'settings') return ok({ compatibility_date: S.cd || '2026-10-01', compatibility_flags: [], usage_model: 'standard', placement: S.placement || {}, limits: S.limits, bindings: S.bindings || binds() });
  if (m && m[2] === 'script-settings') return ok({ logpush: false, tail_consumers: [], observability: null });
  if (m && m[2] === 'schedules') return ok({ schedules: (S.crons || []).map(cron => ({ cron, created_on: '2026-11-01', modified_on: '2026-11-01' })) });
  if (m && m[2] === 'subdomain') return ok({ enabled: true, previews_enabled: false });
  if (m && m[2] === 'content/v2') { res.setHeader('content-type', 'application/javascript'); return res.end(S.script || BODY); }
  res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ message: 'no route ' + req.url }] }));
}).listen(0);
const run = (script, args) => new Promise(resolve => {
  const p = spawn(process.execPath, [script, ...args], { env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: root, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: `http://127.0.0.1:${api.address().port}` }) });
  let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('close', code => resolve({ code, out, err }));
});

// Live's schedules as the toml has them (live = clean), then one difference each.
const want = (w, env) => (CRONS[w] || {})[env] || [];
const SCENARIOS = {
  'equal': (w, env) => ({ crons: want(w, env) }),
  'new cron in the toml': (w, env) => ({ crons: want(w, env).slice(1) }),
  'cron removed from the toml': (w, env) => ({ crons: want(w, env).concat('30 4 * * *') }),
  'cron changed': (w, env) => ({ crons: want(w, env).length ? ['15 2 * * *'].concat(want(w, env).slice(1)) : ['15 2 * * *'] }),
  'no triggers on live': () => ({ crons: [] }),
  'cron and a var differ': (w, env) => ({ crons: want(w, env).concat('30 4 * * *'), bindings: binds().map(b => b.name === 'A' ? Object.assign({}, b, { text: 'shadow' }) : b) }),
  'managed var differs': (w, env) => ({ crons: want(w, env), bindings: binds().map(b => b.name === 'B' ? Object.assign({}, b, { text: 'x' }) : b) }),
  'secret missing': (w, env) => ({ crons: want(w, env), bindings: binds().filter(b => b.type !== 'secret_text') }),
  'compatibility date': (w, env) => ({ crons: want(w, env), cd: '2026-09-01' }),
  'placement and limits': (w, env) => ({ crons: want(w, env), placement: { mode: 'smart' }, limits: { cpu_ms: 100 } }),
  'script not a release': (w, env) => ({ crons: want(w, env), script: 'other' }),
};

test('the v1.0.7 fixture is the pinned copy and predates release_managed.crons', () => {
  assert.equal(sha(fixture), FIXTURE_SHA);
  assert.doesNotMatch(fixture.toString(), /crons: \[\]/);
  assert.match(fs.readFileSync(NEW, 'utf8'), /crons: \[\]/);
});

test('no release_managed.crons: byte-identical drift output to v1.0.7, every Worker, live and staging', async () => {
  let n = 0;
  const seen = new Set();
  for (const w of Object.keys(WORKERS)) for (const env of ['live', 'staging']) for (const [name, make] of Object.entries(SCENARIOS)) {
    S = make(w, env);
    const args = ['--worker', w, '--env', env];
    const a = await run(OLD, args), b = await run(NEW, args);
    assert.ok(a.out.length > 0, `${w} ${env} ${name}: v1.0.7 printed nothing`);
    assert.deepEqual([b.code, b.out, b.err], [a.code, a.out, a.err], `${w} ${env} ${name}`);
    seen.add(a.code);
    if (name === 'equal') assert.equal(b.code, 0, `${w} ${env} equal: ${b.out}`);
    if (w === 'jobs' && env === 'live' && /cron/.test(name) && name !== 'no triggers on live') assert.equal(b.code, 1, `${w} live ${name} refused: ${b.out}`);
    n++;
  }
  assert.equal(n, 4 * 2 * Object.keys(SCENARIOS).length);
  assert.deepEqual([...seen].sort(), [0, 1]);
});

test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
