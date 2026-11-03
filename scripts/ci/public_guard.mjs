#!/usr/bin/env node
// Public guard: jukebox-workers is a PUBLIC repo. It must never hold a secret, a Cloudflare account / namespace / database
// id, an n8n workflow id, an email address, a private hostname or customer data (docs/PATTERN.md section 2).
// Scans every file git tracks (or the paths given) and exits 1 on any hit.
//   node scripts/ci/public_guard.mjs [paths...]
// A deliberate exception (e.g. a placeholder in a test) goes in .guard-allow, one exact string per line, with a reason
// after " # ". Keep it short: every line there is reviewed by Tyler.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['service account json', /"type"\s*:\s*"service_account"/],
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['openai key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['github token', /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['cloudflare id (32 hex)', /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/],
  ['uuid (D1 / Durable Object id)', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  // Reserved test domains (.invalid, example.com / .org) can never be a real address, so tests may use them.
  ['email address', /[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*\.invalid\b)(?!example\.(com|org)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['workers.dev account subdomain', /\.[a-z0-9-]+\.workers\.dev/],
  ['n8n instance host', /[a-z0-9-]+\.app\.n8n\.cloud/],
  // n8n workflow / data-table ids: 16 characters mixing upper case, lower case and digits.
  ['n8n id', /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{16}(?![A-Za-z0-9]))(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{16}/, f => !/package-lock\.json$/.test(f)],
];
const SKIP = [/^\.git\//, /(^|\/)node_modules\//, /\.(png|jpg|gif|ico|woff2?)$/];

const allow = new Set();
if (fs.existsSync(path.join(ROOT, '.guard-allow'))) {
  for (const l of fs.readFileSync(path.join(ROOT, '.guard-allow'), 'utf8').split('\n')) {
    const s = l.split(' # ')[0].trim();
    if (s && !s.startsWith('#')) allow.add(s);
  }
}
const files = process.argv.length > 2 ? process.argv.slice(2)
  : execFileSync('git', ['ls-files'], { cwd: ROOT }).toString().split('\n').filter(Boolean);
const hits = [];
for (const f of files) {
  if (SKIP.some(r => r.test(f)) || f === '.guard-allow') continue;
  let t;
  try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  t.split('\n').forEach((line, i) => {
    for (const [name, re, applies] of RULES) {
      if (applies && !applies(f)) continue;
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of line.matchAll(g)) {
        if (allow.has(m[0])) continue;
        hits.push({ file: f, line: i + 1, rule: name, match: m[0].length > 12 ? m[0].slice(0, 6) + '…' + m[0].slice(-4) : m[0] });
      }
    }
  });
}
for (const h of hits) console.log(JSON.stringify(h));
console.log(JSON.stringify({ ok: hits.length === 0, files: files.length, hits: hits.length }));
process.exit(hits.length ? 1 : 0);
