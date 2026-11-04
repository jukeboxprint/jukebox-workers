# Calling the pipeline from a Worker repo

The rules are in `PATTERN.md` section 5. This page is the how. `jukebox-template` already has every file below.

## Caller workflows

Four short files in the Worker repo's `.github/workflows/`. Every `uses:` pins the same jukebox-workers commit sha
(tag in a comment), and `pipeline_ref` repeats it. CI refuses anything else.

```yaml
# ci.yml — required check on main
name: CI
on: { pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
jobs:
  ci:
    uses: jukeboxprint/jukebox-workers/.github/workflows/worker-ci.yml@<sha>  # vX.Y.Z
    with: { pipeline_ref: <sha> }
```

```yaml
# deploy.yml
name: Deploy
on:
  push:
    branches: [main]
    paths: ['workers/*/release.json', 'workers/*/wrangler.toml']
  workflow_dispatch:
    inputs:
      worker: { description: 'Folder under workers/', type: string, required: true }
      go_live: { description: 'Go live after staging passes (this run is your approval)', type: boolean, default: false }
      skip_staging: { description: 'Allowed only while the staging switch is off', type: boolean, default: false }
      bootstrap_staging: { description: 'Durable Object Worker: first staging deploy only', type: boolean, default: false }
permissions: { contents: read }
jobs:
  deploy:
    uses: jukeboxprint/jukebox-workers/.github/workflows/worker-deploy.yml@<sha>  # vX.Y.Z
    with:
      pipeline_ref: <sha>
      environment_staging: <area>-staging
      environment_live: <area>-live
      worker: ${{ inputs.worker || '' }}
      go_live: ${{ inputs.go_live || false }}
      skip_staging: ${{ inputs.skip_staging || false }}
      bootstrap_staging: ${{ inputs.bootstrap_staging || false }}
    secrets: inherit
```

```yaml
# rollback.yml
name: Rollback
on:
  workflow_dispatch:
    inputs:
      worker: { type: string, required: true }
      version_id: { description: 'Blank = the version before the current one', type: string, default: '' }
      reason: { type: string, required: true }
permissions: { contents: read }
jobs:
  rollback:
    uses: jukeboxprint/jukebox-workers/.github/workflows/worker-rollback.yml@<sha>  # vX.Y.Z
    with: { pipeline_ref: <sha>, environment_live: <area>-live, worker: '${{ inputs.worker }}', version_id: '${{ inputs.version_id }}', reason: '${{ inputs.reason }}' }
    secrets: inherit
```

```yaml
# d1.yml
name: D1
on:
  push: { branches: [main], paths: ['workers/*/migrations/**'] }
  workflow_dispatch: {}
permissions: { contents: read }
jobs:
  d1:
    uses: jukeboxprint/jukebox-workers/.github/workflows/worker-d1.yml@<sha>  # vX.Y.Z
    with: { pipeline_ref: <sha>, environment_staging: <area>-staging }
    secrets: inherit
```

## Repository settings (Tyler)

| Where | What |
|---|---|
| Environments | `<area>-staging` and `<area>-live` (live: deployments from `main` only). Each holds `CLOUDFLARE_API_TOKEN` = the repo's own token `github-<repo>-deploy`. Never a repository or organisation secret. |
| Variables | `<DIR>_STAGING` = `on` (merges deploy staging), `<DIR>_LIVE` = `on` (a Go live run may deploy live), per Worker folder: `workers/inflow` → `INFLOW_*`, `workers/inflow-jobs` → `INFLOW_JOBS_*`. Missing = off. Optional: `CF_ACCOUNT_ID`, `WORKER_NAME_EXCEPTIONS` (only for Workers named before the pattern). |
| Branch rule on `main` | PR required; check "Worker CI" required. |

## What a run does

- **CI (every PR):** pins, same wrangler as the pipeline, the pattern check, then for each Worker: proof, typecheck
  (if `workers/<dir>/tsconfig.json`), `workers/<dir>/scripts/check.mjs`, `tests/<dir>/*_test.mjs`; then the caller's npm script: input `npm_script`, default `test`, `''` = none (v1.0.5), run only if
  package.json has it.
- **Deploy on merge:** each changed Worker whose `<DIR>_STAGING` is on: drift → D1 migrations → upload at 100% → smoke.
- **Deploy by hand with Go live** (one Worker, `<DIR>_LIVE` on, on Tyler's word): staging as above, then live drift →
  D1 migrations → rollout per `pipeline.json` → drift again; any failure or cancel puts the old version back.
  The rollout watch rolls back on errors, latency, and (v1.0.6) a jump in refusals: the new version's share of HTTP
  302/403 above 2× the old one's and at least 0.05 higher (`rollout.max_refusal_share_vs_old`,
  `rollout.min_refusal_excess`; `rollout.refusals: false` turns it off). A refusal read that fails is logged
  (`refusals_unreadable`) and skipped, never a rollback.
- **Rollback by hand:** `wrangler rollback`, then the smoke list.
- **D1:** creates any database the tomls name and prints ids; the ids go into the toml by PR.

## Moving to a new pipeline release

One PR: the new sha in every `uses:` and `pipeline_ref`, and the new tag in `package.json`
(`"@jukebox/workers": "github:jukeboxprint/jukebox-workers#vX.Y.Z"`). CI proves the rest.
