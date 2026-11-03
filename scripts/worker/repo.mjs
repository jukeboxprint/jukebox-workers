#!/usr/bin/env node
// What a caller repo holds, and whether it follows docs/PATTERN.md (sections 3-5). Run by the reusable workflows with
// JBX_REPO_ROOT = the caller's checkout. Replaces the three repo-variable checkers the first repos carried.
//
//   repo.mjs check                    every workers/<dir>/ follows the rules below; prints { ok, workers: [...] }
//   repo.mjs list                     JSON array of Worker folders (for a matrix)
//   repo.mjs changed <base> <head>    JSON array of folders whose release.json or wrangler.toml changed (push runs)
//   repo.mjs switch <dir>             the repo-variable prefix for that Worker: front-door -> FRONT_DOOR
//   repo.mjs pins                     the jukebox-workers ref every caller workflow pins; all must be the same sha,
//                                     and each pipeline_ref input must equal it. Prints { ok, ref }
//
// Rules for each workers/<dir>/:
//   - wrangler.toml, release.json, secrets.json, pipeline.json exist.
//   - name is jbx-<area> or jbx-<area>-<role> (area = repo name without "jukebox-"), and the folder is the name
//     without "jbx-"; or the name is listed in WORKER_NAME_EXCEPTIONS (repository variable, comma list: only an admin
//     can widen it, so a PR cannot point a repo's token at another repo's Worker).
//   - [env.staging] name = name + "-staging".
//   - every toml in the repo names the same account_id (and CF_ACCOUNT_ID, when that variable is set).
// Env: JBX_REPO_ROOT (default cwd), REPO_NAME (owner/repo or repo; default GITHUB_REPOSITORY), WORKER_NAME_EXCEPTIONS,
// CF_ACCOUNT_ID.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';

const ROOT = path.resolve(process.env.JBX_REPO_ROOT || process.cwd());
const [cmd, a1, a2] = process.argv.slice(2);
const DIR_RE = /^[a-z0-9][a-z0-9-]*$/;
const out = o => console.log(JSON.stringify(o));
const fail = (o, code = 1) => { out(Object.assign({ ok: false }, o)); process.exit(code); };

const workerDirs = () => {
  const w = path.join(ROOT, 'workers');
  if (!fs.existsSync(w)) return [];
  return fs.readdirSync(w).filter(d => DIR_RE.test(d) && fs.existsSync(path.join(w, d, 'wrangler.toml'))).sort();
};

if (cmd === 'list') { out(workerDirs()); process.exit(0); }

if (cmd === 'switch') {
  if (!DIR_RE.test(a1 || '')) fail({ problem: 'switch <dir>' }, 2);
  console.log(a1.toUpperCase().replace(/-/g, '_'));
  process.exit(0);
}

if (cmd === 'changed') {
  if (!a1 || !a2) fail({ problem: 'changed <base> <head>' }, 2);
  let names = [];
  const zero = /^0+$/.test(a1);
  try {
    names = execFileSync('git', zero ? ['show', '--name-only', '--format=', a2] : ['diff', '--name-only', a1, a2], { cwd: ROOT }).toString().split('\n');
  } catch (e) { fail({ problem: 'git diff failed: ' + String(e.message || e).slice(0, 120) }); }
  const dirs = new Set();
  for (const n of names) { const m = /^workers\/([a-z0-9][a-z0-9-]*)\/(release\.json|wrangler\.toml)$/.exec(n); if (m && workerDirs().includes(m[1])) dirs.add(m[1]); }
  out([...dirs].sort());
  process.exit(0);
}

if (cmd === 'pins') {
  const wf = path.join(ROOT, '.github', 'workflows');
  const refs = new Set(), inputs = new Set(), bad = [];
  for (const f of fs.existsSync(wf) ? fs.readdirSync(wf).filter(f => /\.ya?ml$/.test(f)) : []) {
    const t = fs.readFileSync(path.join(wf, f), 'utf8');
    for (const m of t.matchAll(/uses:\s*jukeboxprint\/jukebox-workers\/\.github\/workflows\/[A-Za-z0-9_.-]+@([^\s#]+)/g)) {
      if (!/^[0-9a-f]{40}$/.test(m[1])) bad.push(`${f}: pin ${m[1]} is not a commit sha (pin the sha, tag in a comment)`);
      refs.add(m[1]);
    }
    for (const m of t.matchAll(/pipeline_ref:\s*['"]?([^\s'"#]+)/g)) inputs.add(m[1]);
  }
  if (refs.size > 1) bad.push('workflows pin different jukebox-workers commits: ' + [...refs].join(', '));
  const ref = [...refs][0] || '';
  for (const i of inputs) if (i !== ref) bad.push(`pipeline_ref ${i} != the pinned ${ref}`);
  if (!ref) bad.push('no workflow calls jukebox-workers');
  if (bad.length) fail({ problems: bad });
  out({ ok: true, ref });
  process.exit(0);
}

if (cmd === 'check') {
  const repo = String(process.env.REPO_NAME || process.env.GITHUB_REPOSITORY || '').split('/').pop();
  const area = repo.startsWith('jukebox-') ? repo.slice('jukebox-'.length) : '';
  const exceptions = String(process.env.WORKER_NAME_EXCEPTIONS || '').split(/[\s,]+/).filter(Boolean);
  const problems = [], workers = [], accounts = new Set();
  if (!area) problems.push(`repo name ${repo || '(unknown)'} is not jukebox-<area>`);
  const dirs = workerDirs();
  if (!dirs.length) problems.push('no workers/<dir>/wrangler.toml');
  for (const d of dirs) {
    const W = path.join(ROOT, 'workers', d);
    for (const f of ['release.json', 'secrets.json', 'pipeline.json']) if (!fs.existsSync(path.join(W, f))) problems.push(`workers/${d}/${f} missing`);
    let t;
    try { t = parse(fs.readFileSync(path.join(W, 'wrangler.toml'), 'utf8')); } catch (e) { problems.push(`workers/${d}/wrangler.toml: ${String(e.message || e).split('\n')[0]}`); continue; }
    const name = String(t.name || '');
    const stagingName = String(((t.env || {}).staging || {}).name || '');
    const isException = exceptions.includes(name);
    const nameOk = area && new RegExp(`^jbx-${area.replace(/[^a-z0-9-]/g, '')}(-[a-z0-9]+)*$`).test(name);
    if (!isException && !nameOk) problems.push(`workers/${d}: name ${name} is not jbx-${area}[-<role>] and not in WORKER_NAME_EXCEPTIONS`);
    if (!isException && nameOk && d !== name.slice(4)) problems.push(`workers/${d}: folder should be ${name.slice(4)} (the name without jbx-)`);
    if (stagingName !== name + '-staging') problems.push(`workers/${d}: [env.staging] name ${stagingName || '(none)'} != ${name}-staging`);
    if (t.account_id) accounts.add(String(t.account_id)); else problems.push(`workers/${d}: no account_id`);
    workers.push({ dir: d, name, staging: stagingName, switch: d.toUpperCase().replace(/-/g, '_'), exception: isException || undefined });
  }
  if (accounts.size > 1) problems.push('the tomls name different account_ids');
  if (process.env.CF_ACCOUNT_ID && accounts.size === 1 && !accounts.has(process.env.CF_ACCOUNT_ID)) problems.push('account_id != repository variable CF_ACCOUNT_ID');
  if (problems.length) fail({ area, problems, workers });
  out({ ok: true, area, workers });
  process.exit(0);
}

fail({ problem: 'usage: repo.mjs check | list | changed <base> <head> | switch <dir> | pins' }, 2);
