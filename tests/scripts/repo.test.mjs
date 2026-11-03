// repo.mjs against throwaway caller repos built here (no fixture ids checked in: this repo is public).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../scripts/worker/repo.mjs');
const ACCT = 'a'.repeat(32);
const SHA = 'b'.repeat(40);

function caller(workers, workflows = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-caller-'));
  for (const [dir, t] of Object.entries(workers)) {
    const w = path.join(d, 'workers', dir); fs.mkdirSync(w, { recursive: true });
    fs.writeFileSync(path.join(w, 'wrangler.toml'), `name = "${t.name}"\naccount_id = "${t.acct || ACCT}"\n[env.staging]\nname = "${t.staging ?? t.name + '-staging'}"\n`);
    for (const f of ['release.json', 'secrets.json', 'pipeline.json']) if (!(t.missing || []).includes(f)) fs.writeFileSync(path.join(w, f), '{}');
  }
  const wf = path.join(d, '.github', 'workflows'); fs.mkdirSync(wf, { recursive: true });
  for (const [f, body] of Object.entries(workflows)) fs.writeFileSync(path.join(wf, f), body);
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}
const run = (root, args, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: Object.assign({}, process.env, { JBX_REPO_ROOT: root }, env) });
  return { code: r.status, out: r.stdout.toString().trim() };
};

test('check: a repo that follows the pattern', () => {
  const d = caller({ inflow: { name: 'jbx-inflow' }, 'inflow-jobs': { name: 'jbx-inflow-jobs' } });
  const r = run(d, ['check'], { REPO_NAME: 'jukeboxprint/jukebox-inflow' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out).workers.map(w => w.switch), ['INFLOW', 'INFLOW_JOBS']);
});
test('check: refuses another area\'s Worker, a wrong folder, a bad staging name, two accounts, a missing file', () => {
  const cases = [
    [{ inflow: { name: 'jbx-front-door' } }, 'not jbx-inflow'],
    [{ stuff: { name: 'jbx-inflow' } }, 'folder should be inflow'],
    [{ inflow: { name: 'jbx-inflow', staging: 'jbx-inflow-stg' } }, '-staging'],
    [{ inflow: { name: 'jbx-inflow' }, 'inflow-x': { name: 'jbx-inflow-x', acct: 'c'.repeat(32) } }, 'different account_ids'],
    [{ inflow: { name: 'jbx-inflow', missing: ['secrets.json'] } }, 'secrets.json missing'],
  ];
  for (const [w, why] of cases) {
    const r = run(caller(w), ['check'], { REPO_NAME: 'jukebox-inflow' });
    assert.equal(r.code, 1, why); assert.ok(r.out.includes(why), r.out);
  }
});
test('check: WORKER_NAME_EXCEPTIONS (admin-held) lets a listed name through, nothing else', () => {
  const d = caller({ 'front-door': { name: 'jbx-front-door' }, 'copilot-jobs': { name: 'copilot-jobs' } });
  assert.equal(run(d, ['check'], { REPO_NAME: 'jukebox-copilot' }).code, 1);
  assert.equal(run(d, ['check'], { REPO_NAME: 'jukebox-copilot', WORKER_NAME_EXCEPTIONS: 'jbx-front-door, copilot-jobs' }).code, 0);
  assert.equal(run(d, ['check'], { REPO_NAME: 'jukebox-copilot', WORKER_NAME_EXCEPTIONS: 'jbx-front-door' }).code, 1);
});
test('check: CF_ACCOUNT_ID, when set, must match', () => {
  const d = caller({ inflow: { name: 'jbx-inflow' } });
  assert.equal(run(d, ['check'], { REPO_NAME: 'jukebox-inflow', CF_ACCOUNT_ID: ACCT }).code, 0);
  assert.equal(run(d, ['check'], { REPO_NAME: 'jukebox-inflow', CF_ACCOUNT_ID: 'c'.repeat(32) }).code, 1);
});
test('switch, list', () => {
  const d = caller({ 'front-door': { name: 'x' }, inflow: { name: 'jbx-inflow' } });
  assert.equal(run(d, ['switch', 'front-door']).out, 'FRONT_DOOR');
  assert.deepEqual(JSON.parse(run(d, ['list']).out), ['front-door', 'inflow']);
  assert.equal(run(d, ['switch', '../x']).code, 2);
});
test('pins: one sha everywhere, pipeline_ref equal to it', () => {
  const u = n => `jobs:\n  x:\n    uses: jukeboxprint/jukebox-workers/.github/workflows/worker-${n}.yml@${SHA}  # v1.0.0\n    with:\n      pipeline_ref: ${SHA}\n`;
  assert.equal(run(caller({}, { 'ci.yml': u('ci'), 'deploy.yml': u('deploy') }), ['pins']).code, 0);
  assert.equal(run(caller({}, { 'ci.yml': u('ci').replace(`pipeline_ref: ${SHA}`, 'pipeline_ref: ' + 'c'.repeat(40)) }), ['pins']).code, 1);
  assert.equal(run(caller({}, { 'ci.yml': u('ci'), 'deploy.yml': u('deploy').replace(`@${SHA}`, '@' + 'c'.repeat(40)) }), ['pins']).code, 1);
  assert.equal(run(caller({}, { 'ci.yml': u('ci').replace(`@${SHA}`, '@v1.0.0') }), ['pins']).code, 1);
  assert.equal(run(caller({}, {}), ['pins']).code, 1);
});
test('changed: only folders whose release.json or wrangler.toml changed', () => {
  const d = caller({ inflow: { name: 'jbx-inflow' }, 'inflow-jobs': { name: 'jbx-inflow-jobs' } });
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...a], { cwd: d }).toString().trim();
  g('add', '-A'); g('commit', '-qm', 'one'); const a = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'workers/inflow/release.json'), '{"version":"v2"}');
  fs.writeFileSync(path.join(d, 'workers/inflow-jobs/README.md'), 'x');
  g('add', '-A'); g('commit', '-qm', 'two'); const b = g('rev-parse', 'HEAD');
  assert.deepEqual(JSON.parse(run(d, ['changed', a, b]).out), ['inflow']);
});
