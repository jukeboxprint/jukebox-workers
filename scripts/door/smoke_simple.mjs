// Smoke test for a kind passthrough Worker (jbx-claude-cache, jbx-desk-live): the request list in workers/<worker>/pipeline.json
// (smoke). No secrets: every request is one the Worker must refuse (no proxy header, a wrong one, a wrong path token),
// so it proves the release boots and refuses, and it is safe against live too (rollout.mjs runs the same list after
// 100%). The front door's smoke is scripts/door/smoke.mjs.
//   node scripts/door/smoke_simple.mjs --worker claude-cache [--env staging|live] [--host <origin>]
// Prints {"pass":n,"fail":m}; exit 1 on any failure.
import { worker, smokeList } from './worker.mjs';

const { WORKER, PIPE, KIND } = worker();
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (KIND !== 'passthrough') { console.error(`${WORKER} is kind ${KIND}: use scripts/door/smoke.mjs`); process.exit(2); }
const ENV = arg('--env') || 'staging';
const HOST = arg('--host') || PIPE.hosts[ENV];
if (!HOST) { console.error(`no host for env ${ENV}`); process.exit(2); }
if (!(PIPE.smoke || []).length) { console.error('pipeline.json has no smoke list'); process.exit(2); }
const res = await smokeList(HOST, PIPE.smoke, PIPE.rollout.http_timeout_s, ENV);   // ENV picks each check's by_env answer
for (const r of res) if (!r.ok) console.log('FAIL', r.name, JSON.stringify(r.got));
const pass = res.filter(r => r.ok).length, fail = res.length - pass;
console.log(JSON.stringify({ worker: WORKER, host: HOST, pass, fail }));
process.exit(fail ? 1 : 0);
