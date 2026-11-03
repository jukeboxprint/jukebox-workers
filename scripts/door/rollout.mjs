// Uploads a Worker's release as a new version and rolls it out in steps, rolling back on a breach.
//   CLOUDFLARE_API_TOKEN=… node scripts/door/rollout.mjs [--worker <folder under workers/>] --env live|staging
//        --message "<text>" [--tag <git sha>] [--steps 10,100] [--dry]          (default worker: front-door)
//   CLOUDFLARE_API_TOKEN=… node scripts/door/rollout.mjs [--worker …] --env live --restore <version id>
// Every threshold comes from workers/<worker>/pipeline.json (rollout.*); --steps overrides steps_pct (staging: 100).
// After 100% the health paths are checked, and (rollout.smoke_after_100, kind passthrough) pipeline.json's smoke list,
// which sends no secret, so a Worker whose every path needs one is still checked to boot and refuse.
//   1. The current deployment must be one version at 100% (a rollout already half done is left for a person).
//   2. `wrangler versions upload` (the dist file, no bundling): the new version, not yet serving.
//   3. Each step below 100: `wrangler versions deploy old@(100-p)% new@p%`, then watch Workers analytics per version
//      for watch_minutes (longer, up to max_watch_minutes, until min_requests reach the new version). Breach or too
//      little traffic: `wrangler versions deploy old@100%` and exit 1.
//   4. 100%: new@100%, then the health paths must answer as pipeline.json says (else back to old@100%).
// A deploy command that fails is checked against the real deployment: anything but old@100% is put back. A rollback
// is retried rollback_retries times; if it still fails the run prints rollback_failed and exits 3 (a person must look).
// --restore <id>: the workflow's failure/cancel step; puts <id> back at 100% unless it already is.
// Prints one JSON line per step (wrangler's own output goes to stderr). --dry prints what it would run, writes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { worker, smokeList } from './worker.mjs';

const { WORKER, WD, PIPE } = worker();
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENV = arg('--env') || 'live';
const DRY = process.argv.includes('--dry');
const RESTORE = arg('--restore');
const BOOTSTRAP = process.argv.includes('--bootstrap');
const CFG = PIPE.rollout, HOSTS = PIPE.hosts;
const REL = JSON.parse(fs.readFileSync(path.join(WD, 'release.json'), 'utf8'));
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
const die = (m, code = 2) => { console.error('door rollout: ' + m); process.exit(code); };
if (ENV !== 'live' && !(toml.env && toml.env[ENV])) die(`unknown --env ${ENV}`);
const NAME = ENV === 'live' ? toml.name : toml.env[ENV].name;
// A non-live env must never name the live Worker: the token is account-wide, so this is what keeps a staging run
// (no reviewer) off live even if wrangler.toml is edited.
if (ENV !== 'live' && (NAME === toml.name || !NAME.endsWith('-' + ENV))) die(`env ${ENV} names Worker ${NAME}: refused`);
const ACCT = toml.account_id;
const STEPS = (arg('--steps') || CFG.steps_pct.join(',')).split(',').map(Number);
const MSG = arg('--message') || `${WORKER === 'front-door' ? 'front door' : WORKER} ${REL.version}`;
const msg = s => s.slice(0, 100);
const TAG = arg('--tag') || '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const log = o => console.log(JSON.stringify(Object.assign({ env: ENV, worker: NAME }, o)));
const SCALE = Number(process.env.DOOR_TIME_SCALE || 1);  // test hook: shrinks every wait and the watch clock
const sleep = ms => new Promise(r => setTimeout(r, ms * SCALE));
const T = () => AbortSignal.timeout(CFG.http_timeout_s * 1000);
if (!TOKEN && !DRY) die('CLOUDFLARE_API_TOKEN not set');
if (STEPS[STEPS.length - 1] !== 100 || STEPS.some((p, i) => p < 10 || p > 100 || (i && p <= STEPS[i - 1]))) {
  die('steps must ascend, each 10-100, ending at 100: ' + STEPS);
}
// The job's timeout (the workflow passes it) must cover every watch, or a cancel could leave traffic split.
const JOB_MIN = Number(process.env.DOOR_JOB_TIMEOUT_MIN || 0);
const NEED_MIN = STEPS.filter(p => p < 100).length * CFG.max_watch_minutes + CFG.job_margin_minutes;
if (JOB_MIN && !RESTORE && NEED_MIN > JOB_MIN) die(`job timeout ${JOB_MIN} min < ${NEED_MIN} min the watch can take (pipeline.json)`);

const api = async (p, init) => {
  const r = await fetch(`${process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'}${p}`, Object.assign({ signal: T() }, init, {
    headers: Object.assign({ authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, (init || {}).headers) }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.errors && j.errors.length && !j.data)) throw new Error(`${p}: HTTP ${r.status} ${JSON.stringify(j.errors || '').slice(0, 300)}`);
  return j;
};
const OUTFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'door-roll-')), 'out.ndjson');
const wrangler = (args) => {
  const full = ['--no-install', 'wrangler', ...args, ...(ENV === 'live' ? [] : ['--env', ENV])];
  if (DRY) { log({ dry: 'npx ' + full.join(' ') }); return ''; }
  const env = Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: OUTFILE });
  // DOOR_WRANGLER: test hook (tests/door-pipeline/rollout_test.mjs runs a fake wrangler); unset in CI.
  const out = process.env.DOOR_WRANGLER
    ? execFileSync(process.execPath, [process.env.DOOR_WRANGLER, ...full.slice(2)], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npx', full, { cwd: WD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  process.stderr.write(out);
  return out;
};
const current = async () => {
  const d = await api(`/accounts/${ACCT}/workers/scripts/${NAME}/deployments`);
  const cur = ((d.result || {}).deployments || [])[0];
  return cur ? cur.versions.map(v => ({ version_id: v.version_id, percentage: v.percentage })) : null;
};
const isOnly = (cur, v) => !!cur && cur.length === 1 && cur[0].version_id === v && cur[0].percentage === 100;

// Put `to` back at 100%, retried. Exits 1 when done (a rollback is a failed deploy), 3 when it could not.
async function back(to, why) {
  for (let i = 1; i <= CFG.rollback_retries; i++) {
    try {
      wrangler(['versions', 'deploy', `${to}@100%`, '--yes', '--message', msg(`rollback: ${why}`)]);
      if (DRY) break;
      const cur = await current();
      if (isOnly(cur, to)) break;
      throw new Error('deployment after rollback: ' + JSON.stringify(cur));
    } catch (e) {
      log({ step: 'rollback_try', n: i, error: String(e.message || e).slice(0, 200) });
      if (i === CFG.rollback_retries) {
        let cur = null; try { cur = await current(); } catch (x) {}
        log({ step: 'rollback_failed', to, why, current: cur });
        process.exit(3);
      }
      await sleep(CFG.rollback_retry_s * 1000);
    }
  }
  log({ step: 'rolled_back', to, why });
  process.exit(1);
}

// A deploy that throws may still have happened: look, and put old back unless old@100% already serves.
async function deploy(args, oldV, label) {
  try { wrangler(args); }
  catch (e) {
    const why = `${label} failed: ${String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-1)[0] || ''}`.slice(0, 200);
    let cur = null; try { cur = await current(); } catch (x) {}
    if (isOnly(cur, oldV)) { log({ step: 'deploy_failed', why, current: cur }); process.exit(1); }
    await back(oldV, why);
  }
}

// Workers analytics for one version since t0 (GraphQL, the same query checked from the dashboard 31 Oct).
// Errors are invocation outcomes (exceptions, limits); a Worker that answers HTTP 5xx counts as success here,
// which is why health is checked after 100% (docs/...-pipeline.md 6).
async function stats(version, since) {
  const q = `query($a:String!,$s:Time!,$e:Time!,$n:String!,$v:String!){viewer{accounts(filter:{accountTag:$a}){
    workersInvocationsAdaptive(limit:50,filter:{scriptName:$n,scriptVersion:$v,datetime_geq:$s,datetime_leq:$e}){
      dimensions{status} sum{requests errors} quantiles{wallTimeP50 wallTimeP99}}}}}`;
  const j = await api('/graphql', { method: 'POST', body: JSON.stringify({ query: q,
    variables: { a: ACCT, s: new Date(since).toISOString(), e: new Date().toISOString(), n: NAME, v: version } }) });
  const rows = (((j.data || {}).viewer || {}).accounts || [{}])[0].workersInvocationsAdaptive || [];
  let req = 0, err = 0, p50 = 0, p99 = 0, okReq = 0;
  for (const r of rows) {
    req += r.sum.requests;
    if (!CFG.ignore_statuses.includes(r.dimensions.status)) err += r.sum.requests;
    if (r.dimensions.status === 'success') { okReq = r.sum.requests; p50 = r.quantiles.wallTimeP50 / 1000; p99 = r.quantiles.wallTimeP99 / 1000; }
  }
  return { requests: req, errors: err, error_rate: req ? err / req : 0, p50_ms: Math.round(p50), p99_ms: Math.round(p99), success: okReq };
}

function judge(nw, old) {
  if (nw.requests < CFG.min_requests) return 'wait';
  const bad = [];
  if (nw.error_rate > CFG.max_error_rate && nw.error_rate > old.error_rate * CFG.max_error_rate_vs_old) bad.push(`error rate ${nw.error_rate.toFixed(4)} (old ${old.error_rate.toFixed(4)})`);
  if (old.p50_ms && nw.p50_ms > old.p50_ms * CFG.max_p50_ms_vs_old) bad.push(`p50 ${nw.p50_ms} ms (old ${old.p50_ms})`);
  if (nw.success >= CFG.p99_min_requests && old.p99_ms && nw.p99_ms > old.p99_ms * CFG.max_p99_ms_vs_old) bad.push(`p99 ${nw.p99_ms} ms (old ${old.p99_ms})`);
  return bad.length ? bad.join('; ') : 'ok';
}

async function health() {
  const host = process.env.DOOR_HOST || HOSTS[ENV];
  const expect = (CFG.health_expect || {})[ENV] || {};
  for (const p of CFG.health_paths) {
    const r = await fetch(host + p, { headers: { 'cache-control': 'no-cache' }, signal: T() }).catch(e => ({ status: 0 }));
    if (r.status !== 200) return `${p} answered ${r.status}`;
    if (expect[p]) {
      const j = await r.json().catch(() => ({}));
      for (const [k, v] of Object.entries(expect[p])) if (j[k] !== v) return `${p} ${k} is ${JSON.stringify(j[k])}, want ${JSON.stringify(v)}`;
    }
  }
  if (CFG.smoke_after_100) {
    const bad = (await smokeList(host, PIPE.smoke, CFG.http_timeout_s, ENV)).filter(r => !r.ok);
    if (bad.length) return `smoke: ${bad.map(r => `${r.name} got ${JSON.stringify(r.got)}`).join('; ')}`.slice(0, 300);
  }
  return 'ok';
}

// --bootstrap: one full `wrangler deploy` (applies migrations, creates the Worker's own namespaces), then health.
// Staging: any Worker. Live: only a new Worker whose pipeline.json says bootstrap_live (copilot-jobs), and only while the
// live Worker is a dashboard placeholder with no migration tag (GET /workers/services/<name>): once it has one, live is
// changed only by the gradual rollout. Every other Worker: refused on live, as before.
if (BOOTSTRAP) {
  if (ENV === 'live' && !PIPE.bootstrap_live) die('--bootstrap is for staging only: live is changed only by the gradual rollout');
  if (ENV === 'live' && !DRY) {
    let svc;
    try { svc = await api(`/accounts/${ACCT}/workers/services/${NAME}`); }
    catch (e) { die(`live ${NAME} not readable (${String(e.message || e).slice(0, 160)}): create the dashboard placeholder first`); }
    const tag = ((((svc.result || {}).default_environment || {}).script) || {}).migration_tag || '';
    if (tag) die(`live ${NAME} already has migration tag ${JSON.stringify(tag)}: not a placeholder; live is changed only by the gradual rollout`);
    log({ step: 'placeholder', migration_tag: '' });
  }
  wrangler(['deploy', '--message', msg(MSG), ...(TAG ? ['--tag', TAG.slice(0, 40)] : [])]);
  log({ step: 'bootstrapped', release: REL.version, sha256: REL.sha256 });
  if (DRY) process.exit(0);
  await sleep(CFG.health_delay_s * 1000);
  const h = await health();
  if (h !== 'ok') { log({ step: 'health', ok: false, why: h }); process.exit(1); }
  log({ step: 'health', ok: true });
  process.exit(0);
}

// --restore: the workflow's last step when the job failed or was cancelled.
if (RESTORE) {
  if (!/^[0-9a-f-]{36}$/.test(RESTORE)) die('--restore needs a version id');
  const cur = await current();
  if (isOnly(cur, RESTORE)) { log({ step: 'restore', needed: false, current: cur }); process.exit(0); }
  await back(RESTORE, 'job failed or cancelled mid-rollout');
}

// 1. current deployment
let oldV = 'OLD';
if (!DRY) {
  const cur = await current();
  if (!cur || cur.length !== 1 || cur[0].percentage !== 100) {
    log({ step: 'refused', why: 'current deployment is not one version at 100%', current: cur }); process.exit(1);
  }
  oldV = cur[0].version_id;
}
log({ step: 'current', version: oldV });

// 2. upload
wrangler(['versions', 'upload', '--message', msg(MSG), ...(TAG ? ['--tag', TAG.slice(0, 40)] : [])]);
let newV = 'NEW';
if (!DRY) {
  const lines = fs.readFileSync(OUTFILE, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return {}; } });
  const up = lines.reverse().find(l => l.type === 'version-upload');
  if (!up || !up.version_id) { log({ step: 'upload', ok: false }); process.exit(1); }
  newV = up.version_id;
}
log({ step: 'uploaded', version: newV, release: REL.version, sha256: REL.sha256 });

// 3. steps
for (const p of STEPS) {
  if (p === 100) {
    await deploy(['versions', 'deploy', `${newV}@100%`, '--yes', '--message', msg(MSG)], oldV, 'deploy 100%');
    log({ step: 'deployed', pct: 100, version: newV });
    if (DRY) break;
    await sleep(CFG.health_delay_s * 1000);
    const h = await health();
    if (h !== 'ok') await back(oldV, 'health after 100%: ' + h);
    log({ step: 'health', ok: true });
    break;
  }
  await deploy(['versions', 'deploy', `${oldV}@${100 - p}%`, `${newV}@${p}%`, '--yes', '--message', msg(`${MSG} (${p}%)`)], oldV, `deploy ${p}%`);
  const t0 = Date.now();
  log({ step: 'deployed', pct: p, version: newV });
  if (DRY) continue;
  for (;;) {
    await sleep(CFG.poll_seconds * 1000);
    const mins = (Date.now() - t0) / 60000 / SCALE;
    let nw, old;
    try { [nw, old] = await Promise.all([stats(newV, t0), stats(oldV, t0)]); }
    catch (e) { await back(oldV, 'analytics unreadable: ' + String(e.message || e).slice(0, 120)); }
    const v = judge(nw, old);
    log({ step: 'watch', pct: p, minutes: Math.round(mins * 10) / 10, new: nw, old, verdict: v });
    if (v !== 'ok' && v !== 'wait') await back(oldV, v);
    if (v === 'ok' && mins >= CFG.watch_minutes) break;
    if (mins >= CFG.max_watch_minutes) await back(oldV, v === 'wait' ? `not enough traffic to judge (${nw.requests} < ${CFG.min_requests})` : v);
  }
}
log({ step: 'done', version: newV });
