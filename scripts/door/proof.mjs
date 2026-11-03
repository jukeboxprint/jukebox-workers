// Proves a Worker's release before anything deploys. No Cloudflare account or token needed.
//   node scripts/door/proof.mjs [--worker <folder under workers/>] [--base <git-ref>]   (default worker: front-door)
//   1. build proof (front door, kind door): the release's build_vNN.mjs, run on its previous version, makes the release
//      byte for byte (and the build itself proves vNN minus its changes = vNN-1). kind passthrough: the release is its
//      source file (dist.mjs checks sha256 and bytes), so this check is "source"; with release.json build
//      (copilot-suggest) the build script, run now, must make that file byte for byte, so this check is "build";
//   2. upload proof, live and staging: `wrangler deploy --dry-run` uploads exactly one module, worker.js, equal to the
//      release (no bundling, nothing added); and the form `wrangler versions upload --dry-run --outfile` would send
//      (what the pipeline really sends) has main module worker.js, the release bytes, exactly the toml's bindings,
//      keep_bindings = secrets only, the toml's compatibility date, and no placement, limits or tail consumers;
//   3. size: bytes and gzip bytes under pipeline.json's limits, and growth against --base's release (if given)
//      under max_growth_pct.
//   4. settings (kind passthrough, live and staging): the non-versioned settings `wrangler versions deploy` patches
//      after the upload (observability, logpush, tail consumers), as wrangler itself reads them from the toml: no
//      observability (dashboard-managed: run 41325777020 showed a PATCH from the toml clearing live's), no logpush, no
//      tail consumers; plus workers_dev on, preview_urls as pipeline.json and no triggers / placement / limits. The front
//      door's toml sets none of these, so its upload form check ("no observability") is unchanged.
// Prints one JSON line; exit 1 on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { ROOT, HERE, worker, envConfig, wantBindings as bindingsFor, doBinding, lastMigrationTag } from './worker.mjs';

const { WORKER, WD, PIPE: CFG, KIND } = worker();
const REL = JSON.parse(fs.readFileSync(path.join(WD, 'release.json'), 'utf8'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const out = { ok: true, version: REL.version, checks: {} };
if (WORKER !== 'front-door') out.worker = WORKER;
const fail = (k, m) => { out.ok = false; out.checks[k] = 'FAIL: ' + m; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'door-proof-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const toml = parse(fs.readFileSync(path.join(WD, 'wrangler.toml'), 'utf8'));
// The bindings a version for `env` must carry, in drift.mjs's form.
const wantBindings = env => bindingsFor(toml, env);
// Parts of a multipart form file: { name: Buffer }.
const formParts = buf => {
  const t = buf.toString('latin1');
  const boundary = t.slice(0, t.indexOf('\r\n'));
  const parts = {};
  for (const chunk of t.split(boundary).slice(1, -1)) {
    const head = chunk.slice(2, chunk.indexOf('\r\n\r\n'));
    const name = (head.match(/name="([^"]+)"/) || [])[1];
    if (name) parts[name] = Buffer.from(chunk.slice(chunk.indexOf('\r\n\r\n') + 4, -2), 'latin1');
  }
  return parts;
};
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

// 0. dist
execFileSync(process.execPath, [path.join(HERE, 'dist.mjs'), '--worker', WORKER], { stdio: 'pipe' });
const rel = fs.readFileSync(path.join(WD, 'dist/worker.js'));

// 1. build proof (kind door). kind passthrough: the release is its source file, checked by dist.mjs above. A passthrough
// release with a build (release.json build.script; copilot-suggest: TypeScript bundled into one module) must also be
// what that script makes from source today, byte for byte (minus the final newline when strip_final_newline).
if (KIND === 'passthrough' && !REL.build) out.checks.source = 'ok';
else if (KIND === 'passthrough') try {
  const o = path.join(tmp, 'rebuilt.js');
  execFileSync(process.execPath, [path.join(ROOT, REL.build.script), '--out', o], { stdio: 'pipe' });
  let b = fs.readFileSync(o);
  if (REL.strip_final_newline && b[b.length - 1] === 0x0a) b = b.subarray(0, b.length - 1);
  if (sha(b) !== REL.sha256) throw new Error(`rebuilt from source ${sha(b).slice(0, 12)} != release ${REL.sha256.slice(0, 12)} (run ${REL.build.script} --release)`);
  out.checks.build = 'ok';
} catch (e) { fail('build', String(e.stderr || e.message || e).split('\n').filter(Boolean)[0]); }
else try {
  const from = fs.readFileSync(path.join(ROOT, REL.build.from));
  if (sha(from) !== REL.build.from_sha256) throw new Error(`${REL.build.from} is not ${REL.build.from_sha256.slice(0, 12)}`);
  const o = path.join(tmp, 'rebuilt.js');
  execFileSync(process.execPath, [path.join(ROOT, REL.build.script), path.join(ROOT, REL.build.from), '--out', o], { stdio: 'pipe' });
  const b = fs.readFileSync(o);
  if (sha(b) !== REL.sha256) throw new Error(`rebuilt ${sha(b).slice(0, 12)} != release ${REL.sha256.slice(0, 12)}`);
  out.checks.build = 'ok';
} catch (e) { fail('build', String(e.message || e).split('\n')[0]); }

// 2. upload proof (live and staging)
for (const env of ['live', 'staging']) {
  try {
    const od = path.join(tmp, 'out-' + env);
    const args = ['wrangler', 'deploy', '--dry-run', '--outdir', od];
    if (env !== 'live') args.push('--env', env);
    execFileSync('npx', ['--no-install', ...args], { cwd: WD, stdio: 'pipe', env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }) });
    const files = fs.readdirSync(od).filter(f => f !== 'README.md');
    if (files.length !== 1 || files[0] !== 'worker.js') throw new Error('uploaded modules: ' + files.join(','));
    const w = fs.readFileSync(path.join(od, 'worker.js'));
    if (sha(w) !== REL.sha256) throw new Error(`uploaded worker.js ${sha(w).slice(0, 12)} != release`);
    const ff = path.join(tmp, 'form-' + env);
    const vargs = ['wrangler', 'versions', 'upload', '--dry-run', '--outfile', ff];
    if (env !== 'live') vargs.push('--env', env);
    execFileSync('npx', ['--no-install', ...vargs], { cwd: WD, stdio: 'pipe', env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }) });
    const parts = formParts(fs.readFileSync(ff));
    const meta = JSON.parse(parts.metadata.toString('utf8'));
    if (meta.main_module !== 'worker.js') throw new Error('form main_module ' + meta.main_module);
    if (!parts['worker.js'] || sha(parts['worker.js']) !== REL.sha256) throw new Error('form worker.js is not the release');
    const modules = Object.keys(parts).filter(k => k !== 'metadata');
    if (modules.length !== 1) throw new Error('form modules: ' + modules.join(','));
    const want = envConfig(toml, env);
    if (meta.compatibility_date !== want.compatibility_date) throw new Error('form compatibility_date ' + meta.compatibility_date);
    if (JSON.stringify(meta.compatibility_flags || []) !== JSON.stringify(want.compatibility_flags || [])) throw new Error('form flags');
    if (JSON.stringify((meta.keep_bindings || []).slice().sort()) !== JSON.stringify(['secret_key', 'secret_text'])) throw new Error('form keep_bindings ' + JSON.stringify(meta.keep_bindings));
    for (const k of ['placement', 'limits', 'tail_consumers', 'observability', 'logpush']) {
      const v = meta[k];
      if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Object.keys(v).length)) throw new Error(`form sets ${k}: ${JSON.stringify(v)}`);
    }
    if (meta.migrations !== undefined) throw new Error('form carries migrations ' + JSON.stringify(meta.migrations));
    const got = (meta.bindings || []).map(b => b.type === 'kv_namespace' ? `kv_namespace ${b.name} ${b.namespace_id}`
      : b.type === 'd1' ? `d1 ${b.name} ${b.id || b.database_id}` : b.type === 'plain_text' ? `plain_text ${b.name} ${b.text}`
      : b.type === 'durable_object_namespace' ? doBinding(b.name, b.class_name, b.script_name, want.name)
      : b.type === 'service' ? `service ${b.name} ${b.service}` : b.type === 'hyperdrive' ? `hyperdrive ${b.name} ${b.id}` : `${b.type} ${b.name}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(wantBindings(env))) throw new Error('form bindings ' + JSON.stringify(got));
    out.checks['upload_' + env] = 'ok';
  } catch (e) { fail('upload_' + env, String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-1)[0]); }
}

// 4. settings (kind passthrough): what `wrangler versions deploy` will patch, as wrangler reads the toml.
if (KIND === 'passthrough') {
  const { unstable_readConfig } = await import('wrangler');
  for (const env of ['live', 'staging']) {
    try {
      const c = unstable_readConfig({ config: path.join(WD, 'wrangler.toml'), env: env === 'live' ? undefined : env });
      const want = envConfig(toml, env);
      const bad = [];
      if (c.name !== want.name) bad.push('name ' + c.name);
      // Observability is dashboard-managed: with none in the toml, `wrangler versions deploy` does not PATCH it (run
      // 41325777020: a PATCH from the toml cleared live's observability).
      if (want.observability || c.observability !== undefined) bad.push('observability set in the toml (a deploy would PATCH it; leave it to the dashboard)');
      if (c.logpush) bad.push('logpush set');
      if ((c.tail_consumers || []).length || (c.streaming_tail_consumers || []).length) bad.push('tail consumers set');
      // preview URLs: off unless pipeline.json says the live Worker has them on (jbx-desk-live, as live 1 Nov 2026).
      if (c.workers_dev !== true || c.preview_urls !== !!CFG.preview_urls) bad.push(`workers_dev ${c.workers_dev}, preview_urls ${c.preview_urls} (pipeline.json preview_urls ${!!CFG.preview_urls})`);
      if (c.no_bundle !== true || c.find_additional_modules !== false) bad.push('no_bundle / find_additional_modules');
      if ((c.triggers && (c.triggers.crons || []).length) || c.placement || c.limits) bad.push('triggers / placement / limits set');
      // Durable Objects (pipeline.json durable_objects): the class each binding names is exported by the release, the
      // migrations wrangler resolves for this env end at pipeline.json's tag, and the binding list for the env is the one
      // pipeline.json names (durable_objects is not inherited by an env, so a staging that forgot it would have none).
      if (CFG.durable_objects) {
        const D = CFG.durable_objects;
        const tag = (c.migrations || []).length ? String(c.migrations[c.migrations.length - 1].tag) : '';
        if (tag !== String(D.migration_tag) || tag !== lastMigrationTag(toml, env)) bad.push(`migration tag ${JSON.stringify(tag)}, pipeline.json ${JSON.stringify(D.migration_tag)}`);
        const names = ((c.durable_objects || {}).bindings || []).map(b => `${b.name}:${b.class_name}:${b.script_name || ''}`).sort();
        const wantNames = Object.entries(D[env] || {}).map(([n, w]) => `${n}:${w.class}:`).sort();
        if (JSON.stringify(names) !== JSON.stringify(wantNames)) bad.push(`durable object bindings ${JSON.stringify(names)}, pipeline.json ${JSON.stringify(wantNames)}`);
        const src = rel.toString('utf8');
        for (const w of Object.values(D[env] || {})) if (!new RegExp(`export class ${w.class} extends DurableObject\\b`).test(src)) bad.push(`release does not export class ${w.class}`);
        const classes = new Set((c.migrations || []).flatMap(m => [...(m.new_sqlite_classes || []), ...(m.new_classes || [])]));
        for (const w of Object.values(D[env] || {})) if (!classes.has(w.class)) bad.push(`class ${w.class} not created by any migration`);
      }
      if (bad.length) throw new Error(bad.join('; '));
      out.checks['settings_' + env] = 'ok';
    } catch (e) { fail('settings_' + env, String(e.message || e).split('\n')[0]); }
  }
}

// 5. migrations (pipeline.json durable_objects): a REAL `wrangler versions upload` (not --dry-run, which never looks at
// migrations) against a local fake Cloudflare API, for live and staging. With the Worker's migration tag = the toml's
// last tag, the upload sends no migrations and exactly the release; with the tag missing or different, wrangler refuses
// before uploading anything. So a pipeline deploy can never re-run or change a migration. Offline: localhost only.
if (CFG.durable_objects) {
  const http = await import('node:http');
  const fake = (tag) => new Promise(resolve => {
    const seen = { posts: [], patches: [] };
    const srv = http.createServer((req, res) => { const b = []; req.on('data', x => b.push(x)); req.on('end', () => {
      const body = Buffer.concat(b);
      const ok = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, errors: [], messages: [], result })); };
      if (req.method === 'POST' && /\/versions(\?|$)/.test(req.url)) { seen.posts.push(body); return ok({ id: '00000000-0000-4000-8000-000000000000', number: 1, metadata: {}, resources: { bindings: [], script: { etag: 'x', handlers: ['fetch'] } } }); }
      if (req.method === 'PATCH') { seen.patches.push(body.toString('utf8')); return ok({}); }
      if (/\/workers\/services\//.test(req.url)) return ok({ id: 'x', default_environment: { environment: 'production', script: { id: 'x', migration_tag: tag || undefined } } });
      if (/\/secrets$/.test(req.url)) return ok([]);
      ok({});
    }); }).listen(0, '127.0.0.1', () => resolve({ srv, seen }));
  });
  const { spawn } = await import('node:child_process');
  for (const env of ['live', 'staging']) {
    try {
      const tag = String(CFG.durable_objects.migration_tag);
      for (const [liveTag, expectOk] of [[tag, true], ['', false], [tag + '-other', false]]) {
        const { srv, seen } = await fake(liveTag);
        const port = srv.address().port;
        const res = await new Promise(resolve => {
          {
            const p = spawn('npx', ['--no-install', 'wrangler', 'versions', 'upload', '--message', 'proof', ...(env === 'live' ? ['--env', ''] : ['--env', env])], { cwd: WD,
              env: Object.assign({}, process.env, { CLOUDFLARE_API_TOKEN: 'proof-offline', CLOUDFLARE_ACCOUNT_ID: toml.account_id, CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}/client/v4`,
                NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_ENV: '' }) });
            let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
            p.on('close', code => resolve({ code, o }));
          }
        });
        srv.close();
        if (expectOk) {
          if (res.code !== 0 || seen.posts.length !== 1) throw new Error(`tag ${tag}: upload failed (${res.code}) ${res.o.split('\n').filter(l => /ERROR/.test(l)).join(' ').slice(0, 160)}`);
          const parts = formParts(seen.posts[0]);
          const meta = JSON.parse(parts.metadata.toString('utf8'));
          if (meta.migrations !== undefined) throw new Error(`tag ${tag}: upload sends migrations ${JSON.stringify(meta.migrations)}`);
          if (!parts['worker.js'] || sha(parts['worker.js']) !== REL.sha256) throw new Error(`tag ${tag}: uploaded worker.js is not the release`);
          if (seen.patches.some(x => /migration/.test(x))) throw new Error('script-settings patch mentions migrations');
        } else if (res.code === 0 || seen.posts.length || !/pending Durable Object migration/.test(res.o)) {
          throw new Error(`tag ${JSON.stringify(liveTag)}: wrangler did not refuse (exit ${res.code}, ${seen.posts.length} uploads)`);
        }
      }
      out.checks['migrations_' + env] = 'ok';
    } catch (e) { fail('migrations_' + env, String(e.message || e).split('\n')[0]); }
  }
}

// 3. size
const gz = zlib.gzipSync(rel, { level: 9 }).length;
out.size = { bytes: rel.length, gzip: gz };
if (rel.length > CFG.size.max_bytes) fail('size', `${rel.length} bytes > ${CFG.size.max_bytes}`);
else if (gz > CFG.size.max_gzip_bytes) fail('size', `gzip ${gz} > ${CFG.size.max_gzip_bytes}`);
else out.checks.size = 'ok';
const base = arg('--base');
if (base) {
  try {
    const old = JSON.parse(execFileSync('git', ['show', base + ':workers/' + WORKER + '/release.json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    const growth = (REL.bytes - old.bytes) / old.bytes * 100;
    out.size.growth_pct = Math.round(growth * 10) / 10;
    if (growth > CFG.size.max_growth_pct) fail('growth', `${out.size.growth_pct}% > ${CFG.size.max_growth_pct}% vs ${old.version}`);
    else out.checks.growth = 'ok';
  } catch (e) {
    let has = true;
    try { execFileSync('git', ['cat-file', '-e', base + ':workers/' + WORKER + '/release.json'], { cwd: ROOT, stdio: 'ignore' }); } catch (x) { has = false; }
    if (has) fail('growth', 'could not read release.json at ' + base + ': ' + String(e.message || e).split('\n')[0]);
    else out.checks.growth = 'skipped: no release.json at ' + base + ' (first release)';
  }
}

console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
