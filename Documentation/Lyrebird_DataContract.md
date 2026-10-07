# Lyrebird data contract and 10_DP input loading / validation

Status (2026-10-07):
- **Part 1 (input loading):** built and verified against Supabase and Orchestrator, including the production load into `Lyrebird_Validate` (§ 8, § 10).
- **Part 2 (validate performer):** built and verified end to end against Supabase, MusicBrainz and Orchestrator, including interrupted-run recovery with controlled failure injection (§ 11, § 10). A first production batch went through the standalone runner into `Lyrebird_Wishlist` (§ 12).
- The database migration for part 2 is **applied** (§ 7). The Orchestrator queues **exist** (§ 6).
- **Not** connected to `Main.xaml` / `Framework/Process.xaml`; that is step 3. Until then, items are processed only with the standalone runner `RunValidateBatch.xaml`. No queue triggers are enabled.

**Required build command** (the plain `uip rpa build .` reports the two accepted ST-SEC-009 findings, § 9):

```
uip rpa build . --governance-file-type AutomationOps --governance-file-path Governance/Lyrebird_10_DP.analyzer-policy.json --output json
```

**Outstanding limitations:**
- Every real album tested needs a person to set `chosen_release_id` once (§ 11.4); an automatic release rule is a product decision.
- A Validate item that exhausts its retries after claiming the album reservation leaves the reservation on a `new` row until it is resubmitted or cleared by hand (§ 11.5).
- The analyzer policy matches this Studio version's default rules; regenerate and re-verify it after a Studio or package upgrade (§ 9).
- Process 20 and later must follow the `Lyrebird_Wishlist` contract (§ 5) and release reservations; `download_attempts` DDL is still missing (§ 7).
- Step 3 (wiring into `Process.xaml`) is not done.

---

## 1. Files

| File | Purpose |
|---|---|
| `Workflows/Wishlist/LoadNewWishlistItems.xaml` | Input loader: reads `status = new` wishlist rows (via `GetRows.xaml`) and adds one item per row to `Lyrebird_Validate`. Read-only on Supabase. |
| `Workflows/Wishlist/BuildValidateQueueItem.xaml` | Pure function: wishlist row → Reference + specific content, or an "invalid" reason. |
| `Workflows/Wishlist/RunValidateBatch.xaml` | **Standalone runner** (until step 3): Get Transaction Item → `ProcessValidateQueueItem` → Set Transaction Status, for up to `in_MaxItems` (1..20) items or exactly one `in_Reference`. |
| `Workflows/Supabase/GetRows.xaml`, `UpdateRows.xaml` | Supabase helpers (PostgREST). ST-SEC-009 accepted risk (§ 9). |
| `Governance/Lyrebird_10_DP.analyzer-policy.json` | Versioned analyzer policy for the build, records the ST-SEC-009 exception (§ 9). |
| `Tests/BuildValidateQueueItemTestCase.xaml`, `LoadNewWishlistItemsDryRunTestCase.xaml` | Offline: payload construction, dry-run counters, duplicate in batch, invalid row, resubmission. |
| `Tests/SecureStringConversionGuardTestCase.xaml` | Offline: compensating control for the ST-SEC-009 exception (§ 9). |
| `Tests/LoadNewWishlistItemsIntegrationTestCase.xaml` | **Writes to Orchestrator** (`Lyrebird_Validate_IT`). Run manually only (§ 8). |

Part 2 files: § 11.1.

---

## 2. Loader: `LoadNewWishlistItems.xaml`

| Argument | Dir | Default | Meaning |
|---|---|---|---|
| `in_QueueName` | In | `Lyrebird_Validate` | Target queue. |
| `in_QueueFolder` | In | `Lyrebird` | Orchestrator folder of the queue. Empty = folder the job runs in. |
| `in_Query` | In | *(empty)* | PostgREST query. Empty = `select=*&status=eq.new&order=id.asc`. |
| `in_Rows` | In | *(Nothing)* | Rows to load instead of reading Supabase (tests, controlled manual loads). |
| `in_DryRun` | In | `False` | `True` = build and log every item, send **nothing** to Orchestrator. |
| `out_AddedCount` | Out | | Items **actually added**. Always 0 in a dry run. |
| `out_WouldAddCount` | Out | | **Dry run only**: items that would be sent. Not checked against the queue. |
| `out_AlreadyQueuedCount` | Out | | **Live run only**: confirmed duplicate references rejected by Orchestrator. |
| `out_DuplicateInBatchCount` | Out | | Same Reference earlier in the same batch. |
| `out_InvalidCount` | Out | | Row misses data the payload needs (Warn log with the reason). |
| `out_AddedReferences` | Out | | References actually added. Empty in a dry run. |
| `out_WouldAddReferences` | Out | | Dry run only: references that would be sent. |

Per row, exactly one outcome is logged: `ADDED`, `WOULD ADD (dry run, NOT sent)`, `SKIPPED (already in queue)`, `SKIPPED (duplicate in this batch)`, `SKIPPED (invalid)`, or `FAILED` (which stops the load).
The summary line is `Load wishlist finished … n ADDED, n already in queue (confirmed duplicate reference) …` (or `… DRY RUN finished …`).

The loader does **not** change `status`. A row stays `new` until the performer has processed it, so the loader keeps seeing it; the Reference makes that harmless (§ 3).

---

## 3. Duplicate handling

The queue Reference is **`WL-<wishlist id>-S<submission>`**, for example `WL-42-S1`. It contains no artist or album, so fixing a typo does not create a second item for the same row and submission.

1. **Orchestrator "Enforce unique references"** on every Lyrebird queue is the real guarantee. It is enforced on the server and works across robots and jobs.
2. **Duplicate in batch**: the same Reference twice in one load is added once.
3. **Confirmed duplicate rejection**: an Add Queue Item error is absorbed **only** when all of these are true:
   - the exception type is `UiPath.Core.Activities.OrchestratorHttpException`;
   - `StatusCode` = **409 Conflict**;
   - the message matches `duplicate reference` or `reference already exists` (case-insensitive).

   **Observed text (2026-10-07):** `Status code: 409 (Conflict). Orchestrator response: Error creating Transaction. Duplicate Reference. Error code: 1016`.

**Every other error is logged at Error with the item and rethrown**, so the job fails visibly. This includes a missing queue (observed: HTTP 404, `Error code: 1002`), 401/403, a 409 for any other reason, 5xx, timeouts, and non-HTTP exceptions. Rerunning after a failure is safe because already added items are then rejected as duplicates.

---

## 4. Resubmission contract

**Identity of a request = (wishlist id, submission).** The Reference is derived from it: `WL-<id>-S<submission>`. The column `submission` exists (default 1, `check (submission >= 1)`).

| Situation | Submission | Effect |
|---|---|---|
| Orchestrator auto-retry of a failed `Lyrebird_Validate` item | **unchanged** | The retry is in the same item's retry chain, with the same Reference. |
| Loader runs again (schedule, crash, partial load) | **unchanged** | Same Reference, so a confirmed duplicate: `already queued`, nothing added. |
| Performer re-executes a transaction | **unchanged** | The performer is idempotent (§ 11.5). |
| **Deliberate resubmission** by the owner (fixed spelling, release chosen, retry after `failed`, input edited) | **+1** | New Reference (`WL-42-S2`), so a new queue item. Old items stay in the queues as history and are ignored (§ 11.5). |

Rules:

- Only a **deliberate, human/operator action** increments `submission`. No process increments it.
- Deliberate resubmission = one update:
  ```sql
  update lyrebird.wishlist
  set status = 'new', submission = submission + 1, message = null
  where id = 42;
  ```
- To resolve `RELEASE_CHOICE` (§ 11.4), set the release in the same update:
  ```sql
  update lyrebird.wishlist
  set status = 'new', submission = submission + 1, chosen_release_id = '<release MBID from the message>'
  where id = 42;
  ```
- **Any edit of artist, album or preferred format must come with a resubmission.** An edit without one is detected (`updated_at` guard, § 11.5): nothing is overwritten, and the transaction fails as a Business exception asking for a resubmission.
- Setting `status = 'new'` **without** incrementing has no effect on the queue: the loader reports `already queued`.
- Deleting queue items is **not** part of this contract. Queue history stays intact.

---

## 5. Pipeline overview

```
wishlist (status new)
  -> [10_DP loader]    -> Lyrebird_Validate -> [10_DP performer: MusicBrainz]
  -> Lyrebird_Wishlist -> [20_PF_Download]  -> Lyrebird_Collect -> [30_PF_Collect]
  -> Lyrebird_Tag      -> [40_PF_Tag]       -> Lyrebird_Upload  -> [50_PF_Upload] -> library
```

### Wishlist status meanings (`lyrebird.wishlist.status`)

The database allows exactly: `new`, `check_spelling`, `not_found`, `queued`, `downloading`, `downloaded`, `tagged`, `uploaded`, `failed`. No other status is written.

| Status | Meaning | Set by | Next |
|---|---|---|---|
| `new` | Entered or resubmitted; not yet validated. The row may already be in `Lyrebird_Validate`. | user / resubmit | 10_DP |
| `check_spelling` | **Needs the user.** Either MusicBrainz returned candidates but not exactly one strong match (`message` holds the closest match), **or** the album is valid but no release could be chosen (`message` starts with `RELEASE_CHOICE:` and lists candidate release MBIDs). | 10_DP performer | user fixes or sets `chosen_release_id`, then resubmits (§ 4) |
| `not_found` | No release group found. **Needs the user.** | 10_DP performer | user fixes, then resubmits |
| `queued` | Validated; MB names/IDs, chosen release and track count stored; album reservation held; item in `Lyrebird_Wishlist`. | 10_DP performer | 20 |
| `downloading` | Download started; item in `Lyrebird_Collect`. | 20 | 30 |
| `downloaded` | Download complete and checked; item in `Lyrebird_Tag`. | 30 | 40 |
| `tagged` | Tagged into `Tagged\`; item in `Lyrebird_Upload`. | 40 | 50 |
| `uploaded` | On the server and verified. Final. | 50 | — |
| `failed` | A step gave up. `message` says which step and why. The 10_DP performer uses it for a duplicate album (`message` starts with `DUPLICATE:`). | any step | user resubmits or deletes the row |

`api_error` from `ValidateAlbum.xaml` is **not** a status: the performer throws a System exception so the queue retries with the same submission, and nothing is written. When the retries run out, the `Lyrebird_Validate` item is Failed (Application) and the row stays `new`.

Dedicated statuses `needs_release_choice` / `duplicate` remain an optional proposal (`Migration_Proposal_Part2.sql`).

### Wishlist columns used by the pipeline

| Column | Written by | Used by |
|---|---|---|
| `id`, `artist`, `album`, `preferred_format` | user | loader (payload), performer (source of truth for the input) |
| `status`, `message` | every step / user | everyone |
| `submission` | user (deliberate resubmit) | loader (Reference), performer (stale check, update guard) |
| `updated_at` | DB trigger `wishlist_set_updated_at` | performer: row version for the update guard (read as text: `row_version:updated_at::text`) |
| `mb_artist`, `mb_album` | 10_DP performer | 20, 40 |
| `mbid` | 10_DP performer: the release **group** (column comment says so) | duplicate check, 40 fallback |
| `mb_release_id` | 10_DP performer: the chosen **release** | 40 (Picard `openalbum?id=`) |
| `mb_artist_id` | 10_DP performer: first credited artist | 20/40 |
| `track_count` | 10_DP performer: total tracks of the chosen release | 30 (completeness) |
| `match_score` | 10_DP performer (validated albums) | reporting |
| `chosen_release_id` | **user**, to resolve `RELEASE_CHOICE` | performer (§ 11.4) |
| `reserved_release_group` | 10_DP performer: album reservation (unique when not null) | duplicate-album guard (§ 11.6) |

### Queue payloads (specific content)

Every queue carries `PayloadVersion` (Int32, currently 1), `WishlistId` (Int64) and `Submission` (Int32). Read numbers with `Convert.ToInt64(...)` / `Convert.ToInt32(...)`, because SpecificContent comes back as JSON.

**`Lyrebird_Validate`** (10_DP loader → 10_DP performer). Reference `WL-<id>-S<submission>`.

| Field | Type | Source |
|---|---|---|
| `PayloadVersion` | Int32 | `1` |
| `WishlistId` | Int64 | `wishlist.id` |
| `Artist`, `Album` | String | `wishlist.artist` / `album`, trimmed |
| `PreferredFormat` | String | `wishlist.preferred_format`, upper case: `FLAC` \| `MP3` \| `ANY` |
| `Submission` | Int32 | `wishlist.submission` |

**`Lyrebird_Wishlist`** (10_DP performer → 20). Reference `WL-<id>-S<submission>`.

| Field | Type | Source |
|---|---|---|
| `PayloadVersion` | Int32 | `1` |
| `WishlistId`, `Submission` | Int64, Int32 | from the Validate item |
| `Artist`, `Album` | String | **MusicBrainz** spelling (artist credit, release group title) |
| `PreferredFormat` | String | from the wishlist row, upper case |
| `MbReleaseGroupId` | String (UUID) | release **group** |
| `MbReleaseId` | String (UUID) | the chosen **release** (§ 11.4) |
| `MbArtistId` | String (UUID) | first credited artist |
| `TrackCount` | Int32 | total tracks of the chosen release |
| `RequestArtist`, `RequestAlbum`, `RequestPreferredFormat` | String | the wishlist **input** this item was made for (used by recovery, § 11.5) |

**Contract for 20 and later steps (not built yet):** act on a `Lyrebird_Wishlist` item only when the row has `status = 'queued'`, `submission` = the item's `Submission` and `mb_release_id` = the item's `MbReleaseId`. Otherwise the item is superseded and must be completed without action. A step that sets the row to `failed` must also set `reserved_release_group = null` (§ 11.6).

**`Lyrebird_Collect`**, **`Lyrebird_Tag`**, **`Lyrebird_Upload`** (20 → 30 → 40 → 50): *proposed*, Reference `WL-<id>-S<submission>-A<attempt id>`.
- Collect: `DownloadAttemptId`, `SoulseekUser`, `RemoteFolder`, `Format`, `TrackCount`, `DownloadStartedUtc`.
- Tag: `DownloadAttemptId`, `AlbumFolder`, `MbReleaseId`, `TrackCount`, `Format`.
- Upload: `TaggedFolder`, `FileCount`, `TotalBytes`.

Paths are always relative to the data root.

---

## 6. Orchestrator setup (created 2026-10-07)

All in the modern folder **`Lyrebird`**. No triggers on any of them: nothing consumes them automatically until step 3 / process 20.

| Queue | Enforce unique references | Auto retry | Max retries | Use |
|---|---|---|---|---|
| `Lyrebird_Validate` | Yes | Yes | 2 | production input of 10_DP |
| `Lyrebird_Wishlist` | Yes | Yes | 2 | production output of 10_DP, input of 20 |
| `Lyrebird_Validate_IT` | Yes | No | 0 | integration tests only |
| `Lyrebird_Wishlist_IT` | Yes | No | 0 | integration tests only |

Permissions used by the robot in folder `Lyrebird`: Queues View; Transactions View, Create, Edit (Set Transaction Status); Assets View. Assets View in folder `Shared` (`PersonalEmail`).

**Process log level**: keep the `Lyrebird_10_DP` process / robot logging at **Information** or lower, never Verbose/Trace (§ 9).

---

## 7. Database migration (applied 2026-10-07)

Exact applied script, versioned in this repository: **`Documentation/Migrations/2026-10-07_01_wishlist_part2.sql`** (identical content to `../Lyrebird_00_Shared/DB/migrations/2026-10-07_01_wishlist_part2.sql`, line endings aside; checked against the live schema on 2026-10-07). Additive only; do not run it again:

1. `submission integer not null default 1` + `check (submission >= 1)`. Every existing row got 1, the value the loader already used, so no Reference changed.
2. `mb_release_id uuid`, `mb_artist_id uuid`, `chosen_release_id uuid`, `reserved_release_group uuid` (all nullable).
3. Partial unique index `wishlist_reserved_release_group_uniq` on `reserved_release_group` where not null.
4. Column comments (`mbid` = release **group**, etc.) and `notify pgrst, 'reload schema'`.

Schema before: `../Lyrebird_00_Shared/DB/snapshots/2026-10-07_lyrebird_schema_before_part2.sql`. `../Lyrebird_00_Shared/DB/wishlist.sql` is refreshed from the live database (the previous copy is in `snapshots/`). Nothing was dropped or renamed.

Still missing: `download_attempts` DDL (20/30 need it) and a `process_log` design.

---

## 8. Integration tests

All integration tests use only the `_IT` queues and dedicated test rows (`message` starting with `LYREBIRD_IT`), and refuse the production queue names.

**Part 1: `Tests/LoadNewWishlistItemsIntegrationTestCase.xaml`.** Uses a synthetic row through `in_Rows` (Supabase not touched); the id is built from the UTC time, so every run has a new Reference.

| Step | Expected |
|---|---|
| 1. Live load of `WL-<ts>-S1` | `added 1` |
| 2. Same row again | `added 0`, `already queued 1` (409, error 1016, § 3) |
| 3. Load into a non-existent queue | `OrchestratorHttpException` 404 / 1002 reaches the test, **not** absorbed |

**Part 2, single run: `Tests/ProcessValidateQueueItemIntegrationTestCase.xaml`.** Confirmation `RUN-IT-WISHLIST-<id>`, `in_ExpectedOutcome`. Loads one test row into `Lyrebird_Validate_IT`, takes exactly that item, runs the performer, sets the transaction status, runs the performer again (must be `already_completed`, no second item) and checks the row and the `Lyrebird_Wishlist_IT` item.

**Part 2, scenarios: `Tests/ProcessValidateScenarioIntegrationTestCase.xaml`.** Confirmation `RUN-IT-SCENARIO-<scenario>-<id>`. Each scenario uses controlled failure injection (`in_FailAfterStep` of the performer, refused unless the output queue ends in `_IT`) or a controlled concurrent write, then runs the performer again and checks row, reservation and queue item:

| Scenario | What happens | Expected |
|---|---|---|
| `crash_after_reservation` | run 1 stops after claiming the reservation, before enqueue | run 2 enqueues once and persists `queued`; reservation held |
| `crash_after_enqueue` | run 1 stops after enqueue, before the final update | run 2 finds the item, rebuilds the result from it (no new MusicBrainz choice), persists `queued`; one item |
| `edit_after_enqueue` | crash after enqueue, then the album is edited without resubmission | run 2: `BusinessRuleException` ("edited after its … item was created"), nothing written, old item stays |
| `stale_submission` | the row is resubmitted while an old item is pending | old item: `stale_submission`, nothing written |
| `reservation_conflict` | another row holds the album reservation | `duplicate_release`: row `failed` + `DUPLICATE:`, no item, no reservation |
| `guard_miss_edit` | the row is edited while it is being validated | final guarded update hits 0 rows → `BusinessRuleException`, nothing overwritten |

Helper commands used (run from the project folder; `uip` from `%APPDATA%\npm`):

```
uip rpa run --file-path "Tests/ProcessValidateQueueItemIntegrationTestCase.xaml" --project-dir . \
  --input-arguments in_ValidateTestQueue=Lyrebird_Validate_IT --input-arguments in_WishlistTestQueue=Lyrebird_Wishlist_IT \
  --input-arguments in_QueueFolder=Lyrebird --input-arguments in_TestWishlistId:=<id> \
  --input-arguments in_Confirmation=RUN-IT-WISHLIST-<id> --input-arguments in_ExpectedOutcome=<outcome> --output json
```

Each run needs a fresh test row (or a resubmitted one), because a Reference can be used only once per queue.

---

## 9. Credential handling: ST-SEC-009 (accepted risk)

**Finding.** `GetRows.xaml` and `UpdateRows.xaml` read the Supabase key with Get Secret (SecureString) and build the `Headers` dictionary with `New NetworkCredential(String.Empty, ApiKey).Password`, which turns the key into a plain `System.String` for the `apikey` and `Authorization: Bearer` headers. Rule ST-SEC-009 (Error) reports this.

**Why there is no clean fix with the current activities.** Neither `NetHttpRequest` nor the legacy `HttpClient` accepts a SecureString for custom headers or bearer tokens (`UiPath.WebAPI.Activities` 2.5.2 is the newest version), and Supabase/PostgREST needs the key in those headers.

**Actual risk.**
- It is the `service_role` key: it bypasses RLS on the whole Supabase. Anyone holding it controls the database.
- The plain string can leak through Verbose/Trace robot logging (activity arguments), `SaveRawRequestResponse = True` (does not redact `apikey`), the debugger, and process memory / crash dumps.
- Bigger than the analyzer finding: `10_DP_SupabaseUrl` is `http://tower:8000`, so the key travels **unencrypted** over the LAN.

**Decision (2026-10-06, project owner): accept the risk explicitly.**

Mitigations in place:
- The conversion happens only inside the HTTP activity's `Headers` expression; no String variable holds the key. `SaveRawRequestResponse = False` on both activities; both carry an annotation pointing here.
- `Tests/SecureStringConversionGuardTestCase.xaml` fails if any workflow other than `GetRows.xaml` / `UpdateRows.xaml` converts a SecureString. The analyzer exclusion works per activity *type*, so this test keeps the exception limited to these two files.
- Robot log level **Information or lower**, never Verbose/Trace.

**Recording the exception: `Governance/Lyrebird_10_DP.analyzer-policy.json` (verified 2026-10-07).**

Build with:

```
uip rpa build . --governance-file-type AutomationOps --governance-file-path Governance/Lyrebird_10_DP.analyzer-policy.json --output json
```

- Format: the Automation Ops Studio-policy data format (`{"data": {"embedded-rules-config-rules": [...], "embedded-rules-config-counter": [...]}}`), which `uip rpa build` accepts as a local file with type `AutomationOps` (no download, no tenant policy involved).
- A governance policy **disables every rule it does not list**. The file therefore lists all 80 rules and 2 counters of this Studio version with their **default** enabled state and severity (parameters on their defaults). The only deviation is ST-SEC-009: still enabled at **Error**, parameter `Excluded = UiPath.Web.Activities.Http.NetHttpRequest`.
- Verification:
  - the analyzer messages with the policy are identical to the default analysis (148 messages) except the two accepted ST-SEC-009 findings (146 left, 0 errors);
  - negative test: a temporary workflow converting a SecureString in a Log Message still fails the build with ST-SEC-009 (Error); the probe was removed;
  - a canary (raising ST-NMG-004 to Error) proved the file is applied.
- Formats that do **not** work, for the record: type `Studio` with a Studio-style policy file is ignored by the CLI build (the default rules run), and type `Default` with any file runs no analysis at all. Neither is used.
- When Studio or an activity package is upgraded, regenerate the file from the new default rule set (rule list: `%LOCALAPPDATA%\UiPath\Rules\RuleConfig.json`, `DefaultIsEnabled` / `DefaultErrorLevel`) and repeat the comparison above.
- The plain `uip rpa build . --output json` (default rules) still fails with the two ST-SEC-009 findings; that is expected. Studio itself has the same exclusion in the machine-wide `%LOCALAPPDATA%\UiPath\Rules\RuleConfig.json` (set through Studio's Workflow Analyzer settings on 2026-10-07; machine-wide, not part of the project, and ignored by the CLI build).

Recommended risk reductions (not done): Supabase behind **HTTPS**; a JWT for a dedicated Postgres role limited to schema `lyrebird` instead of the `service_role` key; longer term a Kong route with Basic auth so the robot uses `BasicAuthSecurePassword`. Review this exception if any of these change or if `UiPath.WebAPI.Activities` adds SecureString headers.

---

## 10. Verification (2026-10-07)

| Check | Result |
|---|---|
| `uip rpa build .` with the policy file (§ 9) | **PASS**, 0 errors |
| Offline: `ParseValidatePayload` (5), `DecideRowAction` (14), `ChooseRelease` (11), `BuildValidationResult` (14) | PASS |
| Offline: `BuildValidateQueueItem`, `LoadNewWishlistItemsDryRun`, `SecureStringConversionGuard` (44 workflows; conversions only in the two accepted files) | PASS |
| Part 1 IT (§ 8) | PASS: add, confirmed 409 duplicate (1016), missing queue 404 (1002) surfaced |
| Part 2 single runs | PASS: `queued` (row 9 S2, idempotent rerun), `duplicate_release` (row 12), `needs_release_choice` (rows 9, 13, 15, 16, 17 first pass), `not_found` (row 20), `check_spelling` (row 21) |
| Part 2 scenarios | PASS: `crash_after_reservation` (row 15 S3), `crash_after_enqueue` (row 16 S2), `edit_after_enqueue` (row 17 S3), `stale_submission` (row 18), `reservation_conflict` (rows 13/14), `guard_miss_edit` (row 19) |
| Production load (§ 12) | 6 added; second load 0 added, 6 confirmed duplicates |
| Production batch (§ 12) | WL-1-S1 `check_spelling`, WL-4-S1 / WL-5-S1 `needs_release_choice`; WL-4-S2 (release chosen) `queued` → `Lyrebird_Wishlist`; rerun found no New item |
| MusicBrainz throttle | log shows `waiting … ms for the 1 request/second limit` between requests |

Found and fixed during testing: Orchestrator **Get Queue Items does not list an item immediately after it was added** (read-after-write delay). `FindQueueItemByReference` now waits (up to `in_WaitUntilFoundSeconds`), and a duplicate add always reads the existing item before anything is persisted (§ 11.5).

---

## 11. Part 2: validate performer (one `Lyrebird_Validate` item)

### 11.1 Files

| File | Kind | Purpose |
|---|---|---|
| `Workflows/Wishlist/ProcessValidateQueueItem.xaml` | orchestration | Processes one QueueItem end to end (§ 11.2). Invoked by `RunValidateBatch.xaml`, **not** by `Process.xaml` yet. |
| `Workflows/Wishlist/ParseValidatePayload.xaml` | pure | Payload validation, including Reference = `WL-<id>-S<submission>`. |
| `Workflows/Wishlist/DecideRowAction.xaml` | pure | Row decision (`process`, `already_completed`, `stale_submission`, `submission_ahead`, `missing_row`, `unexpected_status`); returns row version, reservation and `chosen_release_id`. |
| `Workflows/Wishlist/BuildValidationResult.xaml` | pure | Outcome, DB status, message, PATCH body (incl. reservation), `Lyrebird_Wishlist` payload. Throws a System exception for `api_error`. |
| `Workflows/Wishlist/ClassifyGuardMiss.xaml` | I/O | After a guarded update hit 0 rows: re-reads the row → `already_persisted`, `superseded`, or `BusinessRuleException` (edited meanwhile). |
| `Workflows/Wishlist/ReadExistingWishlistItem.xaml` | pure | Reads an existing `Lyrebird_Wishlist` item; `BusinessRuleException` if its `Request*` fields differ from the current row input. |
| `Workflows/MusicBrainz/ChooseRelease.xaml` | pure | Release-selection policy (§ 11.4). |
| `Workflows/MusicBrainz/GetReleaseGroupReleases.xaml` | I/O | All releases of a release group (100 per page, max 10 pages), throttled. |
| `Workflows/MusicBrainz/GetUserAgent.xaml` | I/O | User-Agent from assets (same rules as ValidateAlbum). |
| `Workflows/Orchestrator/FindQueueItemByReference.xaml` | I/O | Get Queue Items by exact Reference, all states; optional wait until visible. |
| `Workflows/Orchestrator/AddQueueItemIdempotent.xaml` | I/O | Add Queue Item; only a confirmed duplicate counts as `already_exists`. |
| `Tests/{ParseValidatePayload,DecideRowAction,ChooseRelease,BuildValidationResult}TestCase.xaml` + `Tests/Fixtures/*.json` | tests | Offline tests (44 cases). |
| `Tests/ProcessValidate{QueueItem,Scenario}IntegrationTestCase.xaml` | tests | Integration tests (§ 8). |

Reused: `ValidateAlbum.xaml`, `GetConnection.xaml`, `GetRows.xaml`, `UpdateRows.xaml`. No Invoke Code.

### 11.2 Operation order

1. **Parse the payload.** Invalid → `BusinessRuleException`, nothing written.
2. **Read the row** with `select=*,row_version:updated_at::text&id=eq.<id>` and decide:
   - `missing_row`, `submission_ahead`, `unexpected_status` → `BusinessRuleException`, nothing written.
   - `stale_submission` (the row has a newer submission) or `already_completed` (same submission, status no longer `new`) → done, nothing written.
   - `process` → continue. The **row** is the source of truth for artist, album and format.
3. **Recovery check:** if `Lyrebird_Wishlist` already holds `WL-<id>-S<n>`, an earlier attempt enqueued but did not finish. The result is rebuilt from **that item** (no new release choice), but only if its `Request*` fields equal the current row input; otherwise `BusinessRuleException` (§ 11.5).
4. **Validate:** GetUserAgent → ValidateAlbum (release group) → if validated: GetReleaseGroupReleases + ChooseRelease (§ 11.4) and the duplicate check against active rows (§ 11.6) → BuildValidationResult. `api_error` → System exception (retry), nothing written.
5. **Claim the album reservation** (outcome `queued` only): guarded PATCH `{"reserved_release_group": <group>}`. A unique violation → `duplicate_release`; 0 rows → the row changed meanwhile (§ 11.5).
6. **Enqueue** to `Lyrebird_Wishlist` (outcome `queued` only). A confirmed duplicate Reference → wait until the existing item is visible, then finish from its content (same check as step 3).
7. **Final guarded PATCH** with the result. 0 rows → ClassifyGuardMiss.

**Guard on every write:** `id=eq.<id>&status=eq.new&submission=eq.<n>&updated_at=eq.<row version>`, with `Prefer: return=representation`. Zero rows is never treated as success. The row version comes from the read in step 2 (and from the reservation PATCH's returned row afterwards).

Why reserve → enqueue → update: a crash between enqueue and update leaves the row `new` with an item; the next attempt finds the item (step 3) and finishes. In the other order a crash would leave a `queued` row without an item that nothing ever picks up.

### 11.3 Outcomes and error classes

| Outcome | Wishlist row | `Lyrebird_Wishlist` | Transaction status (runner) |
|---|---|---|---|
| `queued` | `queued` + mb_artist, mb_album, mbid, mb_release_id, mb_artist_id, match_score, track_count; reservation held | added | Successful |
| `needs_release_choice` | `check_spelling`, `RELEASE_CHOICE: …` + candidates; group metadata stored; reservation released | — | Successful |
| `duplicate_release` | `failed`, `DUPLICATE: same album as wishlist row N …`; reservation released | — | Successful |
| `check_spelling` / `not_found` | that status + message (suggestions are not written to the mb_* columns) | — | Successful |
| `already_completed`, `stale_submission`, `superseded` | unchanged | unchanged | Successful |
| invalid payload, missing row, submission ahead, unknown status, **row edited during or after processing** | unchanged | unchanged (an existing item stays) | Failed, Business (no retry) |
| MusicBrainz `api_error`, HTTP failures, Supabase non-2xx, Orchestrator error other than a confirmed duplicate, existing item not visible within 15 s | unchanged (a claimed reservation may stay, § 11.5) | unchanged | Failed, Application → **retry with the same submission** |

### 11.4 Release-selection policy (`ChooseRelease.xaml`)

The release **group** (the "album", `mbid`) and the **release** (one edition, `mb_release_id`) are kept apart everywhere.

1. If the row has `chosen_release_id`: use exactly that release if it belongs to the group (any status) and has a track count; otherwise ambiguous with a message saying why.
2. Otherwise fetch **all** releases of the group (incomplete list → ambiguous). Keep **Official** releases from the **earliest year**.
3. **Exactly one** release left with a track count > 0 → chosen. **Anything else → ambiguous** (`needs_release_choice`): no tie-breaker. The message lists up to 8 candidates (MBID, date, country, track count, disambiguation).

Observed with real data: every album tested (Mezzanine, Dummy, Discovery, Moon Safari, Homogenic, OK Computer, The Dark Side of the Moon) has 9–17 official releases in its original year, so **every real album needs a person to set `chosen_release_id` once**. Changing that needs an agreed automatic rule (for example preferred country/format); it is a product decision, not implemented.

### 11.5 Retry, recovery and concurrent edits

| Failure point | State left | Next attempt (same submission) |
|---|---|---|
| During MusicBrainz calls | row `new`, nothing written | validates again |
| After the reservation, before enqueue | row `new`, reservation held | validates again; reservation already held → enqueue → update |
| After enqueue, before the update | row `new`, item exists | finds the item, checks `Request*`, persists the item's content; one item |
| Update applied, response lost | row final | `already_completed` |
| Add failed (not a duplicate) | row `new` | System exception, retried |

**Edits.** Every write is guarded by the row version (`updated_at`). If the row was edited after it was read:
- with a resubmission (submission +1) → `stale_submission` / `superseded`, nothing written; the new submission is processed by its own item;
- without a resubmission → `BusinessRuleException`, nothing written: "edited while it was being validated … Resubmit".
- An existing `Lyrebird_Wishlist` item is never attached to edited input: its `Request*` fields must equal the current row (`edit_after_enqueue`).

Items left behind for an old submission or old input stay in `Lyrebird_Wishlist` as history; 20 ignores them (contract in § 5).

**Known limitation:** if a `Lyrebird_Validate` item fails for good (retries exhausted) after the reservation was claimed, the row stays `new` and keeps the reservation, so another row for the same album is reported as a duplicate. Resolve by resubmitting the row (its next processing claims or releases the reservation), or clear `reserved_release_group` by hand.

### 11.6 Different wishlist rows, same album

- **Early check** (no write): another row with the same `mbid` and status `queued`, `downloading`, `downloaded`, `tagged` or `uploaded` → `duplicate_release`.
- **Reservation (concurrency-safe):** before enqueueing, the row claims `reserved_release_group = <group>`. The partial unique index allows one holder per album, so two concurrent workers cannot both enqueue the same album. The loser gets HTTP 409 / `23505` on `wishlist_reserved_release_group_uniq` → `duplicate_release` (naming the holder).
- The reservation is kept while the row is `queued` and later; every other 10_DP outcome writes `reserved_release_group = null`. Later steps that set `failed` must release it too (§ 5).

### 11.7 MusicBrainz User-Agent and throttling

- **User-Agent:** `10_DP_MusicBrainzUserAgent` (folder Lyrebird; empty → exception) plus ` ( <PersonalEmail> )` (folder Shared; empty → Warn). Resolved once per item by GetUserAgent and used for every request.
- **Throttle:** every request waits until 1.1 s after `io_LastRequestUtc`, which is updated after every request (also on failure) and shared across calls and items (`RunValidateBatch` keeps it across the batch). The HTTP activity's own retries use the Basic policy (3 retries, 1100 ms or `Retry-After`). Verified in the run log.
- **Cost per album:** 1 search + ⌈releases / 100⌉ pages.

---

## 12. Production state after the first batch (2026-10-07)

What was done, in order:
1. Test rows that were still `new` or `queued` (9, 14, 15, 16, 17, 18, 19) were set to `failed` with `message = 'LYREBIRD_IT retired test row … Previous: …'` and their reservations released, so no test row can be loaded into production and no test row blocks a real album.
2. Loader live run: `WL-1-S1`, `WL-4-S1`, `WL-5-S1`, `WL-6-S1`, `WL-7-S1`, `WL-8-S1` added to `Lyrebird_Validate`. Second run: 0 added, 6 confirmed duplicates.
3. `RunValidateBatch` with `in_MaxItems = 3`:
   - `WL-1-S1` (Radiohed / Ok Computr) → `check_spelling` (closest: Radiohead – OK Computer);
   - `WL-4-S1` (Radiohead / OK Computer) → `needs_release_choice` (17 candidates);
   - `WL-5-S1` (Pink Floyd / The Dark Side of the Moon) → `needs_release_choice`.
4. Row 4 resolved as a person would (§ 4): `chosen_release_id = c7569949-0f67-4682-a0d8-75c4290c52dc` (Parlophone CDNODATA 02, 1997-06-16, EMI Swindon CD, 12 tracks), submission 2, status `new`. Loader added `WL-4-S2`; `RunValidateBatch in_Reference=WL-4-S2` → `queued`, item `WL-4-S2` in `Lyrebird_Wishlist` (New). A second run found no New item.

Left for later: `WL-6-S1`, `WL-7-S1`, `WL-8-S1` stay **New** in `Lyrebird_Validate` (rows 6, 7, 8 `new`). Rows 1 and 5 wait for the user (§ 4).

Run more items: `uip rpa run --file-path "Workflows/Wishlist/RunValidateBatch.xaml" --project-dir . --input-arguments in_MaxItems:=3 --output json` (or `in_Reference=WL-<id>-S<n>`).
