# Migration inventory: what still runs on n8n (4 Nov 2026, ~10:00 UTC)

This lists each active n8n workflow that still serves a page or holds data, grouped by the session that owns its move.
For each one it gives the `door_routes` row and mode, the next step, and the earliest retire date.

This repo is public, so there are no workflow or table ids, hostnames or addresses. Workflows go by their n8n names and
pages by their door paths. The owning repos and sessions hold the ids.

## How the dates are worked out

- PATTERN section 10:
  - **Page:** 3 weekdays of shadow with zero unexplained differences, then `live`. After one **clean week** at
    `live` (7 days with 5 weekdays, no rollback, no unexplained difference), unpublish the n8n workflow. Archive it a
    month later.
  - **Data table:** reads switch to D1 and the n8n table becomes a read-only mirror. Delete it after one clean week.
- "Live ≥" is the earliest a shadow row can go live if views start today (Wed 4 Nov): Wed, Thu, Fri, so **Fri 6 Nov**.
  "Retire ≥" is the earliest unpublish date. Archive is a month after that.
- Gate to live: the standing approval moves a shadow row live once `_same > 0` with no unexplained diff, which is
  sooner than section 10's 3 weekdays. The two differ (see "For Tyler"). The dates below follow section 10.
- Coverage: the n8n API returned 333 active workflows in three listings (by name A–Z, Z–A, and "WF-"). A workflow
  whose name falls between "UTIL…" and "WF-C…" and does not contain "WF-" could be missing.

## door_routes today (17 rows)

| # | Path | Binding | Mode | Since |
|---|---|---|---|---|
| 1 | /analytics/jbx-customer-ltv | ANALYTICS | live | 3 Nov 16:25 |
| 2 | /analytics/accounting/admin | ACCOUNTING | live (no n8n page) | 3 Nov |
| 3–5 | /analytics/jbx-customer-cohorts, -geography, jbx-proof-switches | ANALYTICS | live | 3 Nov 19:42 |
| 6 | /jbx-reorder | INFLOW | live | 4 Nov 07:08 |
| 7 | /jbx-reorder/set (GET+POST, fallback none) | INFLOW | live | 4 Nov 07:08; GET added 07:50 |
| 8–13 | /analytics/jbx-cutter-, press-, lamination-, narrow-web-scorecard, jbx-data-anomalies, jbx-rework-analysis | ANALYTICS | shadow | 4 Nov 03:55 |
| 14 | /jbx-incoming/activity | INFLOW | shadow | 4 Nov 06:06 |
| 15 | /jbx-price-history | ACCOUNTING | shadow | 4 Nov 07:27 (history_ready on 07:26) |
| 16–17 | /analytics/jbx-stack-watch, jbx-n8n-usage | ANALYTICS | shadow | 4 Nov 06:56 |

## Analytics session (jukebox-analytics: jbx-analytics v8, jbx-analytics-jobs v2)

| n8n workflow | Door path | Row / mode | Next step | Retire ≥ |
|---|---|---|---|---|
| WF-CX Customer LTV Page | /analytics/jbx-customer-ltv | 1 live | clean week | 10 Nov |
| WF-CX Customer Cohorts / Geography Page, WF-AX Proof Switches Page | as named | 3–5 live | clean week | 10 Nov |
| WF-CS Cutter Scorecard Page, WF-PL Press / Lamination / Narrow Web Scorecard Page, WF-AX Data Anomalies Page, WF-RW Rework Analysis Page | as named | 8–13 shadow | views; no compare yet | live ≥ 6 Nov, retire ≥ 13 Nov |
| WF-AX Stack Watch Page (+ Data sub) | /analytics/jbx-stack-watch | 16 shadow | views | live ≥ 6 Nov, retire ≥ 13 Nov |
| WF-AX n8n Usage Page (+ Data sub) | /analytics/jbx-n8n-usage | 17 shadow | views on v8 (client script fixed) | live ≥ 6 Nov, retire ≥ 13 Nov |
| WF-AX Analytics Hub | /analytics | none | needs a front-door prefix change (not approved) | not set |
| WF-RW Rework Pivot Page (+ Pivot API, Engine) | /analytics/jbx-rework-pivot | none | v8 hands `?op=` back (409); shadow row after the engine snapshot publishes (15:40 UTC run) | live ≥ 9 Nov |
| WF-CX CSR Workload Page (+ Page Data, Compute, Homebase Refresh) | /analytics/jbx-csr-workload | none | port plan (analytics #21) | not set |
| WF-RV Revenue / WF-RF Refund / WF-PP Prepress Pivot Page (+ API, Engine, Exec, AI, Reports) | /analytics/jbx-revenue-pivot, -refund-pivot, -prepress-pivot | none | port plan (live BigQuery reads through jbx-bq) | not set |
| WF-AC AI Token Cost Page (+ Data sub) | /analytics/jbx-api-cost | none | port plan (snapshot after the Sync) | not set |
| WF-AX Prepress Copilot Page (+ Data sub) | /analytics/jbx-prepress-copilot | none | port plan (fits the runner) | not set |
| WF-CX Call Assist Page, WF-CX CSR Guide Video | /analytics/jbx-call-assist, jbx-csr-guide-video | none | plan says leave with Copilot | not set |

**Computes that hold data.** These write cache tables in n8n: WF-CX Customer LTV / Cohort / Geography Compute,
WF-CS Cutter Scorecard Compute, WF-PL Press and Lamination Compute, WF-RW Rework and Reprint Compute, WF-PX Proof Switch
Compute, WF-AX n8n Usage Collect and WF-Stack Watch Collect.
- Ported in jbx-analytics-jobs v2 (the PrimeCenter job included), but they write only for jobs that `JOBS_WRITE` lists.
  That list is empty until a PR.
- Next step: shadow parity of each job's output against the n8n cache, then `JOBS_WRITE` by PR. Each n8n cache table
  goes one clean week after its job writes.

## Inflow session (jukebox-inflow: jbx-inflow v8, settings_store d1 since 4 Nov 07:07:54)

| n8n workflow | Door path | Row / mode | Next step | Retire ≥ |
|---|---|---|---|---|
| Reorder Settings (managers) | /jbx-reorder | 6 live | clean week from v8 (08:59 4 Nov; saves failed before it) | 11 Nov |
| Reorder Settings — Save | /jbx-reorder/set | 7 live | as above | 11 Nov |
| PO Activity (super admin) | /jbx-incoming/activity | 14 shadow | views | live ≥ 6 Nov, retire ≥ 13 Nov |
| Reorder Settings v2 (preview) | /jbx-reorder2 | none | port 1c; saves through /set | not set |
| Auto-Order Digest Report (page) | /jbx-incoming/digest | none | port 1b | not set |
| Review PO (page + send + cancel) | /jbx-incoming/po | none | port 1d; Send and Cancel become outbox rows | not set |
| Compliance Dashboard, Compliance & Counts Dashboard, Compliance Config Engine | /jbx-compliance and its save | none | port 1e | not set |
| Auto-Order Control Dashboard | its pages | none | port 1f (Tyler: keep and move) | not set |
| Incoming Supplies (managers), Incoming Receive (write) | /jbx-incoming… | none | not in the port order yet | not set |

**Settings tables.** The seven tables the Save writes are now mirrors that Inflow Outbox Drain keeps in step. They
can't go before the pages that still read them (v2 preview, Review PO) are ported. They also back Inflow's rollback.
Earliest: one clean week after the last reader moves.

**Other data in n8n.** Inflow's inventory, docs/2026-11-04-inflow-off-n8n.md in jukebox-inflow, lists it in three
groups:
- history tables to BigQuery (po_events, autoorder_audit, autoorder_run_log and others);
- inFlow mirrors (Delta Sync, Full Product Refresh, Usage Sync, Stock Exposure, Container Fill, Reorder State Snapshot);
- engines (Dispatcher, Single-Leg, Run Now, Weekly China, mail and alerts, Pair Sync, PO Auto-Assign).

None has a row yet; none can retire before its port.

## Accounting session (jukebox-accounting: jbx-accounting v10)

| n8n workflow | Door path | Row / mode | Next step | Retire ≥ |
|---|---|---|---|---|
| (none: Worker only) | /analytics/accounting/admin | 2 live | — | — |
| WF-4 Price Resolve, history lane | /jbx-price-history | 15 shadow | 3 weekdays of equal hashes (Accounting's own plan) | live ≥ 9 Nov (shadow started 07:27 Wed, so Thu, Fri, Mon), retire ≥ 16 Nov |
| WF-4 Price Resolve, other lanes | /jbx-price-resolve, /jbx-price-attachment | none | not started | not set |
| WF-3 Review Action Handler, WF-3d Reply Templates, WF-ST Review Page Core | review pages | none | not started | not set |
| WF-6 Router Dashboard, WF-RH Review Hub, WF-MB AP Match Board, WF-TRK Review Page | their pages | none | not started | not set |

**Router data.** WF-1 Accounting Intake and WF-1b … WF-7 still write the router tables in n8n. WF-ACC Data Mirror
(sub) signs the writes to jbx-accounting, but stays off until its target URL is set. Reads switch to D1 only after
that runs clean.

## Copilot session (jukebox-copilot: front door, copilot-suggest, copilot-jobs, copilot-actions)

Copilot doesn't use `door_routes`. The front door answers its own paths (door_reads switches), and the panel's
/analytics/csr-call-assist/* calls are answered at the edge or by n8n.

| n8n workflow | Door path | Today | Next step |
|---|---|---|---|
| WF-CSR Call Assist API (door) | /analytics/csr-call-assist (token, context, suggest, signed-in page) | suggest live to copilot-suggest; quote_in_play test since 08:41 | `suggest_quote_in_play` on after morning readings |
| WF-Copilot Desk, Inbox Queue, Open Promises, Playbooks, Knowledge Review, Team Rules, Simulator | /analytics/csr-call-assist/desk, queue, promises, playbooks, knowledge, rules, sim | n8n pages | Copilot's own plan |
| WF-Copilot Next Up, Reminders, Feedback, Customer Memory, Actions, Quote Panel, Wrap-up Panel | /aux actions | several answered at the edge (door_reads) | Copilot's own plan |

**Data.** Copilot holds the most n8n tables: csr_call_assist_config, prompts, KB, inbox queue, quote drafts, reminders,
memory, feedback, wrap-ups and caches. WF-Copilot Table Archive and Cross-Project Retention copy them to BigQuery, but
D1 is not their record yet. No retire date for any of them.

## Prepress (jukebox-prepress-watch: jbx-prepress-watch, PRs #1 and #2 open)

| n8n workflow | Door path / endpoint | Row / mode | Next step | Retire ≥ |
|---|---|---|---|---|
| PrimeCenter Watchdog — Heartbeat & Alerts, Purge Log, Ticket Log, Roundtrip Check | box webhooks | none (boxes post straight to the Worker) | merge #1–#2, shadow heartbeats, then the box switch | one clean week after the switch |
| PrimeCenter Chat Notify | n8n sends Chat | stays (glue) | — | — |
| WF-AX PrimeCenter Watchdog Page | /analytics/jbx-primecenter-watchdog | none | page port after D1 holds the data | not set |
| WF-Prepress Review, Shadow API, Outbox Drain | /analytics/jbx-prepress-review and its API | n8n (the door holds the plugin's outbox) | no session owns it yet | not set |

## No owner yet

These active workflows serve a page or keep their own data, and no session has them in a plan:
- Mac Bridge (file channel to the Switch server);
- PICA Log webhook (to a Sheet);
- Humi Time-Off Mirror / Employee Map ingest and Sheet Reader (humi tables);
- Printbeat sync, WF-PB Engine and rollups (printbeat tables);
- Equipment Auction Monitor;
- CN Warehouse ST/PO Alert;
- Area People Coverage Guard;
- Packaging Data Health Monitor;
- PO Email Routing (Forward, Full Auto Send);
- Doc Origin & Duplicate Guard;
- Sample Finder workflows (WF-SF …, partly on copilot-sample-match).

Most of them are glue (mail, Sheets, Chat) or mirrors that may stay. Each needs a one-line decision: stay as glue, or
move with an owner.

## For Tyler

1. **Gate to live for shadow rows.** The standing approval says `_same > 0` and no unexplained diff. PATTERN section
   10 says zero unexplained differences over 3 weekdays. Rows 1 and 3–5 went live on the standing approval. Which rule
   applies to rows 8–17?
2. **Hub /analytics.** It needs a front-door change: `DR_PREFIX_RE` accepts only `/analytics/<page>`. Approve a small
   door release for exactly `/analytics`?
3. **Owners** for the Prepress Review pages and the "No owner yet" list.
4. **Merges waiting:** front door v55 (jukebox-copilot #219), jukebox-workers v1.0.5 (#12), jukebox-prepress-watch #1
   and #2, analytics #21, copilot #220.
5. **jukebox-template:** a one-line fix for areas with a hyphen. The test signs with the hyphen; init.mjs drops it.
   Analytics found it, and it needs a session with access to that repo.
6. **Direct BigQuery keys.** PATTERN section 7 routes BigQuery reads and writes through `jbx-bq`. Two open PRs each add
   a `BQ_SA_JSON` instead:
   - copilot-suggest v8 (copilot #220) for a read;
   - copilot-jobs v6 (copilot #221) for `insertAll` writes.
   Approve them as time-boxed exceptions with a removal step, or ask for the jbx-bq path?

## PATTERN review of the open PRs (4 Nov 2026)

Posted as PR comments, real gaps only:

| PR | Result |
|---|---|
| jukebox-prepress-watch #1 | No blocking gap. `package.json` pins the pipeline at v1.0.0 while the workflows pin v1.0.4 (a local proof fails once #2's cron lands; CI is fine). |
| jukebox-prepress-watch #2 | Box keys aren't tied to their box's slot (the slot comes from the body's `host`). Fix before Tyler sets the box keys. Tests are missing for that and for `/heartbeat`'s time window. |
| jukebox-copilot #220 | A direct BigQuery key on copilot-suggest (item 6). Otherwise clean, and its tests pass. |
| jukebox-copilot #221 | Three problems: a removed cron is never taken off, a rollback keeps the cron, and the crons are listed in pipeline.json as well as the toml. It also adds a direct BigQuery write (item 6). Now a draft, being reworked onto v1.0.4's `triggers.mjs`. |
| jukebox-analytics #21 | The plan should state the section 10 gate, list the door rows it needs, and say how snapshot cadence diffs are kept out of shadow. |
