// scripts/door/proof.mjs with the pinned wrangler (offline: --dry-run only). A Worker with no queues proves with the
// same checks as v1.0.6; a queue producer is in the upload form as `queue <binding> <queue>` and must equal the toml;
// queue settings the pipeline does not handle are refused (v1.0.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO, 'scripts/door/proof.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-'));
const WD = path.join(dir, 'workers/x');
fs.mkdirSync(path.join(WD, 'src'), { recursive: true });
// npx --no-install finds wrangler from the Worker's folder up, as in a caller's checkout.
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
const BASE = 'name = "jbx-x"\naccount_id = "acct"\nmain = "dist/worker.js"\ncompatibility_date = "2026-10-01"\ncompatibility_flags = []\n'
  + 'no_bundle = true\nfind_additional_modules = false\nworkers_dev = true\npreview_urls = false\n\n[vars]\nA = "1"\n\n';
const STAGING = '[env.staging]\nname = "jbx-x-staging"\nworkers_dev = true\npreview_urls = false\n\n[env.staging.vars]\nA = "1"\n\n';
const QUEUES = '[[queues.consumers]]\nqueue = "rows"\nmax_batch_size = 100\nmax_batch_timeout = 5\nmax_retries = 8\ndead_letter_queue = "rows-dlq"\n\n'
  + '[[queues.producers]]\nbinding = "BQ_DLQ"\nqueue = "rows-dlq"\n\n';
const SQUEUES = '[[env.staging.queues.consumers]]\nqueue = "rows-staging"\nmax_batch_size = 100\nmax_batch_timeout = 5\nmax_retries = 8\n'
  + 'dead_letter_queue = "rows-dlq-staging"\n\n[[env.staging.queues.producers]]\nbinding = "BQ_DLQ"\nqueue = "rows-dlq-staging"\n\n';
const WITH_QUEUE = 'export default { async fetch() { return new Response("x"); }, async queue(batch) { batch.retryAll(); } };';
const NO_QUEUE = 'export default { async fetch() { return new Response("x"); } };';
fs.writeFileSync(path.join(WD, 'pipeline.json'), JSON.stringify({ kind: 'passthrough', size: { max_bytes: 100000, max_gzip_bytes: 50000, max_growth_pct: 50 } }));
const setup = (toml, src) => {
  fs.writeFileSync(path.join(WD, 'wrangler.toml'), toml);
  fs.writeFileSync(path.join(WD, 'src/worker.js'), src);
  fs.writeFileSync(path.join(WD, 'release.json'), JSON.stringify({ version: 'v1', source: 'workers/x/src/worker.js',
    sha256: crypto.createHash('sha256').update(src).digest('hex'), bytes: Buffer.byteLength(src) }));
};
const proof = () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--worker', 'x'], { encoding: 'utf8', env: Object.assign({}, process.env, {
    JBX_REPO_ROOT: dir, WRANGLER_SEND_METRICS: 'false' }) });
  return { code: r.status, j: JSON.parse(r.stdout.trim().split('\n').pop() || '{}'), err: r.stderr };
};

test('no queues: the v1.0.6 checks, all ok, no queue check', () => {
  setup(BASE + STAGING, NO_QUEUE);
  const r = proof();
  assert.equal(r.code, 0, JSON.stringify(r.j) + r.err);
  assert.deepEqual(Object.keys(r.j.checks), ['source', 'upload_live', 'upload_staging', 'settings_live', 'settings_staging', 'size']);
});
test('queues: producer in the upload form as the toml, consumers checked, per env', () => {
  setup(BASE + QUEUES + STAGING + SQUEUES, WITH_QUEUE);
  const r = proof();
  assert.equal(r.code, 0, JSON.stringify(r.j) + r.err);
  for (const k of ['upload_live', 'upload_staging', 'queues_live', 'queues_staging']) assert.equal(r.j.checks[k], 'ok', k);
});
test('a producer the env does not declare is not inherited (staging without its own has none)', () => {
  setup(BASE + QUEUES + STAGING, WITH_QUEUE);
  const r = proof();
  assert.equal(r.code, 0, JSON.stringify(r.j) + r.err);
  assert.equal(r.j.checks.queues_staging, undefined);
});
test('consumers without a queue() handler, a key the pipeline does not handle, staging on a live queue: refused', () => {
  setup(BASE + QUEUES + STAGING + SQUEUES, NO_QUEUE);
  assert.match(proof().j.checks.queues_live, /no queue\(\) handler/);
  setup(BASE + QUEUES.replace('max_retries = 8\n', 'max_retries = 8\nmax_concurrency = 1\n') + STAGING + SQUEUES, WITH_QUEUE);
  assert.match(proof().j.checks.queues_live, /max_concurrency is not handled/);
  setup(BASE + QUEUES + STAGING + SQUEUES.replace('queue = "rows-dlq-staging"\n\n', 'queue = "rows-dlq"\n\n'), WITH_QUEUE);
  const r = proof();
  assert.equal(r.code, 1); assert.match(r.j.checks.queues_staging, /names live's queue rows-dlq/);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
