# jukebox-workers

Jukebox Print's shared Cloudflare Worker pipeline, packages and pattern. **Public**: never put a secret, an id, an
email address or a private hostname here (the public guard refuses them on every PR).

| Path | What |
|---|---|
| `docs/PATTERN.md` | The standard pattern for every internal page and tool moving off n8n. Start here. |
| `docs/PIPELINE.md` | How a Worker repo calls the pipeline (caller workflows, switches, environments, first deploy). |
| `.github/workflows/worker-{ci,deploy,rollback,d1}.yml` | Reusable workflows the Worker repos call, pinned to a commit. |
| `scripts/door/` | Proof, dist, drift, rollout and smoke: jukebox-copilot's pipeline scripts, moved here 3 Nov 2026. |
| `scripts/worker/` | `repo.mjs` (pattern checks, Worker list, changed Workers, pins), `d1.mjs` (D1 create and migrate). |
| `packages/` | `@jukebox/workers/door-pass`, `push-sign`, `health`, `crypto` (TypeScript, Web Crypto). |
| `scripts/ci/` | `public_guard.mjs`, `check_workflows.py`. |

Local: `npm ci && npm run typecheck && npm test && npm run guard`.

Releases are tags `vX.Y.Z`. A Worker repo moves to a new release by PR: change the pinned sha in its workflows and
`pipeline_ref`, and the `@jukebox/workers` tag in its `package.json`.
