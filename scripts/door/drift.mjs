// Reads a deployed Worker from the Cloudflare API and refuses (exit 1) when it differs from the repo.
//   CLOUDFLARE_API_TOKEN=… node scripts/door/drift.mjs [--worker <folder under workers/>] --env live|staging
//        [--known-shas <file>] [--prev-sha <sha256>]                     (default worker: front-door)
// Checks:
//   settings  compatibility date and flags, usage model equal workers/front-door/wrangler.toml; no placement or limits
//             (the toml sets neither, so a version upload would drop them: refused until the toml carries them);
//   bindings  every non-secret binding (KV ids, D1 id, plain vars) equal wrangler.toml for that env, none extra
//             (live: refused; staging: reported, since the upload sets them);
//   secrets   secret NAMES equal secrets.json (live: the list; staging: those not marked none);
//   script    (live) the deployed script is the release (a no-op deploy) or any release main ever named: --known-shas
//             is a file of sha256s, one per line (the workflow writes every sha256 in release.json's history), plus
//             --prev-sha. So a release merged but never approved, or one rolled back, doesn't block the next deploy.
//             Anything else means someone changed the Worker outside the pipeline (a paste): stop, find out why.
//             A new Worker's dashboard Hello World placeholder passes only while pipeline.json placeholder_live is true.
//   ids       staging ids must not be TBD placeholders.
//   durable objects (pipeline.json durable_objects; jbx-desk-live): each binding's class (and script) equal the toml
//             (compared with the other bindings); live's namespace id equal to pipeline.json's; the namespace
//             (GET /workers/durable_objects/namespaces) belongs to this Worker, runs that class and is SQLite-backed
//             as pipeline.json says; staging's namespace is never live's; the Worker's migration tag
//             (GET /workers/services/<name>) equals the toml's last [[migrations]] tag and pipeline.json's (a different
//             or missing tag makes `wrangler versions upload` refuse, or a full deploy re-run migrations). Service
//             bindings are compared like the others (binding + service name).
//   kind passthrough only (pipeline.json; jbx-claude-cache, jbx-desk-live), the non-versioned settings: no logpush, no tail
//   consumers, no cron (schedules), workers.dev and previews as the toml (subdomain). Live: refused; staging: noted.
//   Observability is dashboard-managed (the toml has none, so `wrangler versions deploy` leaves it alone: run 41325777020
//   showed its PATCH clearing it); live's is reported as a note only.
// Reads only (GET). Prints secret names, never values; the API never returns secret values.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'smol-toml';
import { worker, wantBindings, doBinding, lastMigrationTag } from './worker.mjs';

const { WD, KIND, PIPE } = worker();
// Fields a release sets on purpose (pipeline.json release_managed; jbx-claude-cache's capture switch, jbx-desk-live's jobs
// forward): a difference between live and the toml there is what the deploy is for, so it is noted, not refused.
// vars: plain-var names; services: service-binding names (the front door: SUGGEST, until v40 is live).
// kv: KV binding names (copilot-suggest v2 binds OUTBOX_KV over a live v1 that has none).
const MANAGED = Object.assign({ vars: [], services: [], kv: [] }, PIPE.release_managed || {});
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENV = arg('--env') || 'live';
const KNOWN = new Set([arg('--prev-sha'), ...(arg('--known-shas') ? fs.readFileSync(arg('--known-shas'), 'utf8').split(/\s+/) : [])]
  .filter(x => /^[0-9a-f]{64}$/.test(x || '')));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
const REL = JSON.parse(fs.readFileSync(path.join(WD, 'release.json'), 'utf8'));
const SEC = JSON.parse(fs.readFileSync(path.join(WD, 'secrets.json'), 'utf8'));
if (ENV !== 'live' && !(toml.env && toml.env[ENV])) { console.error(`unknown --env ${ENV}`); process.exit(2); }
const want = ENV === 'live' ? toml : Object.assign({}, toml, toml.env[ENV]);
const ACCT = toml.account_id;
const NAME = want.name;
if (ENV !== 'live' && (NAME === toml.name || !NAME.endsWith('-' + ENV))) { console.error(`env ${ENV} names Worker ${NAME}: refused`); process.exit(2); }
const problems = [];
const notes = [];
const PLACEHOLDER_LIVE = ENV === 'live' && PIPE.placeholder_live === true;
const deferred = [];

// Expected non-secret bindings from the toml (scripts/door/worker.mjs: KV, D1, vars, Durable Objects, services).
const expected = wantBindings(toml, ENV);
if (expected.some(e => /TBD/.test(e))) problems.push(`${ENV}: wrangler.toml still has TBD placeholder ids`);
const wantSecrets = ENV === 'live' ? SEC.live : Object.entries(SEC[ENV] || {}).filter(([, v]) => v !== 'none').map(([k]) => k);

if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN not set'); process.exit(2); }
const api = async (p, raw) => {
  const r = await fetch(`${process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'}/accounts/${ACCT}${p}`, { headers: { authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(20000) });
  if (raw) return { status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) };
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`GET ${p}: HTTP ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.result;
};

// pipeline.json durable_objects: namespace ids, class, storage and the migration tag (see the header).
async function durableObjects(bindings) {
  const D = PIPE.durable_objects;
  const mine = D[ENV] || {};
  const tag = lastMigrationTag(toml, ENV);
  if (tag !== String(D.migration_tag || '')) problems.push(`toml's last migration tag ${JSON.stringify(tag)} != pipeline.json's ${JSON.stringify(D.migration_tag)}`);
  const svc = await api(`/workers/services/${NAME}`);
  const liveTag = ((((svc || {}).default_environment || {}).script) || {}).migration_tag || '';
  if (liveTag !== tag) problems.push(`migration tag on ${ENV} is ${JSON.stringify(liveTag)}, toml ${JSON.stringify(tag)} (versions upload would refuse${ENV === 'live' ? '' : '; a new staging Worker needs the bootstrap run'})`);
  const nss = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api(`/workers/durable_objects/namespaces?page=${page}&per_page=100`);
    nss.push(...(r || []));
    if (!r || r.length < 100) break;
  }
  const liveIds = Object.values(D.live || {}).map(x => x.namespace_id).filter(Boolean);
  for (const [name, w] of Object.entries(mine)) {
    const b = bindings.find(x => x.type === 'durable_object_namespace' && x.name === name);
    if (!b) { problems.push(`Durable Object binding ${name} missing on ${ENV}`); continue; }
    if (b.class_name !== w.class) problems.push(`${name} on ${ENV} runs class ${b.class_name}, pipeline.json ${w.class}`);
    if (w.namespace_id && b.namespace_id !== w.namespace_id) problems.push(`${name} on ${ENV} is namespace ${b.namespace_id}, pipeline.json ${w.namespace_id} (a new namespace = every stored event and chat gone)`);
    if (ENV !== 'live' && liveIds.includes(b.namespace_id)) problems.push(`${name} on ${ENV} is live's namespace ${b.namespace_id}: refused`);
    const ns = nss.find(x => x.id === b.namespace_id);
    if (!ns) { problems.push(`namespace ${b.namespace_id} (${name}) not in the account's Durable Object namespaces`); continue; }
    if (ns.script !== NAME || ns.class !== w.class) problems.push(`namespace ${ns.id} is ${ns.script} / ${ns.class}, want ${NAME} / ${w.class}`);
    if (w.sqlite !== undefined && !!ns.use_sqlite !== !!w.sqlite) problems.push(`namespace ${ns.id} use_sqlite ${ns.use_sqlite}, pipeline.json ${w.sqlite}`);
  }
  for (const b of bindings) if (b.type === 'durable_object_namespace' && !mine[b.name]) problems.push(`Durable Object binding ${b.name} on ${ENV} not in pipeline.json`);
}

try {
  const s = await api(`/workers/scripts/${NAME}/settings`);
  // Staging takes the toml's date with the upload (a new placeholder Worker has today's date): noted, not refused. Live: refused.
  // A dashboard placeholder carries the date it was made on; with pipeline.json placeholder_live that waits for the script
  // check like the bindings (accepted only if live really is the placeholder; the first upload sets the toml date).
  if (s.compatibility_date !== want.compatibility_date) (ENV === 'live' ? (PLACEHOLDER_LIVE ? deferred : problems) : notes).push(`compatibility_date ${ENV} ${s.compatibility_date} != toml ${want.compatibility_date}${ENV === 'live' ? '' : ' (the deploy sets the toml date)'}`);
  const lf = JSON.stringify((s.compatibility_flags || []).slice().sort()), tf = JSON.stringify((want.compatibility_flags || []).slice().sort());
  // Flags as the date (jukebox-workers v1.0.0): staging takes the toml's with the upload (noted); live refuses, except a
  // dashboard placeholder while pipeline.json placeholder_live is true (a Hello World has [], the first upload sets them).
  if (lf !== tf) (ENV === 'live' ? (PLACEHOLDER_LIVE ? deferred : problems) : notes).push(`compatibility_flags ${ENV} ${lf} != toml ${tf}${ENV === 'live' ? '' : ' (the deploy sets the toml flags)'}`);
  if (s.usage_model && s.usage_model !== 'standard') problems.push(`usage_model ${s.usage_model}`);
  if ((s.tail_consumers || []).length) notes.push('tail consumers set on the live Worker (not in toml)');
  if (s.logpush) notes.push('logpush on (not in toml)');
  if (s.placement && s.placement.mode && s.placement.mode !== 'off' && !want.placement) problems.push(`placement ${JSON.stringify(s.placement)} on ${ENV} but not in toml (a version upload would drop it)`);
  if (s.limits && Object.keys(s.limits).length && !want.limits) problems.push(`limits ${JSON.stringify(s.limits)} on ${ENV} but not in toml (a version upload would drop them)`);
  const have = [], secrets = [];
  for (const b of s.bindings || []) {
    if (b.type === 'secret_text') secrets.push(b.name);
    else if (b.type === 'kv_namespace') have.push(`kv_namespace ${b.name} ${b.namespace_id}`);
    else if (b.type === 'd1') have.push(`d1 ${b.name} ${b.id || b.database_id}`);
    else if (b.type === 'plain_text') have.push(`plain_text ${b.name} ${b.text}`);
    else if (b.type === 'durable_object_namespace') have.push(doBinding(b.name, b.class_name, b.script_name, NAME));
    else if (b.type === 'service') have.push(`service ${b.name} ${b.service}`);
    else if (b.type === 'hyperdrive') have.push(`hyperdrive ${b.name} ${b.id}`);
    else have.push(`${b.type} ${b.name} (not handled by the pipeline)`);
  }
  // Live: any difference stops the deploy (the upload would change live's bindings). Staging: the upload sets them, so a
  // difference is reported, not refused (the placeholder Worker has none before the first deploy).
  // pipeline.json placeholder_live: on live these wait for the script check below (a Hello World placeholder has none of
  // the toml's bindings yet: the first upload sets them, as on staging); any other live script: refused as before.
  const bindingIssue = m => (ENV === 'live' ? (PLACEHOLDER_LIVE ? deferred : problems) : notes).push(m);
  const managedVar = e => MANAGED.vars.some(n => e.startsWith(`plain_text ${n} `)) || (MANAGED.services || []).some(n => e.startsWith(`service ${n} `))
    || (MANAGED.kv || []).some(n => e.startsWith(`kv_namespace ${n} `));
  for (const e of expected) if (!have.includes(e)) (managedVar(e) ? notes.push(`release sets ${e}`) : bindingIssue(`missing on ${ENV} or different: ${e}`));
  for (const h of have) if (!expected.includes(h) && !managedVar(h)) bindingIssue(`on ${ENV} but not in toml: ${h}`);
  for (const n of wantSecrets) if (!secrets.includes(n)) problems.push(`secret missing on ${ENV}: ${n}`);
  for (const n of secrets) if (!wantSecrets.includes(n)) problems.push(`secret on ${ENV} not in secrets.json: ${n}`);

  if (PIPE.durable_objects) await durableObjects(s.bindings || []);

  if (KIND === 'passthrough') {
    const ss = await api(`/workers/scripts/${NAME}/script-settings`);
    // Observability: dashboard-managed (see the header). A toml table would make `wrangler versions deploy` PATCH it.
    if (want.observability) problems.push('toml has [observability]: passthrough Workers leave it to the dashboard (run 41325777020)');
    const o = ss.observability || null;
    notes.push(`${ENV} observability (dashboard, not changed by a deploy): ${o ? `enabled ${!!o.enabled}, logs ${!!(o.logs && o.logs.enabled)}` : 'unset'}`);
    if (ss.logpush) bindingIssue(`logpush on ${ENV} (not in toml)`);
    if ((ss.tail_consumers || []).length) bindingIssue(`tail consumers on ${ENV} (not in toml)`);
    const sch = await api(`/workers/scripts/${NAME}/schedules`);
    if (((sch || {}).schedules || []).length) bindingIssue(`cron on ${ENV}: ${JSON.stringify(sch.schedules)} (not in toml)`);
    const sd = await api(`/workers/scripts/${NAME}/subdomain`);
    if (!!sd.enabled !== (want.workers_dev !== false) || !!sd.previews_enabled !== !!want.preview_urls) bindingIssue(`workers.dev ${sd.enabled}, previews ${sd.previews_enabled} on ${ENV}; toml ${want.workers_dev}, ${want.preview_urls}`);
  }

  // The deployed script. content/v2 returns the main module; older answers are multipart (strip the envelope).
  const c = await api(`/workers/scripts/${NAME}/content/v2`, true);
  if (c.status !== 200) throw new Error(`GET content/v2: HTTP ${c.status}`);
  let body = c.body;
  if (/multipart/i.test(c.type)) {
    const t = body.toString('latin1');
    body = Buffer.from(t.slice(t.indexOf('\r\n\r\n') + 4, t.lastIndexOf('\r\n--')), 'latin1');
  }
  const liveSha = crypto.createHash('sha256').update(body).digest('hex');
  let kind = liveSha === REL.sha256 ? 'release' : KNOWN.has(liveSha) ? 'previous' : 'other';
  // pipeline.json placeholder_live (a new Worker with no Durable Objects, so no bootstrap: copilot-suggest): before its
  // first live deploy the live script is Tyler's dashboard Hello World placeholder. Accepted (noted) only while the flag
  // is set and only when the script looks like one (under 4 KB, "Hello World"); remove the flag (PR) after that deploy.
  // Every other Worker has no flag: unchanged.
  if (kind === 'other' && ENV === 'live' && PIPE.placeholder_live === true && body.length < 4096 && /hello world/i.test(body.toString('utf8'))) {
    kind = 'placeholder';
    notes.push(`live script is the dashboard placeholder (${liveSha.slice(0, 12)}, ${body.length} bytes): accepted once (pipeline.json placeholder_live)`);
  }
  if (kind === 'placeholder') notes.push(...deferred.map(m => m + ' (placeholder: the first upload sets it)'));
  else problems.push(...deferred);
  // Live only: on staging the script before a deploy may be anything (Tyler creates it from the dashboard with its two
  // secrets before the first pipeline deploy; nobody pastes there), so it is reported, not refused.
  if (kind === 'other' && ENV !== 'live') notes.push(`staging script before this deploy: ${liveSha.slice(0, 12)} (not a release)`);
  else if (kind === 'other') problems.push(`deployed script ${liveSha.slice(0, 12)} (${body.length} bytes) is neither the release ${REL.sha256.slice(0, 12)} nor one of ${KNOWN.size} earlier releases`);
  const out = { ok: problems.length === 0, env: ENV, worker: NAME, deployed: { sha256: liveSha, bytes: body.length, is: kind }, release: REL.version, problems, notes };
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ ok: false, env: ENV, worker: NAME, problems: problems.concat(deferred, String(e.message || e)) }));
  process.exit(1);
}
