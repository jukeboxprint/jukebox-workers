// scripts/door/rollout.mjs against a fake Cloudflare API (deployments + Workers analytics GraphQL) and a fake wrangler:
// the watch compares refusals (HTTP 302/403) between the new and old versions and rolls back on a jump (v1.0.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.resolve(HERE, '../../scripts/door/rollout.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
const STATE = path.join(dir, 'state.json');   // { dep: [{version_id, percentage}], traffic: { [version]: { requests, ref: {status: n} } }, refQueries }
const FW = path.join(dir, 'fake-wrangler.mjs');
const root = path.join(dir, 'repo');
const OLD = 'old-version', NEW = 'new-version';
fs.mkdirSync(path.join(root, 'workers/x'), { recursive: true });
fs.writeFileSync(path.join(root, 'workers/x/wrangler.toml'), 'name = "jbx-x"\naccount_id = "acct"\n\n[env.staging]\nname = "jbx-x-staging"\n');
fs.writeFileSync(path.join(root, 'workers/x/release.json'), JSON.stringify({ version: 'v2', sha256: 'test' }));
const ROLLOUT = {
  steps_pct: [10, 100], http_timeout_s: 5, poll_seconds: 60, watch_minutes: 2, max_watch_minutes: 4, job_margin_minutes: 1,
  min_requests: 50, ignore_statuses: ['success', 'clientDisconnected'], max_error_rate: 0.01, max_error_rate_vs_old: 2,
  max_p50_ms_vs_old: 3, max_p99_ms_vs_old: 3, p99_min_requests: 1000, rollback_retries: 2, rollback_retry_s: 1,
  health_paths: ['/health'], health_delay_s: 0, health_wait_s: 0, health_poll_s: 1, analytics_tries: 1, smoke_after_100: false,
};
const pipeline = extra => fs.writeFileSync(path.join(root, 'workers/x/pipeline.json'),
  JSON.stringify({ kind: 'passthrough', hosts: { live: 'http://unused.invalid' }, rollout: Object.assign({}, ROLLOUT, extra) }));
// The fake wrangler: `versions upload` reports NEW; `versions deploy a@p% b@q%` becomes the deployment.
fs.writeFileSync(FW, `import fs from 'node:fs';
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
if (a[0] === 'versions' && a[1] === 'upload') fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: 'version-upload', version_id: ${JSON.stringify(NEW)} }) + '\\n');
if (a[0] === 'versions' && a[1] === 'deploy') st.dep = a.filter(x => /@\\d+%$/.test(x)).map(x => { const [v, p] = x.split('@'); return { version_id: v, percentage: Number(p.slice(0, -1)) }; });
fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(st));
`);
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end('{}');
    if (req.url === '/accounts/acct/workers/scripts/jbx-x/deployments') return res.end(JSON.stringify({ success: true, result: { deployments: [{ versions: st.dep }] } }));
    if (req.url === '/graphql') {
      const { query, variables } = JSON.parse(body);
      const t = st.traffic[variables.v] || { requests: 0, ref: {} };
      let rows;
      if (query.includes('httpResponseStatus')) {
        st.refQueries = (st.refQueries || 0) + 1; fs.writeFileSync(STATE, JSON.stringify(st));
        const refused = Object.values(t.ref).reduce((a, b) => a + b, 0);
        rows = [{ dimensions: { httpResponseStatus: 200 }, sum: { requests: t.requests - refused } },
          ...Object.entries(t.ref).map(([s, n]) => ({ dimensions: { httpResponseStatus: Number(s) }, sum: { requests: n } }))];
      } else {
        rows = [{ dimensions: { status: 'success' }, sum: { requests: t.requests, errors: 0 }, quantiles: { wallTimeP50: 10000, wallTimeP99: 50000 } }];
      }
      return res.end(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }));
  });
}).listen(0);
const run = (traffic, extra) => new Promise(resolve => {
  pipeline(extra);
  fs.writeFileSync(STATE, JSON.stringify({ dep: [{ version_id: OLD, percentage: 100 }], traffic }));
  const base = `http://127.0.0.1:${api.address().port}`;
  const p = spawn(process.execPath, [SCRIPT, '--worker', 'x', '--env', 'live'], { env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: root, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: base, DOOR_HOST: base, DOOR_WRANGLER: FW, DOOR_TIME_SCALE: '0.001' }) });
  let out = ''; p.stdout.on('data', d => out += d);
  p.on('close', code => {
    const lines = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    resolve({ code, lines, last: lines[lines.length - 1] || {}, watches: lines.filter(l => l.step === 'watch'), state: JSON.parse(fs.readFileSync(STATE, 'utf8')) });
  });
});

test('refusals: same share on both versions passes, and each watch logs them', async () => {
  const r = await run({ [OLD]: { requests: 9000, ref: { 302: 270, 403: 90 } }, [NEW]: { requests: 1000, ref: { 302: 30, 403: 10 } } });
  assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
  assert.ok(r.watches.length > 0);
  assert.deepEqual(r.watches[0].new.refusals, { requests: 1000, refused: 40, share: 0.04 });
  assert.deepEqual(r.watches[0].old.refusals, { requests: 9000, refused: 360, share: 0.04 });
  assert.deepEqual(r.state.dep, [{ version_id: NEW, percentage: 100 }]);
});
test('refusals: a jump on the new version rolls back to the old one', async () => {
  const r = await run({ [OLD]: { requests: 9000, ref: { 302: 90 } }, [NEW]: { requests: 1000, ref: { 302: 150, 403: 100 } } });
  assert.equal(r.code, 1); assert.equal(r.last.step, 'rolled_back');
  assert.match(r.last.why, /^refusals \(302\/403\) 0\.2500 \(250\/1000; old 0\.0100, 90\/9000\)/);
  assert.deepEqual(r.state.dep, [{ version_id: OLD, percentage: 100 }]);
});
test('refusals: a small sample does not trip (2 of 100 vs none: below min_refusal_excess)', async () => {
  const r = await run({ [OLD]: { requests: 900, ref: {} }, [NEW]: { requests: 100, ref: { 403: 2 } } });
  assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
});
test('refusals: false turns the check off (no refusal query)', async () => {
  const r = await run({ [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 1000, ref: { 403: 500 } } }, { refusals: false });
  assert.equal(r.code, 0, JSON.stringify(r.last)); assert.ok(!r.state.refQueries);
  assert.equal(r.watches[0].new.refusals, undefined);
});
test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
