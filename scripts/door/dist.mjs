// Puts a Worker's release into workers/<worker>/dist/worker.js, the file wrangler uploads.
//   node scripts/door/dist.mjs [--worker <folder under workers/>] [--check]   (default worker: front-door)
//   --check: check only (dist must already hold the release)
// Refuses unless the source named in workers/<worker>/release.json, with its final newline stripped when release.json
// says strip_final_newline (the live script never ends in one), has exactly the sha256 and byte count written there.
// wrangler runs with no_bundle, so the uploaded module is this file unchanged (proved by scripts/door/proof.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, worker } from './worker.mjs';

const { WD } = worker();
const REL = JSON.parse(fs.readFileSync(path.join(WD, 'release.json'), 'utf8'));
const DIST = path.join(WD, 'dist/worker.js');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const die = m => { console.error('door dist: ' + m); process.exit(1); };

let src = fs.readFileSync(path.join(ROOT, REL.source));
if (REL.strip_final_newline && src[src.length - 1] === 0x0a) src = src.subarray(0, src.length - 1);
if (src.length !== REL.bytes) die(`${REL.source} is ${src.length} bytes, release.json says ${REL.bytes}`);
if (sha(src) !== REL.sha256) die(`${REL.source} sha256 ${sha(src)} is not release.json's ${REL.sha256}`);
if (src[src.length - 1] === 0x0a) die('source ends with a newline; the live script never has one');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(DIST)) die('dist/worker.js missing');
  const d = fs.readFileSync(DIST);
  if (sha(d) !== REL.sha256) die(`dist/worker.js sha256 ${sha(d)} is not the release`);
} else {
  fs.mkdirSync(path.dirname(DIST), { recursive: true });
  fs.writeFileSync(DIST, src);
}
console.log(JSON.stringify({ ok: true, version: REL.version, sha256: REL.sha256, bytes: REL.bytes }));
