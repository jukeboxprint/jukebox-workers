# Changes

## v1.0.10 (2026-11-05)

- `worker-deploy.yml`: the live job's restore step exits 0 with "rollout never started (no rollout.ndjson)" when the run stopped before the rollout (for example at the live drift check). Before, `jq` on the missing file failed the step with exit 2 under `pipefail`, a second red step on top of the real failure (jukebox-door Deploy run 41990522663, 5 Nov 2026). No other change.

## v1.0.9 (2026-11-05)

Tyler's Go live rules (5 Nov 2026, relayed by the overseer).
- `scripts/door/rollout.mjs`: **too little traffic no longer rolls back** (before: a rollback, "not enough traffic to
  judge", at `max_watch_minutes`). This changes every caller, with or without the new settings. The step holds and
  keeps polling up to `rollout.max_wait_minutes` (new, default 120; proof and rollout refuse a value below
  `max_watch_minutes` or above 300). While held, the error rate is judged on any traffic. Still too little:
  `held_low_traffic` with the counts, exit 4, the split left as it is. Errors, latency, refusals and unreadable
  analytics roll back as before.
- `rollout.dark` (new, optional): a release behind switches that are off. CI (`proof.mjs`, check `rollout`) refuses it
  unless it names this release, lists switches (`kind` d1 or kv, a live binding, `key`, `off`) and the Worker has a
  smoke list. At Go live every switch is read on live (D1 query or KV value, deploy token); all off = no traffic count,
  only an error-rate breach on any traffic rolls back, smoke list at 100%. Any doubt = `dark_refused`, the normal watch.
- `worker-deploy.yml`: the live job's timeout covers `max_wait_minutes`; exit 4 fails the rollout step with "Held at N%,
  no rollback" and skips the restore step.
- `docs/PATTERN.md` section 10: writes that create POs or touch money keep 3 weekdays of shadow; other writes drop to
  one business day. Read-only one business day and the clean week are unchanged.
- Helpers in `scripts/door/worker.mjs`. Tests: `tests/scripts/rollout.test.mjs` (hold then promote, held at the limit,
  error breach while held, dark off / on / unreadable / wrong release), `worker.test.mjs`, `proof.test.mjs`. Packages
  unchanged.

## v1.0.8 (2026-11-05)

- `scripts/door/drift.mjs`: optional pipeline.json key `release_managed.crons`, a list of cron expressions a release adds
  to (or takes out of) the toml's `[triggers]`. Ported from jukebox-copilot #240 (copilot-jobs v7 adds six ops crons
  beside v6's drain cron; drift refused any cron change on a Worker that already had crons). When live's schedules
  differ from the toml only in those crons, drift notes it ("the release adds … / removes …"); the deploy's cron step
  sets them as before. Any other difference is refused on live and noted on staging, as in v1.0.7. Remove the key in the
  first PR after that release is live.
  - Differs from copilot's: copilot notes only live = exactly the toml minus the listed crons. Here live may also have
    some of them already (a set, then a script rollback), and a listed cron the toml drops is noted too.
  - Without the key (or with `[]`): byte-identical output. `tests/scripts/drift_parity.test.mjs` runs the v1.0.7
    drift.mjs (`tests/scripts/fixtures/drift.v1.0.7.mjs`, pinned by sha256) and this one against the same fake
    Cloudflare API: four Workers, live and staging, 11 scenarios (crons equal, added, removed, changed, none on live;
    binding, secret, settings and script differences). Key tests in `tests/scripts/drift.test.mjs`. Packages unchanged.

## v1.0.7 (2026-11-04)

- Queues, asked for by jukebox-door PR #9 (jbx-bq v2: the BigQuery write path as a Queue consumer; the producer is
  copilot-jobs). A Worker whose toml has no queues behaves as in v1.0.6: same proof checks, same drift requests and
  answer, the new deploy steps do nothing (tests prove each against v1.0.6).
  - Producers (`[[queues.producers]]`, `binding` and `queue` only): a version binding, `queue <binding> <queue>` in
    `wantBindings`, the upload-form check in `proof.mjs` and live drift. Not inherited by an env (as wrangler).
  - Consumers (`[[queues.consumers]]`: `queue`, `max_batch_size`, `max_batch_timeout`, `max_retries`, optional
    `dead_letter_queue`; the first four required, any other key refused). `proof.mjs` checks them and that the release
    has a `queue()` handler. `scripts/door/queues.mjs` (new) and two steps in `worker-deploy.yml` (after the staging
    deploy, after the live rollout, next to the crons): read the consumer from the Cloudflare API; equal = nothing;
    else POST or PUT it with the body wrangler 4.156 sends, read it back, fail unless equal. Skipped when the toml has
    none. `drift.mjs` compares them before a deploy (not set yet: noted; different: as bindings; pipeline.json
    `release_managed.queues` lists queues whose settings a release changes).
  - The pipeline never creates a queue. Every queue the toml names (producers, consumers, dead-letter queues) must exist:
    drift and `queues.mjs` fail naming it ("create it in the dashboard or with `wrangler queues create <name>`, on
    Tyler's word"). A queue held by another Worker is refused; staging may not name any of live's queues.
  - An API answer not in the expected shape fails before anything changes. A consumer the toml drops is not removed
    (`wrangler queues consumer remove`, by hand). Consumers are not versioned: a rollback of the script keeps them.
  - Helpers in `scripts/door/worker.mjs`. Tests: `tests/scripts/queues.test.mjs`, `drift.test.mjs`, `proof.test.mjs`
    (real wrangler dry-run), `worker.test.mjs`. Packages unchanged.

## v1.0.6 (2026-11-04)

- `scripts/door/rollout.mjs`: the gradual rollout's watch also compares refusals (HTTP 302 and 403) between the new and
  old versions. A second Workers analytics query per version groups by `httpResponseStatus`. Refusal share = refused /
  requests. Once the new version has `min_requests`, it is a breach (rolls back like any other) when the new share is
  more than `rollout.max_refusal_share_vs_old` × the old one (default 2) and at least `rollout.min_refusal_excess`
  above it (default 0.05). `rollout.refusals: false` turns it off. Each watch line logs both versions' `refusals`.
  Fail-safe: the status field is not yet confirmed on the live API, so a refusal read that fails or comes back in an
  unexpected shape logs `step: refusals_unreadable` and skips the check for that watch. It never counts as "analytics
  unreadable" and never rolls back; only a jump that was read rolls back.
  Why: the jbx-inflow cut-over (4 Nov 2026) refused saves with 302/403 ("Not allowed for your role") while status
  codes and error rate looked healthy. This is the rollout-time guard; per-route counting lives in each Worker and the
  door (PATTERN 10a rule 1). Helpers `refusalSettings`, `refusalCount`, `judgeRefusals` in `scripts/door/worker.mjs`.
  Tests: `tests/scripts/worker.test.mjs`, `tests/scripts/rollout.test.mjs` (a fake Cloudflare API and wrangler).
  Packages unchanged.

## v1.0.5 (2026-11-04)

- `worker-ci.yml`: new optional input `npm_script` (default `test`, so nothing changes for today's callers). Worker CI's
  last step runs that npm script if package.json has it; `''` runs none. A script name must be 1-64 of
  `A-Za-z0-9:_.-`, passed through `env`, never interpolated into the shell. For a repo whose root `npm test` is not the
  Workers' (for example an older repo that gains a `workers/` folder): `with: { npm_script: test:workers }`. Asked
  for while placing jbx-prepress-watch (the analytics session, 4 Nov 2026). Scripts and packages unchanged.

## v1.0.4 (2026-11-04)

- Cron triggers (`[triggers] crons` in a Worker's wrangler.toml), asked for by the accounting session so jbx-accounting's
  nightly reconcile can run on its own. Until now the pipeline refused any cron.
  - `scripts/door/proof.mjs`: each cron must be five valid fields, and the release must have a `scheduled()` handler.
  - `scripts/door/drift.mjs`: the Worker's schedules are compared with the toml's crons for that env (an env inherits
    the top level unless it sets its own). None set yet while the toml has some: noted (the deploy sets them). Any other
    difference: refused on live, noted on staging, as for other bindings.
  - `scripts/door/triggers.mjs` (new) and two steps in `worker-deploy.yml`: after the staging deploy and after the live
    rollout, `wrangler triggers deploy` when the schedules differ from the toml (a version deploy does not set them),
    then the schedules are read back and must match.
  - Crons are not versioned: a rollback of the script keeps them. A release that adds a cron ships its handler in the
    same release; a rollback past it should also take the cron out by PR.
  - Helpers `cronsFor`, `validCron`, `cronPlan` in `scripts/door/worker.mjs`. Tests: `tests/scripts/worker.test.mjs`,
    `tests/scripts/triggers.test.mjs` (a fake Cloudflare API and wrangler). Packages unchanged.

## v1.0.3 (2026-11-04)

- `scripts/door/rollout.mjs`: during a gradual rollout's watch, an analytics read that fails (an API timeout) is retried
  before it counts as "analytics unreadable" and rolls back. One such timeout rolled back a healthy front door v51 on
  4 Nov 2026 (0 errors on the new version). New optional `rollout.analytics_tries` (default 3; 1 = as before) and
  `rollout.analytics_retry_s` (default 10). Each retry is logged (`step: analytics_retry`). A breach still rolls back at
  once; only a failed read is retried. The loop is `retryRead` in `scripts/door/worker.mjs` (tests in
  `tests/scripts/worker.test.mjs`). Packages unchanged.

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
