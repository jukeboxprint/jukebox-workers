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
