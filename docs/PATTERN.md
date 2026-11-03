# Jukebox Workers: the standard pattern (2 Nov 2026)

Status: approved by Tyler, 2 Nov 2026 (spec and the six drafting decisions).
Home once approved: `jukeboxprint/jukebox-workers/docs/PATTERN.md` (public). Copies: the claude.ai Project
(`claude/worker-pattern-2026-11-02.md`) and jukebox-knowledge. The `cloudflare-worker-handoff` skill points here.
Decisions: Tyler, batches 1-3, 2 Nov 2026. Modelled on jukebox-copilot (front door, claude-cache, desk-live,
copilot-jobs, copilot-suggest).

## 1. Principles

1. Cloudflare does the work: pages, reads, writes, schedules, queues and compute run on Workers.
2. Data never lives in n8n. Each Worker's D1 is the system of record for its data and config. n8n reads and writes
   only through a Worker's API.
3. BigQuery is for history and reporting. Workers write to it, and read the warehouse, only through `jbx-bq`.
4. n8n is glue: triggers, schedules that call Workers, third-party steps not yet on Workers, email.
5. Port as-is first. Prove identical output in shadow, then switch. Refactor only after a clean week.
6. Every behaviour change sits behind a config switch, where missing = today. Each flip is on Tyler's word, and the
   audit row records it.
7. Live deploys go out only from a hand-started run with Go live ticked, on Tyler's word.

## 2. Repos

| Repo | Visibility | Holds |
|---|---|---|
| `jukebox-workers` | **public** | Reusable workflows, `scripts/door` + `scripts/worker`, `packages/*`, `PATTERN.md`, the public guard. Released by tag `vX.Y.Z`. |
| `jukebox-template` | private, template | The empty project layout of section 3, already wired to a `jukebox-workers` tag. New repos are made from it. |
| `jukebox-door` | private | `jbx-front-door` and the shared Workers (`jbx-bq`). Moves out of jukebox-copilot after the routing PR lands. |
| `jukebox-<area>` | private | One business area (copilot, analytics, inflow, accounting, ...). Can hold several Workers. |
| `jukebox-skills`, `jukebox-knowledge` | as today | Skills; hand-back copies. |

jukebox-workers holds no secrets, no Cloudflare or n8n ids and no customer data. Its public guard (CI on every PR)
refuses anything shaped like a key, token, account or namespace id, email address or n8n workflow id. Only the
patterns and allow-lists live there.

## 3. Project repo layout

```
CLAUDE.md                     repo rules (copy of section 15, plus area specifics)
README.md                     what the area is, its Workers, links to docs
package.json                  pins @jukebox/* packages and the pipeline to one jukebox-workers tag
.github/workflows/
  ci.yml, deploy.yml, rollback.yml, d1.yml    thin callers: uses jukeboxprint/jukebox-workers/.github/workflows/<x>.yml@<sha> # vX.Y.Z
workers/<dir>/                one folder per Worker
  wrangler.toml               bindings, vars, both envs. The only place they change.
  release.json                version, note, source file, sha256, bytes, build
  secrets.json                secret names only (live list, staging map)
  pipeline.json               kind, size, rollout, smoke list, hosts
  src/                        TypeScript + Hono
  src/gen/                    byte-identical n8n ports (JS), each with a sha256 pin and its source workflow version
  migrations/                 D1, additive only
  release/worker.vN.js        the built release, committed
tests/<dir>/                  *_test.mjs, plus parity scripts; fixtures from real executions are git-ignored
n8n/<workflow-slug>/          remaining glue code: manifest.json (workflow id, node, sha256), nodes/*.js
docs/
  YYYY-MM-DD-<topic>.md       design notes, hand-backs, hand-offs
  ARCHITECTURE.md             one section per Worker: owns, reads, writes, bindings, routes
  RUNBOOK.md                  switches, rollback, common fixes
```

## 4. Naming

| Thing | Rule | Example |
|---|---|---|
| Repo | `jukebox-<area>` | `jukebox-inflow` |
| Worker | `jbx-<area>[-<role>]`, staging `+ -staging` | `jbx-inflow`, `jbx-inflow-staging` |
| Worker folder | `workers/<area>[-<role>]` without `jbx-` | `workers/inflow` |
| D1 / KV / Queue | Worker name + purpose, staging `-staging` | `jbx-analytics-snap-staging` |
| Service binding | target Worker in capitals, no `JBX_` | `ANALYTICS`, `BQ` |
| GitHub environments | `<area>-staging`, `<area>-live` (live: main only) | `inflow-live` |
| Repo variables | `<DIR>_STAGING`, `<DIR>_LIVE` = `on` (missing = off) | `INFLOW_LIVE` |
| Deploy token | `github-<repo>-deploy` | `github-jukebox-inflow-deploy` |
| Health | `GET /health` | |
| Paths behind the door | `/<area>/...` (or the page's existing path while ported) | `/analytics/accounting/*` |

Listed exceptions (not renamed: new Durable Object namespaces and bindings): `copilot-jobs`, `copilot-suggest`.

## 5. Pipeline

Source: `jukebox-workers` at a tag. Callers pin the commit sha (tag in a comment) and pass the same sha as
`pipeline_ref`. The reusable workflow checks out jukebox-workers at that sha into `.jbx-pipeline/` and runs its
scripts with `JBX_REPO_ROOT` = the caller's checkout. CI fails if the workflows pin different shas, if `pipeline_ref`
differs from the pin, or if the caller's wrangler version differs from the pipeline's. How to call it: `docs/PIPELINE.md`.

- **Names come from `wrangler.toml`**, not repo variables (`scripts/worker/repo.mjs check`): `name` is
  `jbx-<area>[-<role>]` with area = the repo name without `jukebox-`, the folder is the name without `jbx-`,
  `[env.staging] name` = `name + "-staging"`, and every toml in the repo names one account. Listed exceptions live in
  the admin-held repository variable `WORKER_NAME_EXCEPTIONS`, so a PR cannot point a repo's (account-wide) token at
  another repo's Worker. Optional `CF_ACCOUNT_ID` variable: when set, the tomls must match it. Otherwise repository
  variables are only the per-Worker switches.
- **PR → CI** (required check, runs on every PR): public-guard (jukebox-workers only), typecheck, tests in `tests/<dir>/`,
  `proof.mjs` (release = build of `src/`, byte for byte; upload form = the toml; no observability, placement or limits),
  size and growth against main, `gen` checks (each `src/gen` file = its n8n export), n8n manifest hashes.
- **Merge → staging** for each Worker whose `release.json` or `wrangler.toml` changed, when `<DIR>_STAGING` = on: drift →
  D1 migrations → upload at 100% → smoke.
- **Live**: a hand-started Deploy run (inputs `worker`, `go_live`) from main, with `<DIR>_LIVE` = on, on Tyler's word.
  Claude starts it with `actions_run_trigger` only after Tyler's word for that run. Staging first, then live drift (live
  must be a release main ever named, or the placeholder while `placeholder_live` is true) → D1 migrations → rollout
  per `pipeline.json` → health + smoke → drift again. Any breach, failure or cancel puts the old version back.
- **Rollout defaults**: `[100]` while no traffic is routed; `[50, 100]` with 10 requests in 60 min once routed (front door
  `[25, 100]` with 50). Thresholds in `pipeline.json`, judged as ratios against the old version.
- **Rollback**: Rollback workflow (blank = the version before), or the dashboard's Deployments → Rollback.
- **D1**: the D1 workflow creates missing databases and prints ids; ids go into the toml by PR; `TBD` blocks every
  deploy. Migrations additive only; a rollback never undoes one.
- **Durable Objects**: ship classes before the first bootstrap; a new class on a live Worker needs its own plan.
- **Never**: the dashboard editor, a paste, `[observability]` in the toml, `wrangler secret put` from CI.

- **Smoke**: kind `passthrough` runs `pipeline.json`'s smoke list (`smoke_simple.mjs`); any other kind runs the
  Worker's own `workers/<dir>/scripts/smoke.mjs` (the front door's smoke stays with the front door).
- **`skip_staging`** is refused while that Worker's staging switch is on, and live needs a staging job that really
  deployed (a staging switch that is off is not a pass).

Copilot's per-Worker workflows are replaced by the callers in punch-list step 5.

## 6. Secrets and vars

| Name | Where | Value |
|---|---|---|
| `DOOR_SECRET` | every Worker behind the door, and n8n | **own value per target** (each Worker, n8n). The door holds them as `DOOR_SECRET_<BINDING>` (n8n: `DOOR_SECRET_N8N`) and signs each pass with the target's key. |
| `PUSH_SECRET` | any Worker that takes signed pushes or calls | own value per Worker per environment; n8n variable `<WORKER>_PUSH_SECRET` |
| `BQ_SA_JSON` | `jbx-bq` only (and the front door until open_history moves) | read key: BigQuery Data Viewer on the allowed datasets + Job User; the write path gets its own key |
| Third-party | `<VENDOR>_TOKEN` / `<VENDOR>_API_KEY`, area suffix when keys differ (`ANTHROPIC_COPILOT_KEY`) | |
| `CLOUDFLARE_API_TOKEN` | GitHub environments `<area>-staging` / `-live` only | one token per repo, `github-<repo>-deploy`, 1-year expiry: Workers Scripts Edit, Account Analytics Read, D1 Edit, Workers KV Storage Edit, Queues Edit |

- **One signing format** (`@jukebox/push-sign`): hex HMAC-SHA256(secret, `<purpose>.v1.` + ts + `.` + path + `.` + body),
  headers `x-jbx-ts`, `x-jbx-sig`, ts within 120 s. A distinct purpose per use, so no signature works for another.
- **Staging always has its own values**, never live's. It gets no live data and no third-party keys unless Tyler names a
  read-only one.
- Values are set by Tyler in Cloudflare or n8n; never in a repo, workflow or chat. `secrets.json` lists names, and drift
  checks them.
- Vars (toml): `N8N_BASE` (the n8n origin), infra and kill switches only. Behaviour lives in D1 config (section 9).
- `/health` answers `{ ok, worker, version, configured: {…booleans}, bound: {…booleans} }`, never a value.

## 7. Data placement

| Store | Use | Never |
|---|---|---|
| D1 (per Worker) | System of record: app data, settings, config + audit, sessions | Read by another Worker directly (use its API over a service binding) |
| KV | Derived, read-mostly copies: config snapshot, rendered or computed snapshots, caches | The only copy of anything |
| Durable Objects | Per-entity coordination: sockets, per-conversation jobs, ledgers | Reporting data |
| Queues | Async work; every BigQuery row | |
| R2 | Files and images | |
| BigQuery | History, reporting, analysis. Written by `jbx-bq` (Queue consumer) into the same tables as today. Read through `jbx-bq` too (`POST /query`, one SELECT, datasets allow-listed per caller in its config) | Live app state |
| n8n data tables | Nothing of record. Existing ones move out (section 10) | New tables |

- Compute also moves: an n8n compute (for example analytics snapshots) becomes a Worker cron or Queue consumer reading D1 or
  BigQuery, ported as-is and proved by parity. Until then n8n pushes its result to the Worker's signed ingest.
- Logs and stats: one request id panel → Worker → Claude/n8n → panel; stage timings and usage rows go to the Queue;
  inputs masked; 30-day retention. Workers analytics for requests, errors, p50, p99. Observability is dashboard-managed.

### `jbx-bq` (shared, in jukebox-door; renamed from jbx-bq-writer, Tyler 3 Nov 2026)

- **Read:** `POST /query` `{ "sql": "<one SELECT>" }` → `{ "rows": [ { col: value } ] }`. INT64, FLOAT64 and NUMERIC come
  back as JSON numbers, NULL as null, everything else as strings. At most 50,000 rows and 120 s. Anything but a single
  SELECT on the caller's allowed datasets is refused.
- **Callers** are allow-listed in `jbx-bq`'s D1 config: caller Worker → datasets it may read. Each call is signed with
  `@jukebox/push-sign` (purpose `bqread`) on a key for that caller; the service binding alone is not enough.
- **Keys:** the read key has BigQuery Data Viewer on the allowed datasets plus Job User, nothing else. The write path
  (the Queue consumer) gets its own key. Staging holds neither and answers 503.

## 8. Front door routing

```
viewer → jbx-front-door: sign-in, cookie, role check (door D1 route_roles)
       → door_routes match → service binding <AREA>: pass signed with DOOR_SECRET_<AREA>
                             → no match / mode off / fallback → n8n /webhook/... (pass signed with DOOR_SECRET_N8N)
```

- **`door_routes`** (door D1 table, admin page, KV snapshot): `prefix`, `binding`, `mode` (`off` | `test` | `shadow` | `live`),
  `test_list`, `shadow_pct`, `timeout_ms`, `fallback` (`n8n` | `none`), `note`. Longest prefix wins.
- **`route_roles`** (door D1, replaces `ROUTE_ROLES` in code): ordered rows, first match wins, as today.
- **Fallback**: on a GET, an unbound binding, a throw, a timeout before headers, a 5xx or a 404 marked "not ported" →
  n8n, counted. A write that the Worker accepted (headers received) is **never** sent again to n8n (copilot-jobs rule).
- **Hand-back** (Tyler, 3 Nov 2026): a Worker that should not answer a request (data missing or stale, a render error, a
  save it does not take yet) answers **409 with `x-jbx-route: n8n`**, and the door sends that request to n8n, counted.
  GET: always. POST: the Worker sends it only when it wrote nothing, so the door forwards the same body; a Worker that
  wrote anything answers itself and never hands back. Any other answer to a POST is the Worker's and is never resent.
  Copilot's Workers keep their own variant, `x-copilot-route: n8n` (front door v50 `/aux` routes).
- **Shadow**: n8n answers; the Worker gets the same request in the background (sampled, capped per day); body hashes
  compared, differences counted and logged.
- **Staging**: the live door never sends traffic to a staging Worker. `jbx-front-door-staging` binds the staging Workers.
- **Headers to a Worker**: `x-door-identity` (path-bound, `iat`), `x-forwarded-host`, `x-request-id`. Never the cookie and
  never `x-door-secret`. `x-door-secret` to n8n stops once n8n's gates are checked not to read it.
- **Workers behind the door** fail closed without a valid pass (`@jukebox/door-pass`), answer `robots.txt` Disallow, and
  stay workers.dev only. No custom domains per project.
- **Sign-in** moves off n8n last: Google client secret in the door's secrets, sessions and access groups in the door's D1.

## 9. Config and admin

- Each Worker's D1 has `config(key, value, note, updated_by, updated_at)` and `config_audit(at, by, key, old, new, note)`.
  Audit rows also go to BigQuery.
- `/<area>/admin` (role `super`) edits it. Each save writes the audit row and republishes the KV snapshot; readers use the
  snapshot.
- Missing key = today's behaviour. A switch flip carries Tyler's words, the time and the rollback in its note.
- The door's own config (`door_routes`, `route_roles`, access lists, `door_reads`) works the same way in the door's D1.
- Copilot's `csr_call_assist_config` and `app_config` move here (punch-list step 6).

## 10. Moving off n8n: parity, cut-over, rollback

| Kind | Proof | Gate to live |
|---|---|---|
| Page / read | same input → same body hash as n8n (`parity.mjs`), then shadow on real traffic | zero unexplained differences over 3 weekdays |
| AI output | blind grading under `ai-eval-protocol` | Tyler's call on the graded result |
| Data table | the Worker API writes D1 and the n8n table together; reads switch to D1; the n8n table becomes a read-only mirror | one clean week, then delete the table |
| n8n route / workflow | route at `live` | one clean week → unpublish → archive after a month |

- **Clean week**: 7 days with 5 weekdays, no rollback and no unexplained difference.
- **Rollback ladder** (fastest first): config switch → `door_routes` mode `off` (back to n8n) → Rollback workflow →
  dashboard Deployments → Rollback.

## 11. n8n's role and its code

- Allowed in n8n: triggers and schedules that call Worker endpoints, third-party steps not yet on Workers (inFlow writes,
  Gmail, Google), email, the global error handler. Not allowed in new work: page rendering, data tables, business math.
- n8n calls Workers with signed requests (`PUSH_SECRET`, `@jukebox/push-sign`).
- Remaining Code-node sources live in the owning repo under `n8n/<workflow-slug>/` with `manifest.json`.
- **One patcher**: the generalised `UTIL Code Patch` (repo, path, pinned commit, hash before and after, DRY first, back to DRY
  after). The n8n API key stays in n8n; no n8n key in GitHub.
- **Drift**: daily and read-only. Because the key stays out of GitHub, it runs as an n8n scheduled UTIL that reads each
  repo's manifests at `main` and compares them with the live nodes. It emails on a mismatch and writes the result through
  `jbx-bq`.

## 12. Shared packages (`jukebox-workers/packages/*`, TypeScript, released with the pipeline tag)

`door-pass` (verify `x-door-identity`), `push-sign`, `health`, `config` (D1 + KV snapshot + audit + admin page parts),
`bq` (Queue producer row shapes), `log` (request id, stage timings). Each is pinned by tag and bundled into the release
file at build time. No Worker writes its own copy.

## 13. Code rules

- New code in TypeScript + Hono, typecheck in CI. Files under ~400 lines. Workers meet only through typed contracts over
  service bindings.
- n8n ports stay byte-identical JS in `src/gen/` with sha256 pins until a clean week, then get rewritten.
- The front door stays on its JS version builds (`build_vNN.mjs` proofs) until it is split.
- No hard-coded recipients, ids or thresholds: config in D1, `pipeline.json` or toml vars.
- Real-data fixtures never in git.

## 14. Starting a new project

1. Tyler: repo `jukebox-<area>` from `jukebox-template`; Workers `jbx-<area>` and `jbx-<area>-staging` as Hello World
   placeholders; environments `<area>-staging` / `<area>-live` (main only) with that repo's own token; secrets on each
   Worker (own values per environment).
2. Claude, first PR: Worker folder, `ARCHITECTURE.md`, `release.json` v1, `placeholder_live: true`. The D1 workflow
   creates databases (ids by PR).
3. `<DIR>_STAGING` = on → merge deploys staging. On Tyler's word, `<DIR>_LIVE` = on and Go live. A PR then removes
   `placeholder_live`.
4. jukebox-door PR: binding `<AREA>` (+ staging door's `<AREA>` → staging Worker), `door_routes` row `off`,
   `route_roles` row, door key `DOOR_SECRET_<AREA>`.
5. Port as-is → parity → `shadow` → `live` → clean week → n8n workflow unpublished → data tables moved (section 10).
6. Hand-back in `docs/`, the Project and jukebox-knowledge. New or changed skills pushed to jukebox-skills the same session.

## 15. Rules every repo's CLAUDE.md carries

PR → CI → merge (staging) → hand-started live on Tyler's word · never the dashboard editor or a paste · bindings and vars
only by PR · secrets only in Cloudflare/n8n, names in `secrets.json` · staging has its own values and no live data ·
every release bumps `release.json` with `vN (YYYY-MM-DD): …` · `src/gen` and `n8n/*` regenerated, never hand-edited ·
no data in n8n · real-data fixtures never in git · dated docs, written plainly and briefly.

---

# Punch list

Steps run in this order. The Copilot speed push keeps priority, and separate sessions can work on different repos in
parallel. **T** = Tyler, **C** = Claude.

**1. Security (now)**
- T: rotate `jbx-inflow-staging`'s `DOOR_SHARED_SECRET` and `INFLOW_SYNC_SECRET` to their own values (+ n8n staging vars).
- C (config row): blank analytics `cf_ingest_url_staging`. Staging stops getting live snapshots; it gets a test fixture instead.
- C: list which n8n gates read `x-door-secret` (read-only), for removal in step 3.

**2. jukebox-workers (new, public)**
- T: create the repo (public) and `jukebox-template` (private, marked as template); allow its workflows to be called
  from the org.
- C: move `scripts/door/*` there; turn the workflows into reusable, multi-Worker ones (per-Worker switches, names from
  the toml, D1 step from inflow); public guard; packages `door-pass`, `push-sign`, `health` first; tag `v1.0.0`; this spec.
- C: generalise `UTIL Code Patch` and build the n8n drift UTIL.
- C: update the `cloudflare-worker-handoff` skill (all pipeline Workers, `actions_run_trigger`, per-repo tokens, points here).

**3. Front-door routing (jukebox-copilot PR, then jukebox-door)**
- C: `door_routes` + `route_roles` in the door's D1 with snapshot and admin page; per-target `DOOR_SECRET_<X>`; no
  `x-door-secret` or cookie to Workers; shadow and fallback as in section 8; bindings `ANALYTICS`, `INFLOW`, `ACCOUNTING`.
- T: set the per-target door keys, then the matching `DOOR_SECRET` on each Worker (rotation: new value on the Worker
  first, then the door).
- Then move `jbx-front-door` to `jukebox-door` (no-op deploy proved by sha256).

**4. The three new repos onto jukebox-workers**
- All: replace the workflows with callers; drop `scripts/door`, `COPILOT.sha256`, `VENDORED.md`, `repo-vars.mjs` /
  `scripts/worker/vars.mjs` / the inline check; repo variables become `<DIR>_STAGING` / `<DIR>_LIVE`; environments
  renamed only if needed; `DOOR_SHARED_SECRET` → `DOOR_SECRET`; `/health`; tests into `tests/<dir>/`; `@jukebox/door-pass`
  replaces each repo's own copy; `ARCHITECTURE.md`, `RUNBOOK.md`, a CLAUDE.md carrying section 15; Project and
  jukebox-knowledge copies.
- analytics: `/healthz` → `/health`; `site/` → `workers/analytics/src/`; `INGEST_SECRET` → `PUSH_SECRET` with the shared
  signing format; `ENV` var kept or dropped; `docs/project/` stays (Project knowledge).
- inflow: `N8N_ORIGIN` → `N8N_BASE`; `/_health` → `/health`; `INFLOW_SYNC_SECRET` → `PUSH_SECRET`; `nodejs_compat` checked as
  needed; step 3 of its plan (settings tables and saves into D1) follows section 10.
- accounting: workflows renamed; `N8N_API_KEY` out of `accounting-staging`; `scripts/n8n/pull.mjs` and `drift.mjs` retired
  for the shared patcher and drift; rollout default `[50, 100]` (not `[25, 100]`).

**5. Copilot onto jukebox-workers**
- Per-Worker workflows → callers; `DOOR_SHARED_SECRET` in copilot-jobs → `DOOR_SECRET`; `/health` everywhere; the
  pipeline cleanup PR from the 2 Nov hand-off.

**6. Data out of n8n** (each per section 10)
- inflow settings + saves → D1; analytics `analytics_*` meta → D1 and computes to Worker crons; Copilot
  `csr_call_assist_config` / `app_config` → D1 with admin pages; Event Drain → Queue + `jbx-bq` (new, in
  jukebox-door), table by table.

**7. Sign-in off n8n (last)**
- Door exchange, Google client secret, allow-list, `dashboard_sessions`, Access Groups refresh → the front door + its D1.
