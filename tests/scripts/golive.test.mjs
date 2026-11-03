// scripts/door/golive.mjs against a fake GitHub API: only Tyler's own label and merge (not through an app) say go.
// From jukebox-copilot tests/door-golive/golive_test.mjs (3 Nov 2026), same 15 cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../scripts/door/golive.mjs');
const SHA = 'abc123';
let S;
const base = () => ({
  pulls: [{ number: 7, merged_at: '2026-11-03T18:00:00Z', merge_commit_sha: SHA }],
  pr: { number: 7, merged_at: '2026-11-03T18:00:00Z', labels: [{ name: 'go-live' }], merged_by: { login: 'JBoxT' } },
  events: [
    { event: 'labeled', label: { name: 'go-live' }, actor: { login: 'JBoxT' }, created_at: '2026-11-03T17:59:00Z', performed_via_github_app: null },
    { event: 'merged', actor: { login: 'JBoxT' }, created_at: '2026-11-03T18:00:00Z', performed_via_github_app: null },
  ],
  status: 200,
});
const api = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (b, st = S.status) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (u.pathname === `/repos/o/r/commits/${SHA}/pulls`) return send(S.pulls);
  if (u.pathname === '/repos/o/r/pulls/7') return send(S.pr);
  if (u.pathname === '/repos/o/r/issues/7/events') return send(u.searchParams.get('page') === '1' ? S.events : []);
  send({ message: 'not found' }, 404);
});
before(() => new Promise(r => api.listen(0, '127.0.0.1', r)));
after(() => api.close());
const run = (extra = {}) => new Promise(resolve => {
  const p = spawn(process.execPath, [SCRIPT], { env: Object.assign({}, process.env, {
    GH_API_BASE: `http://127.0.0.1:${api.address().port}`, GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: SHA, GITHUB_TOKEN: 't',
    GO_LIVE_LABEL: 'go-live', GO_LIVE_ACTORS: 'JBoxT', GITHUB_OUTPUT: '' }, extra) });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.on('close', code => { let j = {}; try { j = JSON.parse(out.trim().split('\n').pop()); } catch (e) {} resolve({ code, j, out }); });
});
const no = async (setup, extra, re) => {
  S = base(); setup(S); const r = await run(extra);
  assert.equal(r.j.go, false, JSON.stringify(r.j)); if (re) assert.match(r.j.why, re);
  return r;
};

test("Tyler's label and merge, by hand: go", async () => {
  S = base(); const r = await run();
  assert.equal(r.code, 0); assert.equal(r.j.go, true); assert.equal(r.j.pr, 7);
});
test('GO_LIVE_ACTORS not set: off', () => no(() => {}, { GO_LIVE_ACTORS: '' }, /off/));
test('GO_LIVE_LABEL not set: off', () => no(() => {}, { GO_LIVE_LABEL: '' }, /off/));
test('no label: no', () => no(s => { s.pr.labels = []; }, {}, /no go-live label/));
test("label added through Claude's app (as Tyler's login): no", () =>
  no(s => { s.events[0].performed_via_github_app = { slug: 'claude' }; }, {}, /through the claude app/));
test("merged through Claude's app: no", () =>
  no(s => { s.events[1].performed_via_github_app = { slug: 'claude' }; }, {}, /merge made through the claude app/));
test('label by someone else: no', () => no(s => { s.events[0].actor.login = 'someone'; }, {}, /added by someone/));
test('merged by someone else: no', () => no(s => { s.pr.merged_by.login = 'someone'; }, {}, /merged by someone/));
test('label added then removed: no', () => no(s => {
  s.events.splice(1, 0, { event: 'unlabeled', label: { name: 'go-live' }, actor: { login: 'JBoxT' }, created_at: '2026-11-03T17:59:30Z', performed_via_github_app: null });
}, {}, /removed/));
test('label added after the merge: no', () => no(s => { s.events[0].created_at = '2026-11-03T18:05:00Z'; }, {}, /after the merge/));
test('a direct push (no PR): no', () => no(s => { s.pulls = []; }, {}, /0 merged PRs/));
test('the commit is not the merge commit (a PR commit merged by rebase elsewhere): no', () =>
  no(s => { s.pulls[0].merge_commit_sha = 'other'; }, {}));
test('API error: no, and not a failure', async () => {
  const r = await no(s => { s.status = 500; }, {}, /unreadable/);
  assert.equal(r.code, 0);
});
test('actor list: trimmed, case-insensitive', async () => {
  S = base(); const r = await run({ GO_LIVE_ACTORS: ' jboxt , other ' });
  assert.equal(r.j.go, true, JSON.stringify(r.j));
});
test('missing GITHUB_SHA: exit 2', async () => {
  S = base(); const r = await run({ GITHUB_SHA: '' });
  assert.equal(r.code, 2);
});
