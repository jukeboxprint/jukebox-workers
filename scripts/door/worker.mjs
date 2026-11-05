// Which Worker a pipeline script acts on: --worker <folder under workers/>, default front-door (so every existing call,
// and the front door workflows, behave exactly as before). pipeline.json's `kind` says which checks apply:
//   door         (default) jbx-front-door: build proof vNN from vNN-1, replay suites, scripts/door/smoke.mjs;
//   passthrough  a small Worker with no build step (jbx-claude-cache): the release is the source file, smoke is the
//                request list in pipeline.json (scripts/door/smoke_simple.mjs). A passthrough Worker written in
//                TypeScript (copilot-suggest) commits its built single-module release; release.json build names the
//                script, and proof.mjs rebuilds the file from source and compares it byte for byte.
import fs from 'node:fs';
import path from 'node:path';

// jukebox-workers: the scripts run from their own checkout (.jbx-pipeline/ in a caller's run), so the repo they act on
// is JBX_REPO_ROOT (the caller's checkout). Unset = the folder two levels up, as in jukebox-copilot.
export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = process.env.JBX_REPO_ROOT ? path.resolve(process.env.JBX_REPO_ROOT) : path.resolve(HERE, '../..');

export function worker() {
  const i = process.argv.indexOf('--worker');
  const name = i > 0 ? process.argv[i + 1] : 'front-door';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name || '')) { console.error(`--worker ${name}: not a folder name`); process.exit(2); }
  const WD = path.join(ROOT, 'workers', name);
  if (!fs.existsSync(path.join(WD, 'wrangler.toml'))) { console.error(`--worker ${name}: workers/${name}/wrangler.toml missing`); process.exit(2); }
  const PIPE = JSON.parse(fs.readFileSync(path.join(WD, 'pipeline.json'), 'utf8'));
  return { WORKER: name, WD, PIPE, KIND: PIPE.kind || 'door' };
}

// The config wrangler uses for an env (top level for live; [env.<name>] over it otherwise, as the scripts always did).
export const envConfig = (toml, env) => env === 'live' ? toml : Object.assign({}, toml, toml.env[env]);

// Non-secret bindings a version for `env` must carry, as drift.mjs and proof.mjs compare them.
export function wantBindings(toml, env) {
  const w = envConfig(toml, env);
  const e = [];
  for (const k of w.kv_namespaces || []) e.push(`kv_namespace ${k.binding} ${k.id}`);
  for (const d of w.d1_databases || []) e.push(`d1 ${d.binding} ${d.database_id}`);
  for (const [k, v] of Object.entries(w.vars || {})) e.push(`plain_text ${k} ${v}`);
  // Durable Object bindings (jbx-desk-live) and service bindings: never inherited from the top level by wrangler, and an
  // env that leaves them out gets none (the upload form proves it). The namespace id is checked by drift.mjs, not here
  // (wrangler never sends it: Cloudflare resolves the class to the Worker's namespace).
  for (const d of (w.durable_objects || {}).bindings || []) e.push(doBinding(d.name, d.class_name, d.script_name, w.name));
  for (const s of w.services || []) e.push(`service ${s.binding} ${s.service}`);
  // Hyperdrive (jukebox-workers v1.0.0): never inherited by an env (wrangler), so an env without its own has none; staging
  // normally has none (no live data). An id of TBD blocks every deploy, as for KV and D1.
  for (const h of (env === 'live' ? toml.hyperdrive : ((toml.env || {})[env] || {}).hyperdrive) || []) e.push(`hyperdrive ${h.binding} ${h.id}`);
  // Queue producers (v1.0.7): never inherited by an env (wrangler: queues is not inheritable), like Hyperdrive.
  for (const q of queuesFor(toml, env).producers || []) e.push(`queue ${q.binding} ${q.queue}`);
  return e.sort();
}
// One Durable Object binding in drift's form; a script_name naming the Worker itself is the same as none.
export const doBinding = (name, cls, script, self) => `durable_object_namespace ${name} ${cls}${script && script !== self ? ' @' + script : ''}`;
// The migration tag a Worker must carry: the last [[migrations]] block (inherited by envs, as wrangler does). '' = none.
export const lastMigrationTag = (toml, env) => { const m = envConfig(toml, env).migrations || []; return m.length ? String(m[m.length - 1].tag) : ''; };

// Differences between the toml's observability table and what Cloudflare reports (only keys the toml sets; a key
// Cloudflare leaves out counts as false). [] when equal. Both undefined: [].
// Runs pipeline.json's smoke list (kind passthrough) against host: each { name, method, path, headers, body,
// expect_status, expect_body, expect_json, expect_contains, expect_headers, by_env }. No secrets are ever sent, so it is
// safe on live too. Returns [{ name, ok, got }]. expect_json: the answer's JSON must contain these keys and values
// (nested objects compared the same way; extra keys allowed), for answers with live counts in them (jbx-desk-live's
// /health). expect_contains: strings the body must contain, for answers with a timestamp in them (copilot-suggest's
// streamed Deny Suggest). expect_headers: { name: value } the answer's headers must carry exactly. by_env: { <env>:
// { expect_status, expect_body, expect_json, ... } } replaces those for that env (a Worker with no secrets on staging
// refuses with a different answer, e.g. 503 "not configured" instead of 401); null there = not checked for that env.
// No env, or no by_env entry: the defaults.
const jsonHas = (have, want) => want && typeof want === 'object'
  ? !!have && typeof have === 'object' && Object.entries(want).every(([k, v]) => jsonHas(have[k], v)) : have === want;
export async function smokeList(host, list, timeoutS = 15, env) {
  const res = [];
  for (const s0 of list || []) {
    const s = Object.assign({}, s0, (env && s0.by_env && s0.by_env[env]) || {});
    let got;
    try {
      const r = await fetch(host.replace(/\/$/, '') + s.path, { method: s.method || 'GET', headers: s.headers || {}, body: s.body,
        redirect: 'manual', signal: AbortSignal.timeout(timeoutS * 1000) });
      const t = await r.text();
      got = { status: r.status, body: t.slice(0, 80) };
      let j = null; if (s.expect_json != null) { try { j = JSON.parse(t); } catch (e) { j = null; } }
      res.push({ name: s.name, ok: r.status === s.expect_status && (s.expect_body == null || t === s.expect_body)
        && (s.expect_json == null || jsonHas(j, s.expect_json))
        && (s.expect_contains == null || s.expect_contains.every(x => t.includes(x)))
        && (s.expect_headers == null || Object.entries(s.expect_headers).every(([k, v]) => r.headers.get(k) === v)), got });
    } catch (e) { res.push({ name: s.name, ok: false, got: String(e.message || e).slice(0, 120) }); }
  }
  return res;
}

// skip: full paths (e.g. "observability.logs.enabled") left out of the comparison.
export function obsDiff(want, have, at = 'observability', skip = []) {
  if (want === undefined) return [];
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    const h = have && typeof have === 'object' ? have[k] : undefined;
    if (skip.includes(`${at}.${k}`)) continue;
    if (v && typeof v === 'object') out.push(...obsDiff(v, h, `${at}.${k}`, skip));
    else if (!(h === v || (v === false && h === undefined))) out.push(`${at}.${k} is ${JSON.stringify(h)}, toml ${JSON.stringify(v)}`);
  }
  return out;
}

// Health after a deploy, polled: a new version can take a while to reach every edge, so one read just after the
// deploy can see the old version (or a cold start) and roll back a healthy release (jbx-accounting staging, 3 Nov 2026).
// check() returns 'ok' or why not; it is retried every poll_s seconds until it says ok or wait_s seconds have passed
// (pipeline.json rollout.health_wait_s / health_poll_s; defaults 90 / 5; wait_s 0 = one read, as before).
// Returns { ok, why, tries }. sleep(ms) is the caller's (rollout.mjs scales it in tests).
export async function pollHealth(check, { wait_s, poll_s, sleep }) {
  const wait = Math.max(0, Number.isFinite(Number(wait_s)) && wait_s !== '' && wait_s != null ? Number(wait_s) : 90);
  const every = Math.max(1, Number(poll_s) > 0 ? Number(poll_s) : 5);
  const tries = 1 + Math.floor(wait / every);
  let why = 'not checked';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(every * 1000);
    why = await check();
    if (why === 'ok') return { ok: true, why: 'ok', tries: i + 1 };
  }
  return { ok: false, why: `${why} (${tries} ${tries === 1 ? 'read' : 'reads'} over ${wait} s)`, tries };
}

// A read the rollout judges by (Workers analytics per version), retried before it counts as unreadable: one API timeout
// rolled back a healthy front door v51 on 4 Nov 2026 ("analytics unreadable: The operation was aborted due to
// timeout"). read() is tried up to tries times (pipeline.json rollout.analytics_tries, default 3), wait_s apart
// (rollout.analytics_retry_s, default 10); onRetry(attempt, error) is told before each retry. Returns read()'s value, or
// throws the last error. A breach is not an error: only a read that fails is retried.
export async function retryRead(read, { tries, wait_s, sleep, onRetry }) {
  const n = Math.max(1, Math.floor(Number(tries) > 0 ? Number(tries) : 3));
  const wait = Number(wait_s) >= 0 && wait_s !== '' && wait_s != null ? Number(wait_s) : 10;
  let last;
  for (let i = 0; i < n; i++) {
    if (i) { if (onRetry) onRetry(i + 1, last); await sleep(wait * 1000); }
    try { return await read(); } catch (e) { last = e; }
  }
  throw last;
}

// Cron triggers ([triggers] crons in wrangler.toml; an env inherits the top level unless it sets its own, as wrangler
// does). jbx-accounting's nightly reconcile is the first (4 Nov 2026). proof checks them, drift compares them with the
// Worker's schedules, and scripts/door/triggers.mjs sets them after a deploy (`wrangler versions deploy` does not).
export const cronsFor = (toml, env) => {
  const c = envConfig(toml, env);
  return [...new Set(((c.triggers || {}).crons || []).map(s => String(s).trim()))].sort();
};
// Five fields: minute hour day-of-month month day-of-week; numbers, *, ranges, lists, steps, and the day / month names
// Cloudflare accepts. A typo is refused here rather than by Cloudflare at deploy time.
export const validCron = s => {
  const f = String(s).trim().split(/\s+/);
  return f.length === 5 && f.every(x => /^(\*|[0-9A-Za-z]+(-[0-9A-Za-z]+)?)(\/[0-9]+)?(,(\*|[0-9A-Za-z]+(-[0-9A-Za-z]+)?)(\/[0-9]+)?)*$/.test(x));
};
// What the deploy must do: 'same' (nothing), or 'set' (wrangler triggers deploy). have = the Worker's schedules.
export const cronPlan = (want, have) => {
  const a = [...new Set(want)].sort(), b = [...new Set(have)].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]) ? 'same' : 'set';
};

// Refusals during a gradual rollout (v1.0.6): responses with HTTP 302 or 403, as a share of each version's requests.
// A write route that starts refusing (sign-in or csrf: "Not allowed for your role") looks healthy by status code and
// error rate (jbx-inflow /jbx-reorder, 4 Nov 2026; PATTERN rule 10a.1). pipeline.json rollout.*:
//   refusals                  false = not checked (default on)
//   max_refusal_share_vs_old  new share must exceed old share × this to breach (default 2)
//   min_refusal_excess        and exceed it by at least this, absolute (default 0.05)
// Judged only once the new version has rollout.min_requests (as the error rate is). A bad setting = the default.
export const REFUSAL_STATUSES = [302, 403];
export function refusalSettings(rollout) {
  const c = rollout || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return { on: c.refusals !== false, vs_old: num(c.max_refusal_share_vs_old, 2), min_excess: num(c.min_refusal_excess, 0.05),
    min_requests: num(c.min_requests, 0) };
}
// rows: workersInvocationsAdaptive grouped by httpResponseStatus. Returns { requests, refused, share }.
export function refusalCount(rows) {
  let requests = 0, refused = 0;
  for (const r of rows || []) {
    const n = Number(((r || {}).sum || {}).requests) || 0;
    requests += n;
    if (REFUSAL_STATUSES.includes(Number(((r || {}).dimensions || {}).httpResponseStatus))) refused += n;
  }
  return { requests, refused, share: requests ? refused / requests : 0 };
}
// null when fine (or too few requests to judge), else why. nw / old: refusalCount() results.
export function judgeRefusals(nw, old, s) {
  if (!s.on || !nw || !old || nw.requests < s.min_requests) return null;
  if (nw.share > old.share * s.vs_old && nw.share - old.share >= s.min_excess) {
    return `refusals (302/403) ${nw.share.toFixed(4)} (${nw.refused}/${nw.requests}; old ${old.share.toFixed(4)}, ${old.refused}/${old.requests})`;
  }
  return null;
}

// Queues (v1.0.7; jbx-bq's write path, jukebox-door PR #9). [[queues.producers]] are version bindings (wantBindings,
// proof, drift). [[queues.consumers]] are not: `wrangler versions upload` / `versions deploy` never set them, so
// scripts/door/queues.mjs sets and checks them after a deploy. Neither is inherited by an env (wrangler 4.156: queues
// is notInheritable). The pipeline never creates a queue: a missing one fails with QUEUE_MISSING's message.
export const queuesFor = (toml, env) => (env === 'live' ? toml.queues : (((toml.env || {})[env] || {}).queues)) || {};
export const QUEUE_MISSING = n => `queue ${n} does not exist: create it in the dashboard or with \`wrangler queues create ${n}\`, on Tyler's word (the pipeline never creates queues)`;
const PRODUCER_KEYS = ['binding', 'queue'];
const CONSUMER_KEYS = ['queue', 'max_batch_size', 'max_batch_timeout', 'max_retries', 'dead_letter_queue'];
const QNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The consumers the toml sets for env, in the Cloudflare API's terms (wrangler's own request body: max_batch_timeout
// seconds -> settings.max_wait_time_ms). Sorted by queue.
export const consumersFor = (toml, env) => (queuesFor(toml, env).consumers || []).map(c => ({ queue: c.queue,
  dead_letter_queue: c.dead_letter_queue || '', batch_size: c.max_batch_size, max_retries: c.max_retries,
  max_wait_time_ms: typeof c.max_batch_timeout === 'number' ? c.max_batch_timeout * 1000 : c.max_batch_timeout }))
  .sort((a, b) => a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0);
// Every queue the toml names for env (producers, consumers, dead-letter queues). [] = the Worker has no queues.
export const queueNamesFor = (toml, env) => {
  const q = queuesFor(toml, env);
  return [...new Set([...(q.producers || []).map(p => p.queue), ...(q.consumers || []).flatMap(c => [c.queue, c.dead_letter_queue])]
    .filter(x => x !== undefined && x !== null && x !== ''))].sort();
};
// What the pipeline refuses in a toml's queues for env (proof and drift): keys it does not handle, missing or bad
// values, a queue consumed twice or its own dead-letter queue, and (staging) any queue live names.
export function queueConfigProblems(toml, env) {
  const q = queuesFor(toml, env), bad = [];
  for (const k of Object.keys(q)) if (!['producers', 'consumers'].includes(k)) bad.push(`queues.${k} is not handled by the pipeline`);
  for (const p of q.producers || []) {
    for (const k of Object.keys(p)) if (!PRODUCER_KEYS.includes(k)) bad.push(`queue producer ${p.binding}: ${k} is not handled by the pipeline`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(String(p.binding))) bad.push(`queue producer binding ${JSON.stringify(p.binding)}`);
    if (!QNAME.test(String(p.queue))) bad.push(`queue producer ${p.binding}: queue ${JSON.stringify(p.queue)}`);
  }
  const seen = new Set();
  for (const c of q.consumers || []) {
    for (const k of Object.keys(c)) if (!CONSUMER_KEYS.includes(k)) bad.push(`queue consumer ${c.queue}: ${k} is not handled by the pipeline`);
    if (!QNAME.test(String(c.queue))) bad.push(`queue consumer queue ${JSON.stringify(c.queue)}`);
    if (seen.has(c.queue)) bad.push(`queue ${c.queue} consumed twice`);
    seen.add(c.queue);
    for (const k of ['max_batch_size', 'max_batch_timeout', 'max_retries']) if (!Number.isInteger(c[k]) || c[k] < 0) bad.push(`queue consumer ${c.queue}: ${k} must be set (a whole number)`);
    if (c.dead_letter_queue !== undefined && (!QNAME.test(String(c.dead_letter_queue)) || c.dead_letter_queue === c.queue)) bad.push(`queue consumer ${c.queue}: dead_letter_queue ${JSON.stringify(c.dead_letter_queue)}`);
  }
  if (env !== 'live') for (const n of queueNamesFor(toml, env)) if (queueNamesFor(toml, 'live').includes(n)) bad.push(`${env} names live's queue ${n} (staging holds no live data)`);
  return bad;
}
// One queue by name from GET /accounts/<a>/queues?name=<n> (api(path) returns the result; wrangler 4.156's getQueue
// reads the same list). null = no such queue. Throws on any answer not in the expected shape, before anything changes.
export async function findQueue(api, name) {
  const r = await api(`/queues?page=1&name=${encodeURIComponent(name)}`);
  if (!Array.isArray(r)) throw new Error(`GET /queues?name=${name}: not a list (unexpected shape)`);
  const m = r.filter(q => q && q.queue_name === name);
  if (m.length > 1) throw new Error(`GET /queues?name=${name}: ${m.length} queues with that name (unexpected)`);
  if (!m.length) return null;
  if (typeof m[0].queue_id !== 'string' || !m[0].queue_id || !Array.isArray(m[0].consumers)) throw new Error(`queue ${name}: no queue_id or consumers list (unexpected shape)`);
  return m[0];
}
// This Worker's consumer on queue q, in consumersFor()'s form: { mine, consumer_id } (mine null = none yet). dlq: the
// dead-letter queue's own record (findQueue), to tell a name from an id. Throws when another Worker or an HTTP pull
// consumer holds the queue, or the consumer's answer is not in the expected shape.
export function consumerState(q, self, dlq) {
  const others = q.consumers.filter(c => !(c && c.type === 'worker' && (c.script === self || c.service === self)));
  if (others.length) throw new Error(`queue ${q.queue_name} is consumed by ${others.map(c => (c && (c.script || c.service || c.type)) || '?').join(', ')}, not ${self}: refused`);
  if (q.consumers.length > 1) throw new Error(`queue ${q.queue_name} has ${q.consumers.length} consumers for ${self} (unexpected)`);
  if (!q.consumers.length) return { mine: null };
  const c = q.consumers[0], s = c.settings;
  if (typeof c.consumer_id !== 'string' || !c.consumer_id || !s || typeof s !== 'object'
    || !['batch_size', 'max_retries', 'max_wait_time_ms'].every(k => s[k] === undefined || typeof s[k] === 'number')
    || (c.dead_letter_queue != null && typeof c.dead_letter_queue !== 'string')) throw new Error(`queue ${q.queue_name}: consumer ${JSON.stringify(c).slice(0, 200)} (unexpected shape)`);
  if (dlq && c.dead_letter_queue && c.dead_letter_queue === dlq.queue_id && dlq.queue_id !== dlq.queue_name) throw new Error(`queue ${q.queue_name}: dead_letter_queue reads as an id, not a name (unexpected shape)`);
  return { consumer_id: c.consumer_id, mine: { queue: q.queue_name, dead_letter_queue: c.dead_letter_queue || '', batch_size: s.batch_size,
    max_retries: s.max_retries, max_wait_time_ms: s.max_wait_time_ms } };
}
// Differences between a wanted consumer and the one Cloudflare has (null = none). [] when equal.
export const consumerDiff = (want, have) => !have ? ['not set']
  : ['dead_letter_queue', 'batch_size', 'max_retries', 'max_wait_time_ms'].filter(k => want[k] !== have[k]).map(k => `${k} ${JSON.stringify(have[k])}, toml ${JSON.stringify(want[k])}`);
// The request body wrangler 4.156 sends to POST /queues/<id>/consumers and PUT .../consumers/<consumer_id>.
export const consumerBody = (want, self) => ({ type: 'worker', dead_letter_queue: want.dead_letter_queue || undefined, script_name: self,
  settings: { batch_size: want.batch_size, max_retries: want.max_retries, max_wait_time_ms: want.max_wait_time_ms } });

// Go live rules (v1.0.9, Tyler 5 Nov 2026). Too little traffic never rolls back: the watch holds the step it is on and
// keeps polling up to rollout.max_wait_minutes (default 120, from the step's start; at least max_watch_minutes, at most
// 300). Still too little: the run stops with step held_low_traffic and exit HELD_EXIT, the split left as it is.
export const HELD_EXIT = 4;
export const MAX_WAIT_DEFAULT = 120;
export const maxWait = r => (r || {}).max_wait_minutes === undefined ? MAX_WAIT_DEFAULT : r.max_wait_minutes;
export function waitProblems(r) {
  const v = maxWait(r), w = (r || {}).max_watch_minutes;
  return typeof v === 'number' && Number.isFinite(v) && v >= (Number(w) || 0) && v <= 300 ? []
    : [`rollout.max_wait_minutes ${JSON.stringify(v)}: a number of minutes, at least max_watch_minutes (${w}), at most 300`];
}
// rollout.dark: a release whose new code is all behind switches that are off. { release: <release.json version>,
// switches: [{ kind: 'd1', binding, key, table? (default config), off: [...] } | { kind: 'kv', binding, key, off: [...] }] }.
// A switch is off when its live value is missing or one of `off` (exact strings). proof.mjs refuses any problem here;
// rollout.mjs reads every switch before it skips the traffic count (dark_refused on any doubt).
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function darkProblems(dark, version, pipe, toml) {
  if (!dark || typeof dark !== 'object' || Array.isArray(dark)) return ['rollout.dark must be an object'];
  const bad = [];
  for (const k of Object.keys(dark)) if (!['release', 'switches'].includes(k)) bad.push(`rollout.dark.${k} is not handled`);
  if (dark.release !== version) bad.push(`rollout.dark.release ${JSON.stringify(dark.release)} is not this release ${JSON.stringify(version)} (a dark declaration covers one release: remove it or set it)`);
  if (!Array.isArray(dark.switches) || !dark.switches.length) bad.push('rollout.dark lists no switches');
  if (!((pipe || {}).smoke || []).length) bad.push('rollout.dark needs pipeline.json smoke (a dark release is judged by its smoke list)');
  for (const [i, s] of (Array.isArray(dark.switches) ? dark.switches : []).entries()) {
    const at = `rollout.dark.switches[${i}]`;
    if (!s || typeof s !== 'object') { bad.push(`${at} must be an object`); continue; }
    const keys = s.kind === 'd1' ? ['kind', 'binding', 'key', 'table', 'off'] : ['kind', 'binding', 'key', 'off'];
    for (const k of Object.keys(s)) if (!keys.includes(k)) bad.push(`${at}.${k} is not handled`);
    if (!['kv', 'd1'].includes(s.kind)) bad.push(`${at}.kind ${JSON.stringify(s.kind)}: kv or d1`);
    if (typeof s.key !== 'string' || !s.key) bad.push(`${at}.key must be a string`);
    if (s.table !== undefined && !IDENT.test(String(s.table))) bad.push(`${at}.table ${JSON.stringify(s.table)}`);
    if (!Array.isArray(s.off) || s.off.some(x => typeof x !== 'string')) bad.push(`${at}.off must be a list of strings`);
    const list = s.kind === 'd1' ? (toml || {}).d1_databases : (toml || {}).kv_namespaces;
    const b = (list || []).find(x => x.binding === s.binding);
    if (!b || !(s.kind === 'd1' ? b.database_id : b.id) || /TBD/.test(s.kind === 'd1' ? b.database_id : b.id)) bad.push(`${at}.binding ${JSON.stringify(s.binding)}: not a live ${s.kind} binding in wrangler.toml`);
  }
  return bad;
}
