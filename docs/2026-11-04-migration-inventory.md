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

## Port briefs (unowned)

One brief per item above, plus the Prepress Review group, so owners can be set quickly. Read from the live nodes on
4 Nov 2026 (read-only). "Glue" means it may stay in n8n under PATTERN section 11. Size by node count: S under 15,
M 15–40, L over 40. Workers are named by section 4. The Sample Finder sub-tools (Prefetch, Code Match, Compare
Previews, Rank By Photo / Colour, Embed Lines, Files Tool, Working Dots) and Printbeat MCP Server were read from their
descriptions and callers only.

### 1. Mac Bridge (file up/down for the Switch server)
- **Does:** a text-file channel between Claude sessions and the Mac Switch server (the remote desktop clipboard doesn't sync).
- **Trigger:** two webhooks, POST up and GET down. No callers in n8n; nothing in n8n writes the "down" rows.
- **Data:** `mac_bridge_files` (any text pasted in or out).
- **Door path:** none.
- **Target:** retire, or a small R2-backed route on `jbx-prepress-watch` (jukebox-prepress-watch) if it's still needed.
- **Risk:** the shared secret is hard-coded in two Code nodes and passed in the query string, so it lands in
  execution logs and history. Anyone with it can read or plant files for the server. The table may hold pasted secrets.
- **Size:** S (9).

### 2. PICA Log Webhook → Google Sheet
- **Does:** appends prepress log rows from the PICA skill to the "PICA log v2" tab.
- **Trigger:** POST webhook with a header token (good). Called by the PICA skill sessions.
- **Data:** one Google Sheet tab; no n8n table.
- **Door path:** none.
- **Target:** glue (a Sheets append). Later the rows land in `jbx-prepress-watch` D1 and BigQuery through `jbx-bq`, and
  the Sheet becomes a copy.
- **Risk:** low. Writes only to the Sheet; a bad row is just a bad log line.
- **Size:** S (6).

### 3. Humi Time-Off Mirror / Employee Map ingest + Humi Sheet Reader
- **Does:** keeps a mirror of Humi time-off requests and an employee id → email map for the time-off compliance monitor.
- **Trigger:** two webhooks fed by Zapier, plus the Sheet Reader (its 15-min schedule is off; WF-Pulse Runner calls it).
- **Data:** writes `humi_timeoff_mirror` and `humi_employee_map`; the reader keeps its checkpoint in `compliance_config`
  and reads the Humi events Sheet.
- **Door path:** none.
- **Target:** first decide if it's needed. The readers it was built for, Time-Off Compliance Detector and Resolve &
  Promote, are inactive. If it's kept: a new `jukebox-people` (`jbx-people`) with D1 as the record.
- **Risk:** both ingest webhooks have no auth (only a random path), and they write staff names and emails. Two feeds
  (webhooks and Sheet) upsert the same rows.
- **Size:** M (19 over three workflows).

### 4. Printbeat sync + WF-PB Engine + rollups
- **Does:** pulls HP press job attempts, rolls them into sheets per day / press / stock / inFlow product, and serves
  them to a Printbeat MCP and to a stock-position lookup.
- **Trigger:** Printbeat 01:00, Attempts Poller 02:30, Rollup 03:00, Burn Rollup 03:15 (schedules). Engine, Position
  and Identity are webhooks. Printbeat MCP Server calls Engine; Attempts Poller calls Identity.
- **Data:** `printbeat`, `printbeat_poll_state`, `printbeat_attempts`, `printbeat_daily`, `printbeat_burn`,
  `printbeat_map`, `printbeat_config`. It also reads `inflow_usage_events` and `product_lookup`. Printbeat
  overwrites one Databricks bronze file each run. Identity reads prod MySQL.
- **Door path:** none.
- **Target:** jukebox-inflow, as `jbx-inflow-printbeat` (cron pull, D1, history to BigQuery). The burn feeds inventory.
  Retire one of the two HP pollers: they keep separate markers.
- **Risk:** the Engine webhook, the MCP endpoint and Position have no auth. Engine writes to the map and config are gated
  only by a token kept in `printbeat_config` and sent in the body. Identity uses a full-privilege prod MySQL login (it
  sets its session read-only). Rollup only works while n8n still holds about 9 days of executions. The Databricks
  overwrite loses history if nothing downstream reads it.
- **Size:** L (107 over eight workflows).

### 5. Equipment Auction Monitor
- **Does:** each day it scrapes two public equipment auction sites, matches lots to the equipment register, and emails a
  digest.
- **Trigger:** daily 06:15 PT. Firecrawl does the fetching; it calls no workflows.
- **Data:** reads `auction_sources`, `equipment_register_cache` and `app_config`; writes `auction_lots` and
  `auction_run_log`.
- **Door path:** none. The digest links to an "auction review" webhook page, but no active workflow serves it, so the
  link looks dead.
- **Target:** the scrape and email are glue. If lot history matters, `auction_lots` moves to a small D1 (a new
  `jukebox-equipment`, or retire).
- **Risk:** low. Read-only outside, plus one email. The recipient falls back to a hard-coded address when config is
  empty.
- **Size:** S (14).

### 6. CN Warehouse ST/PO Alert
- **Does:** a daily email listing new inFlow stock transfers and POs in or out of CN Warehouse.
- **Trigger:** daily 17:00 PT. It reads the inFlow API (vendors and the latest 100 STs and POs).
- **Data:** `cn_alert_state` (dedupe keys).
- **Door path:** none.
- **Target:** jukebox-inflow (`jbx-inflow` cron, reading its own mirrors). Only the email stays glue.
- **Risk:** low (read-only, one email). The recipients and the inFlow location ids are hard-coded in nodes, which breaks
  the "no hard-coded recipients or ids" rule. More than 100 new documents in a day would be missed.
- **Size:** S (9).

### 7. Area People Coverage Guard
- **Does:** a daily check that every area × location in the owner map has an active, reachable person.
- **Trigger:** daily 07:05 PT. Emails Tyler only when something breaks.
- **Data:** reads `area_people` and `alert_category_map`. Writes nothing.
- **Door path:** none.
- **Target:** whoever owns `area_people`. Inflow's alerts, the duplicate guard and the health monitor all read it, so
  jukebox-inflow. It becomes a check in the `jbx-inflow` cron once the table is in D1.
- **Risk:** low (read-only). The recipient and the location list are hard-coded.
- **Size:** S (8).

### 8. Packaging Data Health Monitor
- **Does:** nine daily guards on packaging inventory data. Guard 9 queues catch-up pull requests to location managers.
- **Trigger:** daily 05:15 PT. Calls a products sub-workflow, then the digest queue for the 07:00 digest.
- **Data:** reads the inFlow API, `inflow_stock_exposure`, `autoorder_state`, `Auto-Order Category Registry`,
  `data_health_config`, `inflow_sa_mirror`, `inflow_st_mirror`, `inflow_usage_events`, `product_lookup`, `app_config`
  and `area_people`. Writes `data_health_snapshot` and `catch_up_pulls`.
- **Door path:** none.
- **Target:** jukebox-inflow (`jbx-inflow` cron, reading D1 mirrors as they move). The email stays glue.
- **Risk:** medium. It writes no inFlow documents, but guard 9 sends requests to managers through the digest. The alert
  recipient is hard-coded.
- **Size:** M (33).

### 9. PO Email Routing (Forward, Full Auto Send)
- **Does:** Full Auto Send emails engine-created inFlow POs, with a PDF built in the node, to vendors and internal
  owners. Review PO also calls it for hand sends. Forward copies BCC'd human POs to internal owners.
- **Trigger:** Full Auto Send runs every 15 min, and Review PO calls it. Forward is a Gmail trigger on Tyler's inbox. Its
  own note says it has had no runs since August, so it is likely dead.
- **Data:** reads `po_email_routing`, `area_people`, `alert_category_map`, `category_lookup`,
  `Auto-Order Category Registry` and `app_config`. Writes `po_sent_log`, `po_review` and `po_events`.
- **Door path:** none (Review PO's /jbx-incoming/po calls it).
- **Target:** jukebox-inflow, with Review PO (port 1d: Send and Cancel become outbox rows). D1 holds the send decision and
  the log; the Gmail send stays glue.
- **Risk:** the highest on this list. It sends external email to vendors. The mode is hard-coded `live` in a Code node,
  with no config switch, and the only dedupe is `po_sent_log`. A wrong routing row sends a PO to the wrong vendor.
- **Size:** L (38 over two workflows).

### 10. Doc Origin & Duplicate Guard
- **Does:** records who created each inFlow ST or PO the first time it sees one, emails when duplicate documents appear,
  and can cancel copies of engine-made documents.
- **Trigger:** an inFlow event webhook, plus a sweep from WF-Pulse Runner (its own hourly schedule is off).
- **Data:** reads the inFlow API, `inflow_st_mirror`, `inflow_po_mirror`, `inflow_sync_watermarks`, `app_config` and
  `area_people`. Writes `doc_origin` and `doc_dup_alerts`.
- **Door path:** none.
- **Target:** jukebox-inflow (`jbx-inflow` webhook + cron). Cancels go through the inFlow outbox, and the email stays
  glue.
- **Risk:** it writes to inFlow: it sets isCancelled on copies when `dup_doc_guard_auto_cancel` is on, with a per-run
  cap. The webhook has no auth. The body is ignored, so a caller can only start a sweep, but that costs inFlow rate limit.
- **Size:** M (26).

### 11. Sample Finder (WF-SF …)
- **Does:** a Google Chat bot that finds which order a photographed sample came from. It uses AI and image
  fingerprints, and reads the prod database.
- **Trigger:** the Chat Bot webhook (it checks the Google token and the sender's domain). Chat Handoff takes signed
  posts from copilot-sample-match. Image Index, File Mirror and Customer Mirror run on schedules. About a dozen sub-tools
  are called by the Agent.
- **Data:** `sf_config`, `sf_chat_turns`, `sf_lookups`, `sf_dots_stop` and `sf_match_shadow`. BigQuery gets customer
  and file-name copies, the fingerprint table and the colour cache. Staff photos are saved to Drive.
- **Door path:** none. Chat Avatar serves two public images.
- **Target:** jukebox-copilot, inside `jbx-copilot-sample-match` (it already answers /chat and /files). The AI agent
  moves last, under ai-eval-protocol.
- **Risk:** every prod read uses the full-privilege MySQL login that is labelled "do not use". Customer emails and names
  are copied into BigQuery. The webhooks themselves are verified.
- **Size:** L (around 200 over 16 active workflows; Agent 51, Chat Bot 40).

### 12. WF-Prepress Review, Shadow API, Outbox Drain (+ Outbox Write (sub), Cache Keep-warm)
- **Does:** the Prepress Copilot back end: Claude reviews one order at a time, the review page shows cards and labels,
  and plugin outbox items are written to tables, Drive and the Copilot log.
- **Trigger:** door webhooks for /analytics/jbx-prepress-review (page, /api, /img) and /analytics/prepress-shadow/api.
  Outbox Drain and Keep-warm run from WF-Pulse Runner. Both the Shadow API batch route and the Drain call Outbox Write.
- **Data:** `prepress_shadow_config`, `prepress_shadow_prompts`, `prepress_shadow_reviews`, `prepress_cards`,
  `prepress_card_labels`, `prepress_card_evidence`, `n8n_run_ledger`, `app_config` and `csr_call_assist_config` (prices).
  Writes the Copilot log tab of the PICA Sheet and card images in Drive. The door's KV holds the outbox.
- **Door path:** /analytics/jbx-prepress-review and /analytics/prepress-shadow/api (no `door_routes` row). The Drain
  pulls from the door's prepress outbox edge route.
- **Target:** jukebox-prepress-watch, as a new `jbx-prepress-review` (D1 for cards, reviews and config; R2 for images).
  Claude calls move under ai-eval-protocol. Keep-warm becomes a cron or is dropped.
- **Risk:** the gates check the door pass, and the Drain signs its calls to the door (good). It writes only its own
  tables and Sheet; the site stays read-only. The Drain wrote some log rows twice on 29–30 Oct (now locked and
  deduped). Keep-warm spends on Claude around the clock while it is on.
- **Size:** L (124 over five workflows).

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
