# Lyrebird data contract and 10_DP input loading / validation

Status (2026-10-07, after the development reset, § 12):
- **Part 1 (input loading):** built and verified against Supabase and Orchestrator (§ 8, § 10).
- **Part 2 (validate performer):** built and verified end to end against Supabase, MusicBrainz and Orchestrator, including interrupted-run recovery with controlled failure injection (§ 11, § 10).
- **Readable queue references** `<artist> - <album> | WL-<id>-S<submission>`, persisted once per submission (§ 3): built and verified.
- Database migrations `2026-10-07_01` and `2026-10-07_02` are **applied** (§ 7). The Orchestrator queues **exist** (§ 6).
- Development data was **reset** (§ 12): all four queues have no active items, the six original wishlist rows are `new`, submission 1, without generated data. Nothing has been loaded since.
- **Step 3 (REFramework):** `Main.xaml` loads new rows once per job and processes `Lyrebird_Validate` through `Framework/Process.xaml` (§ 13). `RunValidateBatch.xaml` stays as a manual tool. No queue triggers are enabled.

**Required build command** (the plain `uip rpa build .` reports the two accepted ST-SEC-009 findings, § 9):

```
uip rpa build . --governance-file-type AutomationOps --governance-file-path Governance/Lyrebird_10_DP.analyzer-policy.json --output json
```

**Outstanding limitations:**
- Every real album tested needs a person to set `chosen_release_id` once (§ 11.4); an automatic release rule is a product decision.
- A Validate item that exhausts its retries after claiming the album reservation leaves the reservation on a `new` row until it is resubmitted or cleared by hand (§ 11.5).
- The analyzer policy matches this Studio version's default rules; regenerate and re-verify it after a Studio or package upgrade (§ 9).
- Process 20 and later must follow the `Lyrebird_Wishlist` contract (§ 5) and release reservations; `download_attempts` DDL is still missing (§ 7).
- Orchestrator keeps deleted queue items as `Deleted` records; the reset could not remove that history (§ 12).
- A reference is fixed per submission: correcting a name without a resubmission keeps the old names in the reference (by design, § 3).
- A job that is killed in the middle of a transaction leaves that item In Progress; Orchestrator abandons it after 24 h and does **not** retry it (the queues have `RetryAbandonedItems = No`). The row then stays `new` and the loader reports it as already queued. Resolve by resubmitting the row (submission + 1). Graceful stops (Orchestrator Stop, `in_MaxTransactions`) happen between transactions and are not affected.
- The Orchestrator Stop signal itself was not exercised in the local tests (it needs a published process); the same code path is covered by `in_MaxTransactions`.

---

## 1. Files

| File | Purpose |
|---|---|
| `Workflows/Wishlist/LoadNewWishlistItems.xaml` | Input loader: reads `status = new` wishlist rows (via `GetRows.xaml`), persists the queue Reference of a new submission, and adds one item per row to `Lyrebird_Validate`. Writes only `queue_reference` to Supabase. |
| `Workflows/Wishlist/BuildValidateQueueItem.xaml` | Pure function: wishlist row → Reference (stored or newly built) + specific content, or an "invalid" reason. |
| `Workflows/Wishlist/BuildQueueReference.xaml` | Pure function: the readable Reference rules (§ 3). |
| `Workflows/Wishlist/PersistQueueReference.xaml` | Guarded PATCH that stores `queue_reference` once per submission (§ 3). |
| `Workflows/Wishlist/RunValidateBatch.xaml` | **Manual runner** (Main.xaml is the normal way since step 3, § 13): Get Transaction Item → `ProcessValidateQueueItem` → Set Transaction Status, for up to `in_MaxItems` (1..20) items or exactly one `in_Reference`. |
| `Workflows/Supabase/GetRows.xaml`, `UpdateRows.xaml` | Supabase helpers (PostgREST). ST-SEC-009 accepted risk (§ 9). |
| `Governance/Lyrebird_10_DP.analyzer-policy.json` | Versioned analyzer policy for the build, records the ST-SEC-009 exception (§ 9). |
| `Tests/BuildValidateQueueItemTestCase.xaml`, `LoadNewWishlistItemsDryRunTestCase.xaml` | Offline: payload construction, dry-run counters, duplicate in batch, invalid row, resubmission, reuse of a stored reference. |
| `Tests/BuildQueueReferenceTestCase.xaml` + `Tests/Fixtures/BuildQueueReferenceCases.json` | Offline: the Reference rules (12 cases). |
| `Tests/QueueReferenceIntegrationTestCase.xaml`, `Tests/QueueReferenceLookupIntegrationTestCase.xaml` + `Tests/Fixtures/QueueReferenceLookupCases.json` | **Write to the `_IT` queue** (and one test row): persistence and reuse of the Reference; awkward characters with Add / Get Queue Items / Get Transaction Item (§ 8). |
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
| `in_DryRun` | In | `False` | `True` = build and log every item, send **nothing** to Orchestrator and store **no** Reference. |
| `in_PersistReferences` | In | `True` | Store a new Reference on the row before enqueueing. `False` only for synthetic `in_Rows` in tests (the rows don't exist in Supabase). |
| `out_ChangedCount` | Out | | **Live run only**: rows skipped because they changed (status, submission, deleted) while their Reference was being stored. |
| `out_AddedCount` | Out | | Items **actually added**. Always 0 in a dry run. |
| `out_WouldAddCount` | Out | | **Dry run only**: items that would be sent. Not checked against the queue. |
| `out_AlreadyQueuedCount` | Out | | **Live run only**: confirmed duplicate references rejected by Orchestrator. |
| `out_DuplicateInBatchCount` | Out | | Same Reference earlier in the same batch. |
| `out_InvalidCount` | Out | | Row misses data the payload needs (Warn log with the reason). |
| `out_AddedReferences` | Out | | References actually added. Empty in a dry run. |
| `out_WouldAddReferences` | Out | | Dry run only: references that would be sent. |

Per row, exactly one outcome is logged: `ADDED`, `WOULD ADD (dry run, NOT sent)`, `SKIPPED (already in queue)`, `SKIPPED (duplicate in this batch)`, `SKIPPED (invalid)`, `SKIPPED (row changed while storing its Reference)`, or `FAILED` (which stops the load).
The summary line is `Load wishlist finished … n ADDED, n already in queue (confirmed duplicate reference) …, n changed while loading` (or `… DRY RUN finished …`).

The loader does **not** change `status`; it only writes `queue_reference` (§ 3). A row stays `new` until the performer has processed it, so the loader keeps seeing it; the stored Reference makes that harmless.

---

## 3. Queue Reference and duplicate handling

### Format

**`<artist> - <album> | WL-<wishlist id>-S<submission>`**, for example `Björk - Homogenic | WL-17-S3`. The same Reference is used for the `Lyrebird_Validate` item and the `Lyrebird_Wishlist` item of that submission. `WishlistId` and `Submission` stay separate payload fields; nothing parses the Reference.

Rules (`BuildQueueReference.xaml`):
- the artist and album **as entered on the row** (not the MusicBrainz spelling);
- control characters and runs of whitespace become one space; names are trimmed;
- `|` in a name becomes `/`, so ` | WL-` only ever appears as the suffix;
- the ASCII apostrophe `'` becomes `’`: the Get Queue Items and Get Transaction Item activities put the Reference into an OData filter **without escaping** it, and `Guns N' Roses` breaks that query (`Syntax error at position …`, verified 2026-10-07);
- at most **128** characters (UTF-16 units). The ` | WL-<id>-S<n>` suffix is never shortened; when needed the names part is cut (never inside a surrogate pair) and ends with `…`.

Verified Orchestrator restrictions (2026-10-07, `Lyrebird_Validate_IT`): 129 characters or more → HTTP 400 `The field Reference must be a string with a maximum length of 128`; uniqueness is **case-insensitive** (an upper-case copy got 409 Duplicate Reference); leading whitespace is trimmed by the server; Unicode, CJK, emoji, `& % # ? + / \ " < > * : ; = [ ] { } ~ ^ ` @ $ « » – … ’` are stored unchanged and can be found with both lookup activities (`QueueReferenceLookupIntegrationTestCase`, 10 cases).

### Persisted once per submission

1. The loader builds the Reference. If the row already holds a `queue_reference` ending with ` | WL-<id>-S<current submission>`, that one is **reused unchanged**, even if the names were corrected since.
2. Otherwise the loader stores the new Reference on the row **before** adding the item (`PersistQueueReference.xaml`), with a guarded PATCH: `id`, `status=new`, `submission=<n>` and `queue_reference` empty or belonging to another submission. A Reference that belongs to the current submission is therefore never replaced, and two loaders cannot store two different References for one submission (the second one re-reads and uses the stored Reference). If the row changed meanwhile, nothing is enqueued (`SKIPPED (row changed …)`).
3. The performer requires the item's Reference to equal the row's `queue_reference` (otherwise `BusinessRuleException`, nothing written) and uses it for recovery lookups and for the `Lyrebird_Wishlist` item.

So retries, reloads and recovery always use the same Reference; correcting a name without a resubmission keeps the old names in the Reference (the payload and the row carry the current names).

### Duplicate handling

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

**Identity of a request = (wishlist id, submission).** The Reference ends with it: `… | WL-<id>-S<submission>` (§ 3). The column `submission` exists (default 1, `check (submission >= 1)`).

| Situation | Submission | Effect |
|---|---|---|
| Orchestrator auto-retry of a failed `Lyrebird_Validate` item | **unchanged** | The retry is in the same item's retry chain, with the same Reference. |
| Loader runs again (schedule, crash, partial load) | **unchanged** | Same Reference, so a confirmed duplicate: `already queued`, nothing added. |
| Performer re-executes a transaction | **unchanged** | The performer is idempotent (§ 11.5). |
| **Deliberate resubmission** by the owner (fixed spelling, release chosen, retry after `failed`, input edited) | **+1** | New Reference with the current names (`Radiohead - OK Computer \| WL-42-S2`), stored on the row by the next load, so a new queue item. Old items stay in the queues as history and are ignored (§ 11.5). |

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
- Setting `status = 'new'` **without** incrementing has no effect on the queue: the loader reuses the stored Reference and reports `already queued`.
- Never edit `queue_reference` by hand; a resubmission replaces it automatically.
- Deleting queue items is **not** part of this contract. Queue history stays intact (the development reset in § 12 was a one-off, authorized exception).

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
| `queue_reference` | 10_DP loader, once per submission (max 128) | loader (reuse), performer (must equal the item's Reference; recovery; `Lyrebird_Wishlist` item) (§ 3) |

### Queue payloads (specific content)

Every queue carries `PayloadVersion` (Int32, currently 1), `WishlistId` (Int64) and `Submission` (Int32). Read numbers with `Convert.ToInt64(...)` / `Convert.ToInt32(...)`, because SpecificContent comes back as JSON.

**`Lyrebird_Validate`** (10_DP loader → 10_DP performer). Reference = the row's `queue_reference` (§ 3).

| Field | Type | Source |
|---|---|---|
| `PayloadVersion` | Int32 | `1` |
| `WishlistId` | Int64 | `wishlist.id` |
| `Artist`, `Album` | String | `wishlist.artist` / `album`, trimmed |
| `PreferredFormat` | String | `wishlist.preferred_format`, upper case: `FLAC` \| `MP3` \| `ANY` |
| `Submission` | Int32 | `wishlist.submission` |

**`Lyrebird_Wishlist`** (10_DP performer → 20). The same Reference as the Validate item (the row's `queue_reference`).

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

**`Lyrebird_Collect`**, **`Lyrebird_Tag`**, **`Lyrebird_Upload`** (20 → 30 → 40 → 50): *proposed*, Reference `<queue_reference>-A<attempt id>` (keep it within 128 characters; not designed yet).
- Collect: `DownloadAttemptId`, `SoulseekUser`, `RemoteFolder`, `Format`, `TrackCount`, `DownloadStartedUtc`.
- Tag: `DownloadAttemptId`, `AlbumFolder`, `MbReleaseId`, `TrackCount`, `Format`.
- Upload: `TaggedFolder`, `FileCount`, `TotalBytes`.

Paths are always relative to the data root.

---

## 6. Orchestrator setup (created 2026-10-07)

All in the modern folder **`Lyrebird`**. No triggers on any of them: `Main.xaml` (§ 13) runs only when started by hand or by a job; process 20 is not built.

| Queue | Enforce unique references | Auto retry | Max retries | Use |
|---|---|---|---|---|
| `Lyrebird_Validate` | Yes | Yes | 2 | production input of 10_DP |
| `Lyrebird_Wishlist` | Yes | Yes | 2 | production output of 10_DP, input of 20 |
| `Lyrebird_Validate_IT` | Yes | No | 0 | integration tests only |
| `Lyrebird_Wishlist_IT` | Yes | No | 0 | integration tests only |
| `Lyrebird_Validate_Main_IT` | Yes | Yes | 2 | Main.xaml integration tests only (same retry settings as production; created 2026-10-07, step 3) |
| `Lyrebird_Wishlist_Main_IT` | Yes | Yes | 2 | Main.xaml integration tests only |

Permissions used by the robot in folder `Lyrebird`: Queues View; Transactions View, Create, Edit (Set Transaction Status); Assets View. Assets View in folder `Shared` (`PersonalEmail`).

**Process log level**: keep the `Lyrebird_10_DP` process / robot logging at **Information** or lower, never Verbose/Trace (§ 9).

---

## 7. Database migrations (applied 2026-10-07)

### 2026-10-07_02: queue reference

**`Documentation/Migrations/2026-10-07_02_wishlist_queue_reference.sql`** (identical content to `../Lyrebird_00_Shared/DB/migrations/2026-10-07_02_wishlist_queue_reference.sql`). Additive only: column `queue_reference text null`, `check (queue_reference is null or char_length(queue_reference) between 1 and 128)`, column comment, `notify pgrst`. Schema before: `../Lyrebird_00_Shared/DB/snapshots/2026-10-07_wishlist_before_queue_reference.sql`; `wishlist.sql` updated and checked against `pg_dump`. The check deliberately does not involve `submission`, so a resubmission never fails because of an old Reference.

### 2026-10-07_01: part 2

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
| 1. Live load of `Lyrebird Integration Test - Synthetic <ts> \| WL-<ts>-S1` (`in_PersistReferences = False`) | `added 1` |
| 2. Same row again | `added 0`, `already queued 1` (409, error 1016, § 3) |
| 3. Load into a non-existent queue | `OrchestratorHttpException` 404 / 1002 reaches the test, **not** absorbed |

**Reference: `Tests/QueueReferenceIntegrationTestCase.xaml`.** Confirmation `RUN-IT-REFERENCE-<id>`; needs a fresh test row (status `new`, `LYREBIRD_IT` message, no `queue_reference`), ideally with awkward and long names. No MusicBrainz, no performer.

| Step | Expected |
|---|---|
| 1. Load the row | `added 1`; `queue_reference` = `BuildQueueReference` of the row, ≤ 128, ends with ` \| WL-<id>-S<n>`; Get Queue Items finds exactly that item; `WishlistId` / `Submission` payload fields correct |
| 2. Correct the album **without** resubmission, load again | `added 0`, `already queued 1`; `queue_reference` unchanged |
| 3. Resubmit (submission + 1), load again | `added 1`; new Reference with the corrected album and `S<n+1>`, found in the queue |

**Reference lookup: `Tests/QueueReferenceLookupIntegrationTestCase.xaml`.** Confirmation `RUN-IT-REFERENCE-LOOKUP`; synthetic ids, no wishlist rows. For each name pair in `Tests/Fixtures/QueueReferenceLookupCases.json` it builds the Reference, adds an item, finds it with Get Queue Items (recovery path) and takes it with Get Transaction Item by Reference (runner path), then sets it Successful.

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

Each run needs a fresh test row (or a resubmitted one), because a Reference can be used only once per queue. For References with non-ASCII characters (for example `RunValidateBatch in_Reference`), pass the arguments with `--input-arguments-file <json>`.

After a test run, remove what it created (§ 12 shows how): delete the test items in the `_IT` queues and the `LYREBIRD_IT` rows; deleting a row also releases its album reservation.

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

## 10. Verification (2026-10-07, after the reference change)

| Check | Result |
|---|---|
| `uip rpa validate --project-dir .` | 0 diagnostics |
| `uip rpa build .` with the policy file (§ 9) | **PASS**, 0 errors |
| Offline: `BuildQueueReference` (12), `ParseValidatePayload` (9), `DecideRowAction` (14), `ChooseRelease` (11), `BuildValidationResult` (17) | PASS (63 cases) |
| Offline: `BuildValidateQueueItem` (5 checks), `LoadNewWishlistItemsDryRun` (3 checks, incl. reuse of a stored reference), `SecureStringConversionGuard` (49 workflows; conversions only in the two accepted files) | PASS |
| Reference restrictions probe (CLI, `Lyrebird_Validate_IT`) | 128 accepted, 129 → HTTP 400; case-insensitive uniqueness; server trims leading spaces; special characters stored unchanged (§ 3) |
| `QueueReferenceLookupIntegrationTestCase` | PASS, 10/10 References added, found (Get Queue Items) and taken (Get Transaction Item) |
| `QueueReferenceIntegrationTestCase` (row 35) | PASS: 127-character shortened Reference persisted before enqueue; corrected album kept it (0 added, 1 already queued); resubmission → new `S2` Reference |
| Part 1 IT | PASS: readable synthetic Reference added, confirmed 409 duplicate, missing queue 404 (1002) surfaced |
| Part 2 single runs | PASS, each with an idempotent second run: `queued` (row 23), `duplicate_release` (row 24), `not_found` (row 25), `check_spelling` (row 26), `needs_release_choice` (row 27) |
| Part 2 scenarios | PASS: `crash_after_reservation` (row 28), `crash_after_enqueue` (row 29, recovered through the readable Reference), `edit_after_enqueue` (row 30), `stale_submission` (row 31), `reservation_conflict` (rows 32/33), `guard_miss_edit` (row 34) |
| Reference mismatch guard (row 35, `queue_reference` changed by SQL, `RunValidateBatch` on the `_IT` queues) | Failed (Business): "the wishlist row holds queue_reference …"; nothing written |

Found and fixed during testing:
- Orchestrator **Get Queue Items does not list an item immediately after it was added** (read-after-write delay). `FindQueueItemByReference` waits (up to `in_WaitUntilFoundSeconds`), and a duplicate add always reads the existing item before anything is persisted (§ 11.5).
- **Get Queue Items / Get Transaction Item do not escape `'`** in their Reference filter (OData syntax error). References replace `'` with `’` (§ 3).

All test rows and items were removed afterwards (§ 12).

---

## 11. Part 2: validate performer (one `Lyrebird_Validate` item)

### 11.1 Files

| File | Kind | Purpose |
|---|---|---|
| `Workflows/Wishlist/ProcessValidateQueueItem.xaml` | orchestration | Processes one QueueItem end to end (§ 11.2). Invoked by `RunValidateBatch.xaml`, **not** by `Process.xaml` yet. |
| `Workflows/Wishlist/ParseValidatePayload.xaml` | pure | Payload validation; the Reference must end with ` \| WL-<id>-S<submission>` and be at most 128 characters. |
| `Workflows/Wishlist/DecideRowAction.xaml` | pure | Row decision (`process`, `already_completed`, `stale_submission`, `submission_ahead`, `missing_row`, `unexpected_status`); returns row version, reservation and `chosen_release_id`. |
| `Workflows/Wishlist/BuildValidationResult.xaml` | pure | Outcome, DB status, message, PATCH body (incl. reservation), `Lyrebird_Wishlist` payload and Reference (the row's `queue_reference`; `queued` without a valid one throws). Throws a System exception for `api_error`. |
| `Workflows/Wishlist/ClassifyGuardMiss.xaml` | I/O | After a guarded update hit 0 rows: re-reads the row → `already_persisted`, `superseded`, or `BusinessRuleException` (edited meanwhile). |
| `Workflows/Wishlist/ReadExistingWishlistItem.xaml` | pure | Reads an existing `Lyrebird_Wishlist` item; `BusinessRuleException` if its `Request*` fields differ from the current row input. |
| `Workflows/MusicBrainz/ChooseRelease.xaml` | pure | Release-selection policy (§ 11.4). |
| `Workflows/MusicBrainz/GetReleaseGroupReleases.xaml` | I/O | All releases of a release group (100 per page, max 10 pages), throttled. |
| `Workflows/MusicBrainz/GetUserAgent.xaml` | I/O | User-Agent from assets (same rules as ValidateAlbum). |
| `Workflows/Orchestrator/FindQueueItemByReference.xaml` | I/O | Get Queue Items by exact Reference, all states; optional wait until visible. |
| `Workflows/Orchestrator/AddQueueItemIdempotent.xaml` | I/O | Add Queue Item; only a confirmed duplicate counts as `already_exists`. |
| `Tests/{ParseValidatePayload,DecideRowAction,ChooseRelease,BuildValidationResult}TestCase.xaml` + `Tests/Fixtures/*.json` | tests | Offline tests (51 cases; `BuildQueueReference` adds 12). |
| `Tests/ProcessValidate{QueueItem,Scenario}IntegrationTestCase.xaml` | tests | Integration tests (§ 8). |

Reused: `ValidateAlbum.xaml`, `GetConnection.xaml`, `GetRows.xaml`, `UpdateRows.xaml`. No Invoke Code.

### 11.2 Operation order

1. **Parse the payload.** Invalid → `BusinessRuleException`, nothing written.
2. **Read the row** with `select=*,row_version:updated_at::text&id=eq.<id>` and decide:
   - `missing_row`, `submission_ahead`, `unexpected_status` → `BusinessRuleException`, nothing written.
   - `stale_submission` (the row has a newer submission) or `already_completed` (same submission, status no longer `new`) → done, nothing written.
   - `process` → continue, but only if the item's Reference equals the row's `queue_reference` (otherwise `BusinessRuleException`, nothing written). The **row** is the source of truth for artist, album and format.
3. **Recovery check:** if `Lyrebird_Wishlist` already holds an item with this Reference, an earlier attempt enqueued but did not finish. The result is rebuilt from **that item** (no new release choice), but only if its `Request*` fields equal the current row input; otherwise `BusinessRuleException` (§ 11.5).
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

## 12. Development reset (2026-10-07)

Authorized one-off cleanup so the owner can rerun from a clean state.

**Recovery snapshot** (local, no credentials): `C:\Lyrebird_Data\Backups\2026-10-07_dev_reset\`
- `wishlist_rows.json`, `wishlist_data.sql`: all 19 wishlist rows before the reset;
- `queue_items_<queue>.json`: all items of the four queues before the reset (specific content, output, status, times);
- `delete_log.txt`: the result of every delete;
- `after_tests_*.json`: rows and items created by the tests below, before they were removed.

**Deleted**
- Queue items: every item in `Lyrebird_Validate` (7), `Lyrebird_Wishlist` (1), `Lyrebird_Validate_IT` (19) and `Lyrebird_Wishlist_IT` (6), including Successful and Failed ones. After the tests: the 38 test items and the 14 restriction-probe items.
- Wishlist rows created by the earlier integration tests: ids 9–21. Evidence per row: an `LYREBIRD_IT` marker or items in the `_IT` queues, created on 2026-10-07 during the test session, and listed as test rows in the earlier version of this document. After the tests: test rows 22–35.

**Not removable:** Orchestrator keeps every deleted item as a record with status **`Deleted`** (`Lyrebird_Validate` 7, `Lyrebird_Wishlist` 1, `Lyrebird_Validate_IT` 65, `Lyrebird_Wishlist_IT` 10), together with its transaction history. The CLI and API cannot remove them; they only go away with the queue (not recreated, as instructed) or through the queue's retention policy (not changed). They are not active work.

**Reset:** wishlist rows 1, 4, 5, 6, 7, 8 (the owner's rows: created before the tests; artist, album and preferred format unchanged) → `status = new`, `submission = 1`; `message`, `mb_artist`, `mb_album`, `mbid`, `track_count`, `match_score`, `mb_release_id`, `mb_artist_id`, `chosen_release_id`, `reserved_release_group` and `queue_reference` empty. There is no separate reservation table; the reservation is the column.

**Kept:** the queue definitions and settings (unique references, retries), all schema additions and both migrations, the Orchestrator assets. No triggers exist and no jobs ran.

**Ready for the owner's fresh run:** all four queues have no active items. A dry run (`in_DryRun = True`: sends and stores nothing) shows the References the first load will create:

```
Radiohed - Ok Computr | WL-1-S1
Radiohead - OK Computer | WL-4-S1
Pink Floyd - The Dark Side of the Moon | WL-5-S1
Nirvana - Nevermind | WL-6-S1
Radiohead - asdfghjkl | WL-7-S1
asdfghjkl - asdfghjkl | WL-8-S1
```

Fresh run:

```
uip rpa run --file-path "Workflows/Wishlist/LoadNewWishlistItems.xaml" --project-dir . --output json
uip rpa run --file-path "Workflows/Wishlist/RunValidateBatch.xaml" --project-dir . --input-arguments in_MaxItems:=3 --output json
```

The release choice from the earlier run (row 4, `c7569949-…`) was reset with everything else; every real album will again need `chosen_release_id` once (§ 11.4).

---

## 13. Step 3: Main.xaml (REFramework integration)

`Main.xaml` now runs the whole 10_DP flow with Orchestrator queue transactions. `RunValidateBatch.xaml` stays as a manual tool.

```
Initialization ──(first run)──> run settings: Config + BuildRunSettings + GetQueueSettings
      │
      └─> Load New Wishlist Items (once per job) ──> Get Transaction Data (input queue) ──> Process ──> Set Transaction Status ──> ...
      ^                                                                                       │ system exception
      └───────────────────────────────── re-initialization (no reload) <──────────────────────┘
```

### 13.1 Startup

1. **Config** (`Data/Config.xlsx`): `OrchestratorQueueName = Lyrebird_Validate`, `OrchestratorQueueFolder = Lyrebird`, `WishlistQueueName = Lyrebird_Wishlist`, `logF_BusinessProcessName = Lyrebird_10_DP`, `MaxRetryNumber = 0` (no local retry), `MaxConsecutiveSystemExceptions = 5`, `ShouldMarkJobAsFaulted = True`. The template placeholder `ProcessABCQueue` is gone.
2. **Run safety** (`Workflows/Main/BuildRunSettings.xaml`, before anything is loaded or processed; an unsafe combination faults the job):
   - test mode = the input queue ends with `_IT`; then the output queue must end with `_IT` too, and the startup load takes **only** rows whose `message` starts with `LYREBIRD_IT`;
   - production mode: the output queue must **not** end with `_IT`, the startup load never takes `LYREBIRD_IT` rows, and test failure injection is refused;
   - input and output queue must differ; an extra load filter may only use `id`, `artist`, `album`, `preferred_format`, `submission`.
3. **Queue settings** (`Workflows/Orchestrator/GetQueueSettings.xaml`, Orchestrator HTTP Request `GET /odata/QueueDefinitions`): both queues must exist and enforce unique references. The input queue's real auto-retry flag and max retries decide which attempt is the last one.
4. **Load New Wishlist Items** (own state): `LoadNewWishlistItems` with the query from step 2, **once per job** (`WishlistLoadAttempted`). It is outside the initialization TryCatch and is skipped when Initialization runs again after a system exception. A load failure ends the job; rerunning is safe (References are unique).

### 13.2 Transactions

- **Get Transaction Data**: Get Transaction Item from `OrchestratorQueueName` in `OrchestratorQueueFolder` (explicit `FolderPath`, so the job's own folder does not matter). Transaction ID = the item Reference; Field1 = WishlistId; Field2 = attempt number. Optional `MaxTransactions` limit (stop between transactions).
- **Process.xaml** invokes `ProcessValidateQueueItem` with the current item and maps the result:

| Performer result | Queue transaction | Retry |
|---|---|---|
| `queued`, `needs_release_choice`, `duplicate_release`, `check_spelling`, `not_found`, `already_completed`, `stale_submission`, `superseded` | Successful, Output `Outcome` + `Message` | — |
| `BusinessRuleException` (invalid payload, reference mismatch, row edited without resubmission, …) | Failed (Business) | never |
| any other exception (MusicBrainz `api_error`, Supabase / Orchestrator errors, item not visible yet, an unknown outcome) | Failed (Application) | by Orchestrator (queue: auto retry, max 2) |

  There is no local retry loop: `MaxRetryNumber = 0`, so `RetryCurrentTransaction` hands every system exception to the queue.
- **Last attempt** (queue auto retry off, or `RetryNo >= max retries`): before the item is set Failed, `HandleExhaustedValidateItem.xaml` reconciles the row with the output queue:

| Situation | Action |
|---|---|
| row no longer `new` for this submission, or another Reference | nothing (`no_action`) |
| a `Lyrebird_Wishlist` item with this Reference exists (an attempt enqueued) | reservation **kept**; row finished as `queued` from the item (when made for the current input), else left unchanged for review |
| no item (checked with a 30 s wait when a reservation is held) | reservation released, row `failed` with `TECHNICAL: validation failed N time(s), last error: … Resubmit (submission + 1)` |

  Every write uses the row-version guard; a failing reconciliation leaves row and reservation unchanged and logs an error.
- **MusicBrainz timing**: `LastRequestUtc` lives in Main (whole job) and is passed InOut to Process. After a failed transaction it is set to "now" (the failed attempt's own value is lost with the exception), so the 1.1 s spacing also holds across retries and re-initialization.
- **Stop / restart**: the REFramework checks for an Orchestrator Stop request before every transaction (`Should Stop` in the Get Transaction Data state). **Not verified**: the Stop button needs a published process and an Orchestrator job, which were not used. `in_MaxTransactions` stops at a different place (inside `GetTransactionData.xaml`) and does not prove the Stop button works. A restart reloads safely (`already queued`), and recovery finishes half-done items from the output queue, so no work is duplicated (verified with `in_MaxTransactions`, § 13.5).

### 13.3 Main.xaml arguments

| Argument | Default | Meaning |
|---|---|---|
| `in_OrchestratorQueueName` | Config `Lyrebird_Validate` | input queue; an `_IT` queue switches to test mode |
| `in_OrchestratorQueueFolder` | Config `Lyrebird` | folder of both queues |
| `in_WishlistQueueName` | Config `Lyrebird_Wishlist` | output queue |
| `in_LoadWishlist` | `True` | run the startup load |
| `in_LoadFilter` | empty | extra load filter (`id`, `artist`, `album`, `preferred_format`, `submission` only), e.g. `id=in.(1,4)` |
| `in_MaxTransactions` | `0` | stop after N transactions (0 = no limit) |
| `in_TestFailAfterStep` | empty | **test only**, `after_reservation` / `after_enqueue`; refused outside test mode |

### 13.4 First manual production run

Prerequisites:
- the six original rows are `new`, submission 1, without `queue_reference` (§ 12);
- **`Lyrebird_Validate` has no New, In Progress or retry items** (Get Transaction Data takes the next New item of the queue, whatever loaded it) and `Lyrebird_Wishlist` has no active items:
  ```
  uip or queue-items list --folder-path Lyrebird --queue-name Lyrebird_Validate --status New --output json
  uip or queue-items list --folder-path Lyrebird --queue-name Lyrebird_Validate --status InProgress --output json
  ```
  Both must return `"Returned": 0`;
- no trigger and no other job running for this process;
- robot permissions in folder `Lyrebird`: Queues View, Transactions View / Create / Edit, Assets View (and Assets View in `Shared`).

**Full run** (all defaults = production), from the project folder:

```
uip rpa run --file-path "Main.xaml" --project-dir . --output json
```

In Studio: open `Main.xaml` → Run File (or Debug) → leave every argument empty / default (`in_LoadWishlist = True`, `in_MaxTransactions = 0`).

Expected: the startup load adds `Radiohed - Ok Computr | WL-1-S1` … `asdfghjkl - asdfghjkl | WL-8-S1` (6 items), then each item is processed: row 1 → `check_spelling`, rows 4 and 5 → `check_spelling` with `RELEASE_CHOICE:` (set `chosen_release_id` and resubmit, § 4), the others depending on MusicBrainz. Nothing reaches `Lyrebird_Wishlist` until a release is chosen.

**Single-row trial.** `in_LoadFilter` only limits what the startup load **adds**; Get Transaction Data still takes the next New item of the whole queue. So:

- *Through Main.xaml* (only valid when the prerequisite above holds, i.e. the queue has no other New item): `in_LoadFilter` adds just that row, and `in_MaxTransactions = 1` stops after it:
  ```
  uip rpa run --file-path "Main.xaml" --project-dir . --input-arguments "in_LoadFilter=id=in.(4)" --input-arguments in_MaxTransactions:=1 --output json
  ```
  If the queue might hold other New items, do not use this; use the targeted method below.
- *Targeted, whatever else is in the queue*: add the one row, then process exactly its Reference with the manual runner (Get Transaction Item with Reference = Equals):
  ```
  uip rpa run --file-path "Workflows/Wishlist/LoadNewWishlistItems.xaml" --project-dir . --input-arguments "in_Query=select=*&status=eq.new&id=eq.4" --output json
  ```
  Read the stored Reference (`select queue_reference from lyrebird.wishlist where id = 4;`), put it in a JSON file (non-ASCII names do not survive the command line) and run:
  ```
  {"in_MaxItems": 1, "in_Reference": "Radiohead - OK Computer | WL-4-S1"}
  uip rpa run --file-path "Workflows/Wishlist/RunValidateBatch.xaml" --project-dir . --input-arguments-file one-row.json --output json
  ```
  `RunValidateBatch` uses the same performer and transaction statuses as Main, but not Main's startup checks or the last-attempt reconciliation.

### 13.5 Verification (2026-10-07)

| Check | Result |
|---|---|
| `uip rpa validate --project-dir .` / analyzed build with the policy file | 0 diagnostics / **PASS** |
| Offline tests: `BuildRunSettings` (14), `BuildQueueReference` (12), `ParseValidatePayload` (9), `DecideRowAction` (14), `ChooseRelease` (11), `BuildValidationResult` (17), `BuildValidateQueueItem`, `LoadNewWishlistItemsDryRun`, `SecureStringConversionGuard` (53 workflows), `InitAllSettings` | PASS |
| `GetQueueSettings` against the real queues | reads auto retry / max retries / unique references; missing queue → exception |
| **Main.xaml integration** (`node Tests/MainIntegration/main-it.js run`, queues `Lyrebird_Validate_Main_IT` / `Lyrebird_Wishlist_Main_IT`, 7 marked rows) | **22/22 checks PASS** (rerun after the cleanup changes) |
| `InitAllSettingsTestCase` (replaces the REFramework template checks) | PASS: Config is the Lyrebird production configuration (queues, folder, `MaxRetryNumber` 0, faulted on errors, no placeholder, no screenshot setting) and resolves to production mode |
| `node Tests/Tools/check-project-references.js` | no missing-file references (main file, entry point, 15 registered test cases, every Invoke Workflow path) |

Main.xaml scenarios:

| Scenario | Verified |
|---|---|
| S0 unsafe settings | `_IT` input with the regular output queue → job faulted with `ArgumentException` before anything was loaded |
| S1 success + business | startup load added exactly the 3 filtered rows; `queued` / `not_found` / `check_spelling` → Successful with Output `Outcome` + `Message`; the queued album has one download item; a reference-mismatch item → Failed (Business), `RetryNo` 0, no retry, row untouched; MusicBrainz waits logged between transactions |
| S2 empty queue | load added 0, "no more transaction data", job ended cleanly |
| S3 technical retry + stop + restart | run 1: attempt 1 failed after enqueue → Failed (Application, shown as Retried), retry item New, job stopped by `in_MaxTransactions = 1`; run 2 (restart): load `0 added, 1 already queued`, retry recovered from the download item → Successful, row `queued`, still one download item |
| S4 exhausted, download item exists | 3 attempts (Retried, Retried, Failed with `RetryNo` 2); reconciliation `recovered_queued`: row `queued`, reservation kept, one download item; re-initializations logged "Startup load already ran in this job" |
| Error handling | system exceptions are recorded as text only: failure reason `Type: message` (values after authorization / apikey / bearer / password / secret masked, max 1000 characters), details = exception type; no screenshot folder is created |
| S5 exhausted, no download item | 3 attempts; reconciliation `released_failed`: row `failed` with `TECHNICAL: validation failed 3 time(s) …`, reservation released, no download item; retries logged the carried-over last MusicBrainz request time (not "none") |

Get Transaction Item with an explicit `FolderPath` and Set Transaction Status (folder taken from the item) worked from a local run whose own folder is not `Lyrebird`.

After the run, `node Tests/MainIntegration/main-it.js cleanup` deleted the 7 test rows (ids recorded by the script) and every item of the two `_Main_IT` queues (they remain as `Deleted` records). The six original rows were not touched.

**Technical-error handling (cleanup, 2026-10-07).** No screenshots: `Framework/TakeScreenshot.xaml`, the `Exceptions_Screenshots` folder and the `ExScreenshotsFolderPath` setting are removed; `SetTransactionStatus` logs and stores the sanitized text instead. Supabase error bodies in exceptions are capped at 500 characters; the MusicBrainz User-Agent (which contains the contact e-mail) is no longer logged, only the app name and whether a contact is set. No workflow logs request headers or the Supabase key.

**Test inventory (cleanup, 2026-10-07).** The REFramework template tests `MainTestCase`, `ProcessTestCase`, `GetTransactionDataTestCase` (they would run against production), `InitAllApplicationsTestCase` (tested an empty template stub), `WorkflowTestCaseTemplate` (an empty skeleton registered as a test) and their data file `Tests.xlsx` are removed and unregistered. Their useful coverage lives on in `InitAllSettingsTestCase` (now the Lyrebird configuration test) and the Main.xaml integration tests. A Studio session that was open during the removal still lists them and refuses to run Main.xaml until the project is reopened; afterwards `node Tests/Tools/check-project-references.js` must report no missing references.

### 13.6 Remaining limitations (step 3)

- **Stop button unverified.** Orchestrator's Stop signal was not exercised (needs a published process and an Orchestrator job). The `in_MaxTransactions` test stops through another check and is no evidence for it. Verify it in the first supervised Orchestrator job: start, press Stop while items remain, and confirm the job ends after the current transaction with the remaining items still New.
- A hard kill during a transaction leaves the item In Progress → Abandoned after 24 h, not retried (`RetryAbandonedItems = No`). Recovery: § 13.7 A.
- When Supabase is unreachable on the last attempt, the reconciliation cannot write either: row and reservation stay as they are (logged as an error). Recovery: § 13.7 B.
- Every real album still needs a `chosen_release_id` once (§ 11.4); process 20 does not exist yet.

### 13.7 Recovery runbooks

Both cases below leave a `Lyrebird_Validate` item that Orchestrator will not process again, and a wishlist row that is still `new` for that submission. The row may hold an album reservation, and an item with the same Reference may already exist in `Lyrebird_Wishlist`. **Never release a reservation while such an output item exists**: it is the download request for that album.

**A. Killed or abandoned transaction.** The job was killed (robot crash, machine restart, "Kill" in Orchestrator) while processing an item. The item stays In Progress and becomes **Abandoned** after 24 h; it is not retried (`RetryAbandonedItems = No`). The loader reports the row as already queued, so a rerun of Main does not pick it up again.

**B. Supabase unavailable during the last attempt.** The last attempt failed and the reconciliation (§ 13.2) could not reach Supabase either: the log shows `last attempt failed and the reconciliation failed too … Row and reservation left unchanged`. The item is Failed (Application) with no retry left.

Steps (both cases; first fix the cause, e.g. Supabase is reachable again, and make sure no job is running):

1. **Find the row** (the Reference is in the item and in the log):
   ```sql
   select id, status, submission, queue_reference, reserved_release_group, message
   from lyrebird.wishlist where queue_reference = '<Reference>';
   ```
   If the row is no longer `new`, or its `queue_reference` differs, nothing is open: stop here.
2. **Look for the output item** with the same Reference:
   ```
   uip or queue-items list --folder-path Lyrebird --queue-name Lyrebird_Wishlist --limit 100 --output json --output-filter "[?Reference=='<Reference>'].[Status, Reference, SpecificContent]"
   ```
   (Orchestrator lists new items with a short delay; check again after a minute if the step-1 row holds a reservation.)
3. **Preferred: retry the same item.** Orchestrator → folder Lyrebird → Queues → `Lyrebird_Validate` → Transactions → the Abandoned / Failed item → **Retry**. The retry keeps the Reference. Run Main (or `RunValidateBatch` with `in_Reference`, § 13.4). The performer then finishes the row **from the existing output item** (status `queued`, reservation kept, no second download item) or, if there is none, validates it again. No database edit is needed. *Not exercised in the automated tests (no CLI or API path was used for manual retry); the recovery logic it relies on is the tested `crash_after_enqueue` / S3 path.*
4. **Only if the item cannot be retried** (for example it was deleted):
   - *Output item exists* (step 2): keep the reservation. Finish the row from the item; use the values of its specific content:
     ```sql
     update lyrebird.wishlist
        set status = 'queued', mb_artist = '<Artist>', mb_album = '<Album>', mbid = '<MbReleaseGroupId>',
            mb_release_id = '<MbReleaseId>', mb_artist_id = '<MbArtistId>', track_count = <TrackCount>,
            reserved_release_group = '<MbReleaseGroupId>',
            message = 'Finished by hand from the existing Lyrebird_Wishlist item <Reference>.'
      where id = <id> and status = 'new' and submission = <n> and queue_reference = '<Reference>';
     ```
     Do not resubmit in this case: a resubmission would validate again and add a second download item for the same album (process 20 would ignore the old one only through the submission check).
   - *No output item*: nothing was queued, so release the reservation and resubmit; the next load creates a new Reference:
     ```sql
     update lyrebird.wishlist
        set reserved_release_group = null, submission = submission + 1, message = null
      where id = <id> and status = 'new' and submission = <n> and queue_reference = '<Reference>';
     ```
   Every statement is guarded by status, submission and Reference, so it changes nothing if the row moved on meanwhile (check `UPDATE 1`).
