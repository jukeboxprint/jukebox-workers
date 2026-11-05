// scripts/door/rollout.mjs against a fake Cloudflare API (deployments, Workers analytics GraphQL, D1 query, KV values) and
// a fake wrangler: refusals (v1.0.6); the low-traffic hold and dark releases (v1.0.9).
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
fs.writeFileSync(path.join(root, 'workers/x/wrangler.toml'), 'name = "jbx-x"\naccount_id = "acct"\n\n[[d1_databases]]\nbinding = "DB"\n'
  + 'database_name = "jbx-x"\ndatabase_id = "db1"\n\n[[kv_namespaces]]\nbinding = "SNAP"\nid = "kv1"\n\n[env.staging]\nname = "jbx-x-staging"\n');
fs.writeFileSync(path.join(root, 'workers/x/release.json'), JSON.stringify({ version: 'v2', sha256: 'test' }));
const ROLLOUT = {
  steps_pct: [10, 100], http_timeout_s: 5, poll_seconds: 60, watch_minutes: 2, max_watch_minutes: 4, job_margin_minutes: 1,
  min_requests: 50, ignore_statuses: ['success', 'clientDisconnected'], max_error_rate: 0.01, max_error_rate_vs_old: 2,
  max_p50_ms_vs_old: 3, max_p99_ms_vs_old: 3, p99_min_requests: 1000, rollback_retries: 2, rollback_retry_s: 1,
  health_paths: ['/health'], health_delay_s: 0, health_wait_s: 0, health_poll_s: 1, analytics_tries: 1, smoke_after_100: false,
};
const pipeline = extra => fs.writeFileSync(path.join(root, 'workers/x/pipeline.json'),
  JSON.stringify({ kind: 'passthrough', hosts: { live: 'http://unused.invalid' }, smoke: [{ name: 'smoke', path: '/smoke', expect_status: 200 }],
    rollout: Object.assign({}, ROLLOUT, extra) }));
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
    if (req.url === '/smoke') { st.smokes = (st.smokes || 0) + 1; fs.writeFileSync(STATE, JSON.stringify(st)); return res.end('{}'); }
    // Dark switches: st.d1 { key: value } (D1 config rows), st.kv { key: value }; st.switchMode 'http500' or 'shape'.
    if (req.url === '/accounts/acct/d1/database/db1/query') {
      const { sql, params } = JSON.parse(body);
      if (st.switchMode === 'http500') { res.statusCode = 500; return res.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'down' }] })); }
      if (st.switchMode === 'shape') return res.end(JSON.stringify({ success: true, result: { rows: [] } }));
      const m = /^SELECT value FROM (\w+) WHERE key = \?$/.exec(sql);
      const rows = m && m[1] === 'config' && (st.d1 || {})[params[0]] !== undefined ? [{ value: st.d1[params[0]] }] : [];
      return res.end(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: rows, meta: {} }] }));
    }
    const kv = /^\/accounts\/acct\/storage\/kv\/namespaces\/kv1\/values\/(.+)$/.exec(req.url);
    if (kv) {
      const v = (st.kv || {})[decodeURIComponent(kv[1])];
      if (v === undefined) { res.statusCode = 404; return res.end(JSON.stringify({ success: false, errors: [{ code: 10009, message: 'get: key not found' }] })); }
      res.setHeader('content-type', 'application/octet-stream'); return res.end(v);
    }
    if (req.url === '/accounts/acct/workers/scripts/jbx-x/deployments') return res.end(JSON.stringify({ success: true, result: { deployments: [{ versions: st.dep }] } }));
    if (req.url === '/graphql') {
      const { query, variables } = JSON.parse(body);
      // st.after { polls, traffic }: after that many stats reads of the new version, its traffic becomes after.traffic.
      if (!query.includes('httpResponseStatus') && variables.v === NEW) { st.newReads = (st.newReads || 0) + 1; fs.writeFileSync(STATE, JSON.stringify(st)); }
      const tr = st.after && st.newReads > st.after.polls ? st.after.traffic : st.traffic;
      const t = Object.assign({ requests: 0, errors: 0, ref: {} }, tr[variables.v]);
      let rows;
      if (query.includes('httpResponseStatus')) {
        st.refQueries = (st.refQueries || 0) + 1; fs.writeFileSync(STATE, JSON.stringify(st));
        // refMode: how a wrong field (or a bad day) answers: a GraphQL error with no data, data null, HTTP 500, or rows
        // without the status field.
        if (st.refMode === 'gqlError') return res.end(JSON.stringify({ data: null, errors: [{ message: 'unknown field "httpResponseStatus"' }] }));
        if (st.refMode === 'null') return res.end(JSON.stringify({ data: null }));
        if (st.refMode === 'http500') { res.statusCode = 500; return res.end(JSON.stringify({ errors: [{ message: 'down' }] })); }
        if (st.refMode === 'shape') return res.end(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: {}, sum: { requests: t.requests } }] }] } } }));
        const refused = Object.values(t.ref).reduce((a, b) => a + b, 0);
        rows = [{ dimensions: { httpResponseStatus: 200 }, sum: { requests: t.requests - refused } },
          ...Object.entries(t.ref).map(([s, n]) => ({ dimensions: { httpResponseStatus: Number(s) }, sum: { requests: n } }))];
      } else {
        rows = [{ dimensions: { status: 'success' }, sum: { requests: t.requests - t.errors, errors: 0 }, quantiles: { wallTimeP50: 10000, wallTimeP99: 50000 } }];
        if (t.errors) rows.push({ dimensions: { status: 'scriptThrewException' }, sum: { requests: t.errors, errors: t.errors }, quantiles: { wallTimeP50: 10000, wallTimeP99: 50000 } });
      }
      return res.end(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }));
  });
}).listen(0);
const run = (traffic, extra, refMode, more) => new Promise(resolve => {
  pipeline(extra);
  fs.writeFileSync(STATE, JSON.stringify(Object.assign({ dep: [{ version_id: OLD, percentage: 100 }], traffic, refMode }, more)));
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
// Fail-safe: the status field is unconfirmed on the live API, so a refusal read that fails never rolls back. The same
// traffic as the jump test, which would roll back if the read worked, goes to 100% as it would without the check.
for (const mode of ['gqlError', 'null', 'http500', 'shape']) {
  test(`refusals: an unreadable refusal query (${mode}) is logged and skipped, never a rollback`, async () => {
    const r = await run({ [OLD]: { requests: 9000, ref: { 302: 90 } }, [NEW]: { requests: 1000, ref: { 302: 150, 403: 100 } } }, {}, mode);
    assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
    assert.deepEqual(r.state.dep, [{ version_id: NEW, percentage: 100 }]);
    const u = r.lines.filter(l => l.step === 'refusals_unreadable');
    assert.equal(u.length, r.watches.length); assert.ok(u[0].why);
    assert.ok(!r.lines.some(l => l.step === 'rolled_back' || l.step === 'analytics_retry'));
    assert.equal(r.watches[0].new.refusals, undefined);
  });
}
// Go live rules (v1.0.9, Tyler 5 Nov 2026). Too little traffic never rolls back: past max_watch_minutes the step holds
// and keeps polling up to max_wait_minutes; still too little = held_low_traffic, exit 4, the split left as it is.
const LOW = { [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 5, ref: {} } };
const ENOUGH = { [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 1000, ref: {} } };
test('low traffic: holds at the step and keeps polling; enough traffic arrives and it promotes', async () => {
  const r = await run(LOW, { max_wait_minutes: 30 }, undefined, { after: { polls: 6, traffic: ENOUGH } });
  assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
  const h = r.lines.filter(l => l.step === 'holding_low_traffic');
  assert.equal(h.length, 1); assert.equal(h[0].pct, 10); assert.equal(h[0].until_minutes, 30);
  assert.ok(r.watches.some(w => w.verdict === 'wait' && w.minutes >= 4));
  assert.ok(!r.lines.some(l => l.step === 'rolled_back'));
  assert.deepEqual(r.state.dep, [{ version_id: NEW, percentage: 100 }]);
});
test('low traffic until max_wait_minutes: held_low_traffic, exit 4, no rollback, no promote', async () => {
  const r = await run(LOW, { max_wait_minutes: 8 });
  assert.equal(r.code, 4, JSON.stringify(r.last)); assert.equal(r.last.step, 'held_low_traffic');
  assert.equal(r.last.pct, 10); assert.equal(r.last.new_requests, 5); assert.equal(r.last.old_requests, 9000);
  assert.equal(r.last.min_requests, 50); assert.equal(r.last.max_wait_minutes, 8); assert.ok(r.last.minutes >= 8);
  assert.deepEqual(r.last.split, { [OLD]: 90, [NEW]: 10 });
  assert.deepEqual(r.state.dep, [{ version_id: OLD, percentage: 90 }, { version_id: NEW, percentage: 10 }]);
  assert.ok(!r.lines.some(l => l.step === 'rolled_back' || (l.step === 'deployed' && l.pct === 100)));
});
test('low traffic: a max_wait_minutes below max_watch_minutes is refused before anything runs', async () => {
  const r = await run(LOW, { max_wait_minutes: 2 });
  assert.equal(r.code, 2); assert.equal(r.lines.length, 0);
  assert.deepEqual(r.state.dep, [{ version_id: OLD, percentage: 100 }]);
});
test('low traffic: an error breach during the hold still rolls back', async () => {
  const r = await run({ [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 5, errors: 2, ref: {} } }, { max_wait_minutes: 30 });
  assert.equal(r.code, 1, JSON.stringify(r.last)); assert.equal(r.last.step, 'rolled_back');
  assert.match(r.last.why, /^error rate 0\.4000 \(old 0\.0000\)/);
  assert.ok(r.watches[r.watches.length - 1].minutes >= 4);
  assert.ok(r.watches.slice(0, -1).every(w => w.verdict === 'wait'));
  assert.deepEqual(r.state.dep, [{ version_id: OLD, percentage: 100 }]);
});

// Dark releases: rollout.dark, every switch read off on live = no traffic count, the smoke list at 100%.
const DARK = { release: 'v2', switches: [{ kind: 'd1', binding: 'DB', key: 'feature_x', off: ['off'] },
  { kind: 'kv', binding: 'SNAP', key: 'flag/x', off: ['false'] }] };
const TINY = { [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 3, ref: {} } };
test('dark: every switch off (D1 row off, KV key missing): no traffic count, smoke at 100%, promotes', async () => {
  const r = await run(TINY, { dark: DARK, max_wait_minutes: 8 }, undefined, { d1: { feature_x: 'off' } });
  assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
  const d = r.lines.find(l => l.step === 'dark');
  assert.deepEqual(d.switches, [{ kind: 'd1', binding: 'DB', key: 'feature_x', value: 'off' }, { kind: 'kv', binding: 'SNAP', key: 'flag/x', value: null }]);
  assert.ok(r.watches.length > 0 && r.watches.every(w => w.dark === true && w.verdict === 'ok'));
  assert.ok(!r.lines.some(l => l.step === 'holding_low_traffic' || l.step === 'dark_refused'));
  assert.ok(!r.state.refQueries); assert.ok(r.state.smokes >= 1);
  assert.deepEqual(r.state.dep, [{ version_id: NEW, percentage: 100 }]);
});
test('dark: still rolls back on an error breach on any traffic', async () => {
  const r = await run({ [OLD]: { requests: 9000, ref: {} }, [NEW]: { requests: 3, errors: 1, ref: {} } }, { dark: DARK }, undefined, { d1: { feature_x: 'off' } });
  assert.equal(r.code, 1, JSON.stringify(r.last)); assert.equal(r.last.step, 'rolled_back'); assert.match(r.last.why, /^error rate/);
});
test('dark: a switch on is dark_refused, and the normal watch runs (here: held at low traffic)', async () => {
  const r = await run(TINY, { dark: DARK, max_wait_minutes: 8 }, undefined, { d1: { feature_x: 'off' }, kv: { 'flag/x': 'true' } });
  const d = r.lines.find(l => l.step === 'dark_refused');
  assert.match(d.why, /^kv SNAP flag\/x is on \("true"\)/);
  assert.ok(!r.lines.some(l => l.step === 'dark') && r.watches.every(w => !w.dark));
  assert.equal(r.code, 4); assert.equal(r.last.step, 'held_low_traffic'); assert.ok(!r.state.smokes);
});
for (const mode of ['http500', 'shape']) {
  test(`dark: an unreadable switch (${mode}) is dark_refused, and the normal watch runs`, async () => {
    const r = await run(ENOUGH, { dark: DARK }, undefined, { switchMode: mode });
    assert.match(r.lines.find(l => l.step === 'dark_refused').why, /^d1 DB feature_x unreadable: /);
    assert.equal(r.code, 0, JSON.stringify(r.last)); assert.equal(r.last.step, 'done');
    assert.ok(r.watches.every(w => !w.dark)); assert.ok(r.state.refQueries > 0);
  });
}
test('dark: a declaration for another release is dark_refused at deploy too (CI refuses it first: proof.test.mjs)', async () => {
  const r = await run(ENOUGH, { dark: Object.assign({}, DARK, { release: 'v1' }) }, undefined, { d1: { feature_x: 'off' } });
  assert.match(r.lines.find(l => l.step === 'dark_refused').why, /rollout\.dark\.release "v1" is not this release "v2"/);
  assert.equal(r.code, 0); assert.ok(r.watches.every(w => !w.dark));
});
test.after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
