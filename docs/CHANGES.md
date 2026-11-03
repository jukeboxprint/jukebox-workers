# Changes

## v1.0.2 (2026-11-03)

- `scripts/door/rollout.mjs`: health after a deploy (100%, and `--bootstrap`) is polled until the health paths answer
  as `pipeline.json` says, instead of read once `health_delay_s` after the deploy. A new version can take a while to
  reach every edge, so the single read could see the old version and roll back a healthy release (jbx-accounting
  staging, 3 Nov 2026). New optional `rollout.health_wait_s` (default 90; 0 = one read, as before) and
  `rollout.health_poll_s` (default 5). A real failure is still rolled back, at most `health_wait_s` later. The loop is
  `pollHealth` in `scripts/door/worker.mjs` (tests in `tests/scripts/worker.test.mjs`). Packages unchanged.

## v1.0.1 (2026-11-03)

- `worker-d1.yml`: a push run with no `CLOUDFLARE_API_TOKEN` in the staging environment (a template, or a new repo
  before its environments are set up) logs "not set up yet" and passes instead of failing (jukebox-template's first
  merge emailed Tyler a failure). A hand-started run still fails. Packages unchanged: `@jukebox/workers#v1.0.0` stays.

## v1.0.0 (2026-11-03)

First release.

- `scripts/door/*.mjs` moved from jukebox-copilot `main` (last change `c29072e`). Two changes: the repo root comes from
  `JBX_REPO_ROOT` (unset = two folders up, as before), and `proof.mjs` runs `dist.mjs` from its own folder. The front
  door's own `smoke.mjs` stays with the front door. Checked: `proof.mjs` run from here passes for jbx-inflow,
  jbx-analytics, jbx-accounting, jbx-front-door v42, jbx-claude-cache v3 and copilot-jobs v4.
- Also in `scripts/door` (asked for by the analytics session for `jbx-analytics-jobs`): Hyperdrive bindings
  (`hyperdrive <binding> <id>` in proof, drift and `wantBindings`; never inherited by an env; `TBD` blocks), and
  `compatibility_flags` handled like `compatibility_date` (staging noted; live refused except a placeholder while
  `placeholder_live` is true). Checked: proof passes for `jbx-analytics-jobs` (Hyperdrive, `nodejs_compat`, 1.2 MB).
- `scripts/worker/d1.mjs` from jukebox-inflow, same `JBX_REPO_ROOT` change.
- `scripts/worker/repo.mjs` (new): the pattern check, Worker list, changed Workers, switch names and pins. Replaces
  `scripts/ci/repo-vars.mjs` (analytics), `scripts/worker/vars.mjs` (inflow) and the inline check (accounting).
- Reusable workflows `worker-ci`, `worker-deploy`, `worker-rollback`, `worker-d1`: several Workers per repo,
  per-Worker switches, names from the toml.
- Packages `door-pass`, `push-sign`, `health`, `crypto`.
- `public_guard.mjs` and Pipeline CI.
