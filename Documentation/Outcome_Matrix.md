# Lyrebird_10_DP: outcome and failure matrix

Status 2026-10-08. The four classes are:

- **Continue**: a business outcome, transaction Successful.
- **Reject**: a `BusinessRuleException`, Failed (Business), no retry.
- **Retry**: a system exception, Failed (Application). The `Lyrebird_Validate` queue retries it (auto retry, max retries from the queue); Config `MaxRetryNumber = 0`, so there is no local retry.
- **Stop**: the job ends Faulted.

The per-outcome database effects of the transactions are in [Lyrebird_DataContract.md](Lyrebird_DataContract.md) § 11.3. This page adds startup, job control and the 2026-10-08 changes (§ 14.2).

## Startup (before anything is loaded or consumed)

| Situation | Class | Proof |
|---|---|---|
| Config missing/invalid, unsafe queue combination (`_IT` pairing, input = output), filter outside the allow-list, test injection in production | Stop | InitAllSettings, BuildRunSettings, main-it S0 |
| Queue missing or not enforcing unique references | Stop | GetQueueSettings; main-it |
| `10_DP_MusicBrainzUserAgent` missing/empty | Stop (**since 2026-10-08**; before, it failed every transaction after the load) | code path; *not fault-injected* |
| `PersonalEmail` missing or empty | Continue with a warning (User-Agent without contact) | code path |
| Supabase unreachable / wrong key (also with `in_LoadWishlist = False`) | Stop (**since 2026-10-08**) | the 20_PF InitializeRunIntegration fault cases exercise the same GetRows pattern; *10_DP itself not fault-injected* |
| Startup load fails (Supabase / Orchestrator) | Stop; a rerun is safe (stored References) | main-it |

## Transactions

See DataContract § 11.3:

- `queued` / `needs_release_choice` / `duplicate_release` / `check_spelling` / `not_found` / `already_completed` / `stale_submission` / `superseded`: Continue.
- Invalid payload, missing row, submission ahead, unknown status, row edited: Reject.
- MusicBrainz, Supabase or Orchestrator errors, or an output item not visible within 15 s: Retry.
- On the last attempt, the row is reconciled (`failed`, `TECHNICAL: …`, reservation released when no output item exists), and the original exception is rethrown.
- An unknown performer outcome becomes `InvalidOperationException` (Retry), never Successful.

Changes of 2026-10-08:

| Situation | Class | Note |
|---|---|---|
| Recovery finds the existing `Lyrebird_Wishlist` item **Deleted** | Reject | before: finished as `queued` with nothing left for 20_PF |
| Claim PATCH applied but its response was lost (502/504/timeout), retry matches 0 rows | Reject (**wrong**: should Continue) | open item I1 |

## Orchestrator and job control

| Situation | Class | Note |
|---|---|---|
| Get Transaction Data throws | Stop (**since 2026-10-08**; before, the job ended Successful) | *not fault-injected* |
| Set Transaction Status throws | Stop, no new item is taken (**since 2026-10-08**). The item may stay In Progress | runbook § 13.7 A |
| `MaxConsecutiveSystemExceptions` (5) reached | Stop | template |
| Graceful **Stop** from Orchestrator | the current item finishes; the remaining items stay New; the job ends Successful | *unverified on a real job* (§ 13.6) |
| Forced kill | the item stays In Progress → Abandoned, not retried | runbook § 13.7 A; a kill during the load is safe |

## Logs

- Exception messages in the logs, and the `TECHNICAL:` text stored in `wishlist.message`, pass through the secret mask.
- Invalid loader rows are logged by id only.
- No screenshots; `SaveRawRequestResponse = False` on all HTTP activities.
- The Supabase key is read with Get Secret right before each request (ST-SEC-009, § 9).
