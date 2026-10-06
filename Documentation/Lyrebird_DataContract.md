# Lyrebird data contract and 10_DP input loading

Status (2026-10-06): part 1 (input loading) built and verified offline and against Supabase (read-only).
**Not** connected to `Main.xaml`. Nothing has been written to Orchestrator or Supabase.
Schema changes in this document are **proposals only**. Nothing has been applied.

---

## 1. Files

| File | Purpose |
|---|---|
| `Workflows/Wishlist/LoadNewWishlistItems.xaml` | Input loader: reads `status = new` wishlist rows (via `GetRows.xaml`) and adds one item per row to `Lyrebird_Validate`. |
| `Workflows/Wishlist/BuildValidateQueueItem.xaml` | Pure function: wishlist row → Reference + specific content, or an "invalid" reason. |
| `Workflows/Supabase/GetRows.xaml`, `UpdateRows.xaml` | Existing helpers. ST-SEC-009 accepted-risk annotation added, `SaveRawRequestResponse = False` made explicit (§ 9). |
| `Tests/BuildValidateQueueItemTestCase.xaml` | Offline: payload construction. |
| `Tests/LoadNewWishlistItemsDryRunTestCase.xaml` | Offline: dry-run counters, duplicate in batch, invalid row, resubmission. |
| `Tests/SecureStringConversionGuardTestCase.xaml` | Offline: compensating control for the ST-SEC-009 exception (§ 9). |
| `Tests/LoadNewWishlistItemsIntegrationTestCase.xaml` | **Writes to Orchestrator.** Controlled integration test, run manually only (§ 8). Not run yet. |

`Main.xaml` and `Framework/*` are unchanged. `Process.xaml` is still a placeholder and must not consume real work.

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
| `out_WouldAddCount` | Out | | **Dry run only**: items that would be sent. Not checked against the queue. Always 0 in a live run. |
| `out_AlreadyQueuedCount` | Out | | **Live run only**: confirmed duplicate references rejected by Orchestrator. Always 0 in a dry run. |
| `out_DuplicateInBatchCount` | Out | | Same Reference earlier in the same batch. |
| `out_InvalidCount` | Out | | Row misses data the payload needs (Warn log with the reason). |
| `out_AddedReferences` | Out | | References actually added. Empty in a dry run. |
| `out_WouldAddReferences` | Out | | Dry run only: references that would be sent. |

Per row, exactly one outcome is logged: `ADDED`, `WOULD ADD (dry run, NOT sent)`, `SKIPPED (already in queue)`, `SKIPPED (duplicate in this batch)`, `SKIPPED (invalid)`, or `FAILED` (which stops the load).
The summary line starts with `Load wishlist DRY RUN finished … 0 ADDED, n WOULD ADD …` or `Load wishlist finished … n ADDED, n already in queue …`.

A dry run cannot know what is already in the queue. A "would add" item may turn out to be "already queued" in a live run.

The loader is **read-only on Supabase**; it does not change `status`.

---

## 3. Duplicate handling

The queue Reference is **`WL-<wishlist id>-S<submission>`**, for example `WL-42-S1`. It contains no artist or album, so fixing a typo does not create a second item for the same row and submission.

1. **Orchestrator "Enforce unique references"** on the queue is the real guarantee. It is enforced on the server side and works across robots and jobs.
2. **Duplicate in batch**: the same Reference twice in one load is added once.
3. **Confirmed duplicate rejection**: the loader absorbs an Add Queue Item error **only** when all of these are true:
   - the exception type is `UiPath.Core.Activities.OrchestratorHttpException`;
   - `StatusCode` = **409 Conflict**;
   - the message matches `duplicate reference` or `reference already exists` (case-insensitive).

   Then the row is counted as `already queued` and the load continues.

**Every other error is logged at Error with the item and rethrown**, so the job fails visibly. This includes a missing queue (404 / error 1002), 401/403, a 409 for any other reason, 5xx, timeouts, and non-HTTP exceptions. Rerunning after a failure is safe because already added items are then rejected as duplicates.

The exact 409 message text has not been observed yet. The integration test (§ 8) records it. If it differs, the test fails at step 2 (the error is *not* absorbed), and the pattern is then adjusted on purpose.

---

## 4. Resubmission contract

**Identity of a request = (wishlist id, submission).** The Reference is derived from it: `WL-<id>-S<submission>`.

| Situation | Submission | Effect |
|---|---|---|
| Orchestrator auto-retry of a failed `Lyrebird_Validate` item | **unchanged** | Orchestrator creates the retry inside the same item's retry chain, with the same Reference. Unique references does not block its own retries. |
| Loader runs again (schedule, crash, partial load) | **unchanged** | Same Reference, so it is a confirmed duplicate: `already queued`, nothing added. |
| Performer re-executes a transaction (REFramework retry) | **unchanged** | Same queue item; the performer must be idempotent. |
| **Deliberate resubmission** by the owner (fixed spelling after `check_spelling`/`not_found`, or retry after `failed`) | **+1** | New Reference (`WL-42-S2`), so a new queue item. The old item stays in the queue as history. |

Rules:

- Only a **deliberate, human/operator action** increments `submission`. No process increments it, and no technical retry changes it.
- Deliberate resubmission = one update:
  ```sql
  update lyrebird.wishlist
  set status = 'new', submission = submission + 1, message = null
  where id = 42;
  ```
- Setting `status = 'new'` **without** incrementing has no effect on the queue: the loader reports `already queued`. That protects against accidental re-dispatch.
- Deleting queue items is **not** part of this contract. Queue history stays intact.

### While the `submission` column does not exist (today)

- The loader treats a missing or `null` submission as **1**, so every row is `WL-<id>-S1`.
- Deliberate resubmission through Supabase is therefore **not possible yet**. A row set back to `new` is reported as `already queued`, which is safe. **Add the column before go-live** (§ 7).
- Only if a resubmission is really needed before that: run the loader manually with `in_Rows` containing that one row with `"submission": 2`. Write down the id and the submission used, because the backfill below needs it.

### When the column is added

```sql
alter table lyrebird.wishlist
  add column submission integer not null default 1 check (submission >= 1);
```

- Every existing row gets `1`, which is exactly the value the loader already used, so all References stay the same. Nothing is dispatched again and no duplicates appear.
- Backfill rows that were resubmitted manually before the column existed (see above) to the highest submission already used:
  `update lyrebird.wishlist set submission = 2 where id = <id>;`.
  To find them, search the queue for References `WL-<id>-S*`.
- Do not add it with another default (0, or nullable with a different meaning). The loader reads `select=*`, so no workflow change is needed.

---

## 5. Pipeline overview

```
wishlist (status new)
  -> [10_DP loader]    -> Lyrebird_Validate -> [10_DP performer: MusicBrainz]
  -> Lyrebird_Wishlist -> [20_PF_Download]  -> Lyrebird_Collect -> [30_PF_Collect]
  -> Lyrebird_Tag      -> [40_PF_Tag]       -> Lyrebird_Upload  -> [50_PF_Upload] -> library
```

`Lyrebird_Validate` is the new input queue. `Lyrebird_Wishlist` keeps its README role as the download queue; renaming it to `Lyrebird_Download` would be clearer but is optional.

### Wishlist status meanings (`lyrebird.wishlist.status`)

| Status | Meaning | Set by | Next |
|---|---|---|---|
| `new` | Entered or resubmitted; not yet validated. The row may already be in `Lyrebird_Validate`, because the loader does not change status. | user / resubmit | 10_DP loader |
| `validating` *(proposed)* | In `Lyrebird_Validate`, waiting for validation. | 10_DP loader | 10_DP performer |
| `check_spelling` | MusicBrainz returned candidates but not exactly one strong match. `message` holds the suggestion. **Needs the user.** | 10_DP performer (Business Exception) | user fixes, then resubmits (§ 4) |
| `not_found` | No release group found. **Needs the user.** | 10_DP performer (Business Exception) | user fixes, then resubmits |
| `queued` | Validated; MB names/IDs stored; item in `Lyrebird_Wishlist`. | 10_DP performer | 20 |
| `downloading` | Download started; item in `Lyrebird_Collect`. | 20 | 30 |
| `downloaded` | Download complete and checked; item in `Lyrebird_Tag`. | 30 | 40 |
| `tagged` | Tagged into `Tagged\`; item in `Lyrebird_Upload`. | 40 | 50 |
| `uploaded` | On the server and verified. Final. | 50 | — |
| `failed` | A step gave up (retries exhausted or unrecoverable). `message` says which step and why. | any step | user resubmits (§ 4) |

`api_error` from `ValidateAlbum.xaml` is **not** a status. The performer throws a System Exception so the queue retries with the same submission. Only when retries run out does the row become `failed`.

### Wishlist columns needed by the pipeline

| Column | Exists | Written by | Used by |
|---|---|---|---|
| `id`, `artist`, `album`, `preferred_format` | yes | user | loader (payload) |
| `status`, `message` | yes | every step | everyone / user |
| `mb_artist`, `mb_album` | yes | 10_DP performer | 20, 40 |
| `mbid` | yes, **ambiguous** (holds the release *group* id) | 10_DP performer | see § 7 |
| `track_count`, `match_score` | yes | 10_DP performer | 30 / reporting |
| `created_at`, `updated_at` | yes | DB | reporting |
| `submission` | **no** | user (deliberate resubmit) | loader (Reference) |
| `mb_release_group_id` | **no** (rename of `mbid`) | 10_DP performer | 40 fallback |
| `mb_release_id` | **no** | 10_DP performer | 40 (Picard `openalbum?id=`) |
| `mb_artist_id` | **no** | 10_DP performer | 20/40 |
| `queue_reference` | **no** | each step | trace DB ↔ Orchestrator |

### Queue payloads (specific content)

Every queue carries `PayloadVersion` (Int32, currently 1), `WishlistId` (Int64) and `Submission` (Int32). Performers validate the fields at the start of `Process.xaml` and throw a Business Exception if one is missing. Read numbers with `Convert.ToInt64(...)` / `Convert.ToInt32(...)`, because SpecificContent comes back as JSON.

**`Lyrebird_Validate`** (10_DP loader → 10_DP performer). Reference `WL-<id>-S<submission>`. **Built and tested.**

| Field | Type | Source |
|---|---|---|
| `PayloadVersion` | Int32 | `1` |
| `WishlistId` | Int64 | `wishlist.id` |
| `Artist` | String | `wishlist.artist`, trimmed |
| `Album` | String | `wishlist.album`, trimmed |
| `PreferredFormat` | String | `wishlist.preferred_format`, upper case: `FLAC` \| `MP3` \| `ANY` |
| `Submission` | Int32 | `wishlist.submission`; 1 while the column doesn't exist |

**`Lyrebird_Wishlist`** (10_DP performer → 20). Reference `WL-<id>-S<submission>`. *Proposed.*
`PayloadVersion`, `WishlistId`, `Submission`, `Artist` / `Album` (**MusicBrainz** spelling), `PreferredFormat`, `MbReleaseGroupId`, `MbReleaseId`, `MbArtistId` (UUID strings), `TrackCount` (Int32).

**`Lyrebird_Collect`** (20 → 30). Reference `WL-<id>-S<submission>-A<attempt id>`. *Proposed.*
`PayloadVersion`, `WishlistId`, `Submission`, `DownloadAttemptId` (Int64, `download_attempts.id`), `SoulseekUser`, `RemoteFolder`, `Format`, `TrackCount`, `DownloadStartedUtc` (DateTime, for the "stuck > ~6 h" rule).

**`Lyrebird_Tag`** (30 → 40). Reference `WL-<id>-S<submission>-A<attempt id>`. *Proposed.*
`PayloadVersion`, `WishlistId`, `Submission`, `DownloadAttemptId`, `AlbumFolder` (relative to `<DataRoot>\Downloads`), `MbReleaseId`, `TrackCount`, `Format`.

**`Lyrebird_Upload`** (40 → 50). Reference `WL-<id>-S<submission>-A<attempt id>`. *Proposed.*
`PayloadVersion`, `WishlistId`, `Submission`, `TaggedFolder` (relative to `<DataRoot>\Tagged`), `FileCount` (Int32), `TotalBytes` (Int64).

Paths are always relative to the data root, because data folders differ per machine.

---

## 6. Orchestrator setup required (do not create yet; this is the exact list)

All in the existing modern folder **`Lyrebird`** (the dry run already read its assets, so the folder exists).

**Queue `Lyrebird_Validate`** (production input):

| Field | Value |
|---|---|
| Name | `Lyrebird_Validate` |
| Description | `Lyrebird 10_DP input: wishlist rows to validate. Reference WL-<id>-S<submission>.` |
| Enforce unique references | **Yes.** Check it before saving; as far as I know it cannot be changed after creation. |
| Auto retry | Yes |
| Max # of retries | 2 |
| Specific data JSON schema | optional; see below |
| Queue trigger | **none** (`Process.xaml` must not consume work yet) |

**Queue `Lyrebird_Validate_IT`** (integration test only): same settings, but **Auto retry = No** and **never** a trigger. Nothing consumes it; items stay `New` as test history.

**Robot / account permissions** in folder `Lyrebird`, for the account that runs the loader (and, for the integration test, your own robot): **Queues: View**, **Transactions: View, Create**. Already working and needed: **Assets: View** (Supabase URL/key).
Later, for the performer (part 2): **Transactions: Edit** (Set Transaction Status).

**Process log level**: keep the `Lyrebird_10_DP` process / robot logging at **Information** or lower, never Verbose/Trace (§ 9).

Optional server-side payload check (Specific data JSON schema for both queues):

```json
{
  "type": "object",
  "required": ["PayloadVersion", "WishlistId", "Artist", "Album", "PreferredFormat", "Submission"],
  "properties": {
    "PayloadVersion": { "type": "integer", "const": 1 },
    "WishlistId": { "type": "integer", "minimum": 1 },
    "Artist": { "type": "string", "minLength": 1 },
    "Album": { "type": "string", "minLength": 1 },
    "PreferredFormat": { "type": "string", "enum": ["FLAC", "MP3", "ANY"] },
    "Submission": { "type": "integer", "minimum": 1 }
  }
}
```

---

## 7. Missing schema (proposal, NOT applied)

Compared against `../Lyrebird_00_Shared/DB/wishlist.sql`:

```sql
-- PROPOSAL ONLY - review before running. Add 'submission' before go-live (section 4).
alter table lyrebird.wishlist
  add column submission integer not null default 1 check (submission >= 1),
  add column mb_release_id uuid null,
  add column mb_artist_id uuid null,
  add column queue_reference text null;

-- 'mbid' holds what ValidateAlbum returns: the release GROUP id. Make that explicit:
alter table lyrebird.wishlist rename column mbid to mb_release_group_id;

-- allow the 'validating' status
alter table lyrebird.wishlist drop constraint wishlist_status_check;
alter table lyrebird.wishlist add constraint wishlist_status_check check (status = any (array[
  'new','validating','check_spelling','not_found','queued',
  'downloading','downloaded','tagged','uploaded','failed']));
```

Other gaps:

- `download_attempts`: the README says "SQL ready", but there is no `download_attempts.sql` in `../Lyrebird_00_Shared/DB`. 20/30 need it.
- `process_log`: not designed yet.
- `track_count` / `mb_release_id`: `ValidateAlbum.xaml` only searches release **groups**. A release lookup (`/ws/2/release?release-group=<id>&inc=media`) is needed.
- Once `validating` exists, the loader can mark rows with `UpdateRows` (filter `id=eq.<id>&status=eq.new`).

---

## 8. Controlled integration test (run manually, after § 6)

`Tests/LoadNewWishlistItemsIntegrationTestCase.xaml`. It has **not** been run.

Safety:
- It refuses `Lyrebird_Validate`; its default queue is `Lyrebird_Validate_IT`.
- It uses a synthetic row passed in through `in_Rows`, so Supabase is not read or written.
- The id is a 12-digit number built from the UTC time, so every run creates a new Reference.

Preconditions:
1. `Lyrebird_Validate_IT` exists in folder `Lyrebird` with Enforce unique references = Yes and no trigger.
2. The local robot is connected to Orchestrator (Assistant signed in) and has the permissions from § 6 in `Lyrebird`.

Run:

```
uip rpa run --file-path "Tests/LoadNewWishlistItemsIntegrationTestCase.xaml" --project-dir . --output json
```

| Step | Action | Expected |
|---|---|---|
| 1 | Live load of synthetic row `WL-<ts>-S1` | `added 1`, `already queued 0`, log `ADDED` |
| 2 | Live load of **the same row again** (resubmit the same reference) | `added 0`, `already queued 1`, log `SKIPPED (already in 'Lyrebird_Validate_IT', Orchestrator: HTTP 409 …)` |
| 3 | Live load into a non-existent queue `Lyrebird_IT_Missing_<ts>` | an `OrchestratorHttpException` (404, error 1002) reaches the test, so it is **not** absorbed as a duplicate |

After the run:
- Write the exact step-2 message (HTTP 409 text and error code) into § 3.
- Check in Orchestrator that `Lyrebird_Validate_IT` contains exactly **one** new item `WL-<ts>-S1`, with the 6 fields from § 5.
- Leave the item there as test history.

If step 2 fails with an unabsorbed 409, the duplicate text differs from the expected pattern. Adjust the pattern in `LoadNewWishlistItems.xaml` deliberately and rerun.

Only after this passes: do a first production load (`in_DryRun = False`) into `Lyrebird_Validate`, then run it a second time. The second run must report `0 ADDED, n already in queue`.

---

## 9. Credential handling: ST-SEC-009 (accepted risk)

**Finding.** `GetRows.xaml` and `UpdateRows.xaml` read the Supabase key with Get Secret (SecureString). They then build the `Headers` dictionary with `New NetworkCredential(String.Empty, ApiKey).Password`, which turns the key into a plain `System.String` for the `apikey` and `Authorization: Bearer` headers. Rule ST-SEC-009 is set to **Error** in this environment and blocks the build.

**Why there is no clean fix with the current activities.** Neither `NetHttpRequest` nor the legacy `HttpClient` accepts a SecureString for custom headers or bearer tokens. Their only SecureString inputs are the Basic-auth password and the client-certificate password, and `UiPath.WebAPI.Activities` 2.5.2 is the newest version. Supabase/PostgREST needs the key in those headers.

**Actual risk.**
- **Impact if the key leaks.** It is the `service_role` key, which bypasses RLS on the whole Supabase: every schema, plus auth admin. Anyone holding it controls the database.
- **How the plain string can leak:**
  1. **Verbose/Trace robot logging** records activity arguments, including the `Headers` dictionary, in the robot log and in Orchestrator logs, where anyone with Logs view on the folder can read them.
  2. **`SaveRawRequestResponse = True`** dumps request headers; the activity redacts `Authorization` but **not `apikey`**.
  3. **Debugging** in Studio shows the value in Locals/Watch.
  4. **Process memory and crash dumps**: a managed string cannot be wiped and lives until garbage collection.
- **Bigger than the analyzer finding: transport.** `10_DP_SupabaseUrl` is `http://tower:8000`, so the key travels **unencrypted** over the LAN on every request.

**Decision (2026-10-06, project owner): accept the risk explicitly.**

Mitigations in place:
- The conversion happens only at the point of use, inside the HTTP activity's `Headers` expression. No String variable holds the key.
- The `ApiKey` SecureString is scoped to the "Call Supabase" sequence.
- `SaveRawRequestResponse = False` is set explicitly on both activities.
- Both activities carry an annotation pointing to this section.
- `Tests/SecureStringConversionGuardTestCase.xaml` fails if any workflow other than `GetRows.xaml` / `UpdateRows.xaml` contains a SecureString-to-String conversion. The analyzer exclusion works per activity *type*, so this test is what keeps the exception limited to these two files.

Operational mitigations (required):
- Process/robot log level **Information or lower**, never Verbose/Trace.
- Don't inspect `Headers` while debugging with someone watching or recording the screen.

Recommended risk reductions (not done):
- Put Supabase behind **HTTPS** (reverse proxy on tower).
- Replace the `service_role` key with a JWT for a dedicated Postgres role (for example `lyrebird_robot`) that can only access the `lyrebird` schema.
- Longer term: a Kong route with Basic auth, so the robot uses `BasicAuthSecurePassword` (SecureString end to end) and never holds the Supabase key.

**Recording the exception (not done yet; needs Studio).** The CLI cannot change analyzer settings, and I did not edit undocumented settings files. In Studio:
1. Project Settings → Workflow Analyzer → ST-SEC-009.
2. In **Excluded activities**, add the HTTP Request activity type `UiPath.Web.Activities.Http.NetHttpRequest` (use the format the field's tooltip shows). Keep the rule's severity at **Error**, so every other activity stays blocked.
3. Save, then run `uip rpa build . --output json`. It must succeed with no ST-SEC-009 errors.
4. Commit the resulting settings change with a message that refers to this section. If Studio stores it only on this machine (not in the project), write that down here: other machines and CI will then still fail.

Review this exception again if `UiPath.WebAPI.Activities` adds SecureString headers, if the key or role changes, or if Supabase moves behind HTTPS/Basic auth.

---

## 10. Verification (2026-10-06)

| Check | Result |
|---|---|
| `uip rpa validate` on all changed/new workflows and tests | 0 diagnostics |
| `uip rpa build .` **with analysis** | **fails**: only ST-SEC-009 in `GetRows.xaml` and `UpdateRows.xaml`, until the exception in § 9 is recorded in Studio |
| `BuildValidateQueueItemTestCase` | passed |
| `LoadNewWishlistItemsDryRunTestCase` | passed: `0 added`, `3 would add` (`WL-1-S1`, `WL-2-S1`, `WL-1-S2`), `0 already queued`, `1 duplicate in batch`, `1 invalid` |
| `SecureStringConversionGuardTestCase` | passed: conversions only in the two accepted files |
| Live dry run against Supabase (read-only, previous session) | 6 `new` rows, 6 payloads built, nothing sent |
| `LoadNewWishlistItemsIntegrationTestCase` | **not run**: needs the § 6 setup |
