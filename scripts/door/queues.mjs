// Sets a Worker's Queue consumers to its wrangler.toml [[queues.consumers]] after a deploy (v1.0.7). `wrangler versions
// upload` / `versions deploy` never set consumers (they are not version bindings), so without this a new consumer
// would never run. Modelled on triggers.mjs.
//   CLOUDFLARE_API_TOKEN=… node scripts/door/queues.mjs --worker <folder under workers/> --env live|staging [--dry|--count]
// --count prints how many consumers the toml sets for env (no token, no API call; the workflow skips the step on 0).
// No consumers in the toml: nothing is read or changed. Otherwise, for each consumer: the queue and its dead-letter
// queue must exist (GET /accounts/<a>/queues?name=…); the pipeline never creates a queue: a missing one fails, named,
// before anything changes ("create it in the dashboard or with wrangler queues create, on Tyler's word"). A queue held
// by another Worker (or an HTTP pull consumer) is refused. An answer not in the expected shape fails before anything
// changes. Same as the toml: nothing to do. Different: POST /queues/<id>/consumers (none yet) or PUT
// /queues/<id>/consumers/<consumer_id>, with the body wrangler 4.156 sends, then read back: fails unless they now match.
// A consumer the toml drops is not removed (`wrangler queues consumer remove`, by hand, on Tyler's word). Consumers are
// not versioned: a rollback of the script keeps them.
// Prints one JSON line; exit 1 on a failure, 2 on bad input.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { worker, consumersFor, queueConfigProblems, findQueue, consumerState, consumerDiff, consumerBody, QUEUE_MISSING } from './worker.mjs';

const { WD } = worker();
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENV = arg('--env') || 'live';
const DRY = process.argv.includes('--dry');
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
const die = (m, c = 2) => { console.error('door queues: ' + m); process.exit(c); };
if (ENV !== 'live' && !(toml.env && toml.env[ENV])) die(`unknown --env ${ENV}`);
const NAME = ENV === 'live' ? toml.name : toml.env[ENV].name;
if (ENV !== 'live' && (NAME === toml.name || !NAME.endsWith('-' + ENV))) die(`env ${ENV} names Worker ${NAME}: refused`);
const want = consumersFor(toml, ENV);
if (process.argv.includes('--count')) { console.log(String(want.length)); process.exit(0); }
const bad = queueConfigProblems(toml, ENV);
if (bad.length) die(bad.join('; '));
const out = o => console.log(JSON.stringify(Object.assign({ env: ENV, worker: NAME }, o)));
if (!want.length) { out({ step: 'consumers', ok: true, changed: false, consumers: [] }); process.exit(0); }
if (DRY) { out({ step: 'dry', want }); process.exit(0); }
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) die('CLOUDFLARE_API_TOKEN not set');

const call = async (p, method = 'GET', body) => {
  const r = await fetch(`${process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'}/accounts/${toml.account_id}${p}`, {
    method, headers: Object.assign({ authorization: 'Bearer ' + TOKEN }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`${method} ${p.split('?')[0]}: HTTP ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`);
  return j.result;
};

// Every consumer's queue, dead-letter queue and current state. Throws on a missing queue or an unexpected answer.
const read = async () => {
  const missing = [], rows = [];
  for (const w of want) {
    const q = await findQueue(call, w.queue);
    const dlq = w.dead_letter_queue ? await findQueue(call, w.dead_letter_queue) : null;
    if (!q) missing.push(w.queue);
    if (w.dead_letter_queue && !dlq) missing.push(w.dead_letter_queue);
    if (q) rows.push(Object.assign({ want: w, q }, consumerState(q, NAME, dlq)));
  }
  if (missing.length) throw new Error(missing.map(QUEUE_MISSING).join('; '));
  return rows;
};

try {
  const before = await read();
  const todo = before.filter(r => consumerDiff(r.want, r.mine).length);
  if (!todo.length) { out({ step: 'consumers', ok: true, changed: false, consumers: want }); process.exit(0); }
  for (const r of todo) {
    const b = consumerBody(r.want, NAME);
    if (r.mine) await call(`/queues/${r.q.queue_id}/consumers/${r.consumer_id}`, 'PUT', b);
    else await call(`/queues/${r.q.queue_id}/consumers`, 'POST', b);
  }
  const after = await read();
  const diffs = after.flatMap(r => consumerDiff(r.want, r.mine).map(d => `${r.want.queue}: ${d}`));
  const set = todo.map(r => ({ queue: r.want.queue, was: r.mine ? consumerDiff(r.want, r.mine) : 'none' }));
  if (diffs.length) { out({ step: 'consumers', ok: false, changed: true, set, why: diffs.join('; ').slice(0, 300), want }); process.exit(1); }
  out({ step: 'consumers', ok: true, changed: true, set, consumers: after.map(r => r.mine) });
} catch (e) {
  out({ step: 'consumers', ok: false, why: String(e && e.message || e).slice(0, 400), want });
  process.exit(1);
}
