// The go-live label (docs/PATTERN.md section 5): may this push to main go on to live after staging?
// Tyler, 3 Nov 2026: "how do we get the runs going auto" - environment approvals need GitHub Enterprise on a private
// repo, so the approval is a label on the PR instead, still Tyler's own act. Yes only when ALL hold:
//   - the pushed commit is the merge commit of exactly one merged PR;
//   - the PR carries the label (repository variable GO_LIVE_LABEL) when merged;
//   - the label's last labeled/unlabeled event is "labeled", by a login in GO_LIVE_ACTORS (repository variable,
//     comma-separated), before the merge, and NOT made through an app (performed_via_github_app empty): Claude's
//     GitHub calls run as Tyler's login through the "claude" app, so this is what keeps the label Tyler's own click;
//   - the PR was merged by a login in GO_LIVE_ACTORS, and its "merged" event was not made through an app either.
// Missing variables = off (no). Anything unreadable = no. Hand-started Go live runs are unchanged.
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo GITHUB_SHA=… GO_LIVE_LABEL=go-live GO_LIVE_ACTORS=JBoxT \
//     node scripts/door/golive.mjs   (worker-deploy.yml runs it in the plan job, push runs only)
// Prints {"go":bool,"why":…,"pr":n}; writes go=true|false to $GITHUB_OUTPUT when set. Exit 0 either way (a "no" is
// not a failure: staging still deploys); exit 2 on missing GITHUB_* inputs.
import fs from 'node:fs';

const env = process.env;
const BASE = (env.GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const REPO = env.GITHUB_REPOSITORY, SHA = env.GITHUB_SHA, TOKEN = env.GITHUB_TOKEN;
if (!REPO || !SHA || !TOKEN) { console.error('golive: GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN are required'); process.exit(2); }
const LABEL = String(env.GO_LIVE_LABEL || '').trim();
const ACTORS = String(env.GO_LIVE_ACTORS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const out = (go, why, pr = null) => {
  console.log(JSON.stringify({ go, why, pr }));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `go=${go ? 'true' : 'false'}\n`);
  process.exit(0);
};
const api = async p => {
  const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
  if (r.status !== 200) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
};
const pages = async p => {
  const all = [];
  for (let n = 1; n <= 20; n++) { const a = await api(`${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${n}`); all.push(...a); if (a.length < 100) return all; }
  throw new Error(`${p}: more than 2000 rows`);
};
const human = e => !e.performed_via_github_app;
const ok = login => ACTORS.includes(String(login || '').toLowerCase());

try {
  if (!LABEL || !ACTORS.length) out(false, 'off: GO_LIVE_LABEL or GO_LIVE_ACTORS not set');
  const prs = (await api(`/repos/${REPO}/commits/${SHA}/pulls`)).filter(p => p.merged_at && p.merge_commit_sha === SHA);
  if (prs.length !== 1) out(false, `${prs.length} merged PRs have this merge commit`);
  const n = prs[0].number;
  const pr = await api(`/repos/${REPO}/pulls/${n}`);
  if (!(pr.labels || []).some(l => l.name === LABEL)) out(false, `no ${LABEL} label`, n);
  if (!ok(pr.merged_by && pr.merged_by.login)) out(false, `merged by ${pr.merged_by && pr.merged_by.login}, not in GO_LIVE_ACTORS`, n);
  const ev = await pages(`/repos/${REPO}/issues/${n}/events`);
  const lab = ev.filter(e => (e.event === 'labeled' || e.event === 'unlabeled') && e.label && e.label.name === LABEL).pop();
  if (!lab || lab.event !== 'labeled') out(false, `${LABEL} was removed`, n);
  if (!ok(lab.actor && lab.actor.login)) out(false, `${LABEL} added by ${lab.actor && lab.actor.login}, not in GO_LIVE_ACTORS`, n);
  if (!human(lab)) out(false, `${LABEL} added through the ${lab.performed_via_github_app.slug} app, not by hand`, n);
  if (Date.parse(lab.created_at) > Date.parse(pr.merged_at)) out(false, `${LABEL} added after the merge`, n);
  const merged = ev.filter(e => e.event === 'merged').pop();
  if (!merged || !human(merged)) out(false, `merge made through ${merged ? 'the ' + merged.performed_via_github_app.slug + ' app' : 'no merged event'}, not by hand`, n);
  out(true, `#${n}: ${LABEL} by ${lab.actor.login}, merged by ${pr.merged_by.login}`, n);
} catch (e) {
  out(false, 'unreadable: ' + String(e.message || e).slice(0, 200));
}
