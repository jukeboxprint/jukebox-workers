#!/usr/bin/env node
// D1 for a Worker on this pipeline (from jukebox-inflow, 2 Nov 2026; scripts/door has no D1 step).
// wrangler.toml owns each database's name and id.
//   --ensure           find each database the toml names (live and staging) by exact name, create it if missing,
//                      print { env, binding, name, id, created } per database. A toml id that is TBD is reported
//                      ("write it by PR"); a toml id that differs from the database of that name is refused.
//                      Creating an empty database changes no Worker.
//   --migrate --env E  apply the toml's migrations (migrations_dir) to env E's databases, remotely
//                      (`wrangler d1 migrations apply`). Refused while the toml id is TBD.
//   CLOUDFLARE_API_TOKEN=… node scripts/worker/d1.mjs --worker <folder under workers/> (--ensure | --migrate --env E)
// Migrations must be additive (CREATE … IF NOT EXISTS, new columns): the old version keeps running on them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';

const ROOT = process.env.JBX_REPO_ROOT ? path.resolve(process.env.JBX_REPO_ROOT) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const W = arg('--worker');
if (!/^[a-z0-9][a-z0-9-]*$/.test(W || '')) { console.error('--worker <folder>'); process.exit(2); }
const WD = path.join(ROOT, 'workers', W);
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN not set'); process.exit(2); }
const ACCT = toml.account_id;
const dbs = env => (env === 'live' ? toml : (toml.env || {})[env] || {}).d1_databases || [];
const envs = ['live', ...Object.keys(toml.env || {})];
const api = async (p, init = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}${p}`, Object.assign({}, init,
    { headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000) }));
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${init.method || 'GET'} ${p}: HTTP ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.result;
};
const real = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '');
let bad = 0;

if (process.argv.includes('--ensure')) {
  for (const env of envs) for (const d of dbs(env)) {
    const found = (await api(`/d1/database?name=${encodeURIComponent(d.database_name)}&per_page=100`) || []).filter(x => x.name === d.database_name);
    let id = found[0] && found[0].uuid, created = false;
    if (!id) { id = (await api('/d1/database', { method: 'POST', body: JSON.stringify({ name: d.database_name }) })).uuid; created = true; }
    const row = { env, binding: d.binding, name: d.database_name, id, created };
    if (!real(d.database_id)) row.toml = 'TBD: write this id into wrangler.toml by PR';
    else if (d.database_id !== id) { row.toml = `REFUSED: toml says ${d.database_id}`; bad++; }
    else row.toml = 'ok';
    console.log(JSON.stringify(row));
  }
  const ids = envs.flatMap(e => dbs(e).map(d => d.database_id)).filter(real);
  if (new Set(ids).size !== ids.length) { console.log(JSON.stringify({ problem: 'two environments name the same database id' })); bad++; }
} else if (process.argv.includes('--migrate')) {
  const env = arg('--env');
  if (!envs.includes(env)) { console.error(`--env ${env}: not live or a toml env`); process.exit(2); }
  for (const d of dbs(env)) {
    if (!real(d.database_id)) { console.log(JSON.stringify({ env, binding: d.binding, problem: 'database_id is TBD (run the Worker D1 workflow, then write the id by PR)' })); bad++; continue; }
    if (!d.migrations_dir) { console.log(JSON.stringify({ env, binding: d.binding, migrations: 'none' })); continue; }
    const args = ['--no-install', 'wrangler', 'd1', 'migrations', 'apply', d.binding, '--remote'];
    if (env !== 'live') args.push('--env', env);
    execFileSync('npx', args, { cwd: WD, stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', CI: 'true' }) });
    console.log(JSON.stringify({ env, binding: d.binding, name: d.database_name, migrations: 'applied' }));
  }
} else { console.error('--ensure or --migrate --env <env>'); process.exit(2); }
process.exit(bad ? 1 : 0);
