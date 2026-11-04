// Sets a Worker's cron triggers to its wrangler.toml [triggers] crons after a deploy. `wrangler versions upload` /
// `versions deploy` (the gradual rollout) do not touch triggers, so without this a new cron would never run.
//   CLOUDFLARE_API_TOKEN=… node scripts/door/triggers.mjs --worker <folder under workers/> --env live|staging [--dry]
// Reads the Worker's schedules (GET /workers/scripts/<name>/schedules). Same as the toml: nothing to do. Different:
// `wrangler triggers deploy` (the toml's crons for that env; none = removes them), then reads them back and fails
// unless they now match. Crons are not versioned: a later rollback of the script keeps them, so a release that adds a
// cron ships its scheduled() handler in the same release (proof.mjs checks) and a rollback past it should also take the
// cron out by PR. Prints one JSON line; exit 1 on a failure, 2 on bad input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { worker, cronsFor, cronPlan } from './worker.mjs';

const { WORKER, WD } = worker();
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENV = arg('--env') || 'live';
const DRY = process.argv.includes('--dry');
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
const die = (m, c = 2) => { console.error('door triggers: ' + m); process.exit(c); };
if (ENV !== 'live' && !(toml.env && toml.env[ENV])) die(`unknown --env ${ENV}`);
const NAME = ENV === 'live' ? toml.name : toml.env[ENV].name;
if (ENV !== 'live' && (NAME === toml.name || !NAME.endsWith('-' + ENV))) die(`env ${ENV} names Worker ${NAME}: refused`);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN && !DRY) die('CLOUDFLARE_API_TOKEN not set');
const out = o => console.log(JSON.stringify(Object.assign({ env: ENV, worker: NAME }, o)));

const have = async () => {
  const r = await fetch(`${process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'}/accounts/${toml.account_id}/workers/scripts/${NAME}/schedules`,
    { headers: { authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`schedules: HTTP ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return ((j.result || {}).schedules || []).map(x => String(x.cron || '').trim()).filter(Boolean).sort();
};

const want = cronsFor(toml, ENV);
if (DRY) { out({ step: 'dry', want, run: `npx wrangler triggers deploy${ENV === 'live' ? '' : ' --env ' + ENV}` }); process.exit(0); }
try {
  const before = await have();
  if (cronPlan(want, before) === 'same') { out({ step: 'crons', ok: true, changed: false, crons: want }); process.exit(0); }
  const args = ['--no-install', 'wrangler', 'triggers', 'deploy', ...(ENV === 'live' ? [] : ['--env', ENV])];
  const env = Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' });
  // DOOR_WRANGLER: test hook (a fake wrangler, as rollout.mjs); unset in CI.
  const o = process.env.DOOR_WRANGLER
    ? execFileSync(process.execPath, [process.env.DOOR_WRANGLER, ...args.slice(2)], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npx', args, { cwd: WD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  process.stderr.write(o);
  const after = await have();
  if (cronPlan(want, after) !== 'same') { out({ step: 'crons', ok: false, before, after, want }); process.exit(1); }
  out({ step: 'crons', ok: true, changed: true, before, crons: after });
} catch (e) {
  out({ step: 'crons', ok: false, why: String(e && e.message || e).slice(0, 300), want });
  process.exit(1);
}
