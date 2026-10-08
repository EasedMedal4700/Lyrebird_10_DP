# Lyrebird_10_DP (wishlist validation)

`lyrebird.wishlist` rows with status `new` → `Lyrebird_Validate` queue → MusicBrainz validation →
row `queued` + one `Lyrebird_Wishlist` item for 20_PF_Download (or `check_spelling` / `not_found` / `failed`).
The contract with process 20 is in [Documentation/Lyrebird_DataContract.md](Documentation/Lyrebird_DataContract.md) § 5.

## Status (2026-10-08)

| | |
|---|---|
| Builds (policy `Governance/Lyrebird_10_DP.analyzer-policy.json`) | yes, 0 errors; accepted warnings in [Open_Items](Documentation/Open_Items.md) |
| Offline tests | 10/10 pass |
| Main integration (`Tests/MainIntegration/main-it.js`) | 21/22 on 2026-10-08: all scenarios pass; 1 timing-dependent check fails (Open_Items I5) |
| Supervised run | yes, with the source in Studio / `uip rpa run` |
| Unattended | **the published package 26.10.0 is older than this source** (it reads the deprecated `10_DP_Supabase*` assets and lacks the 2026-10-08 fixes): republish first (Open_Items U1). Stop button unverified |

Assets (folder `Lyrebird`):

- `00_SH_SupabaseUrl` and `00_SH_SupabaseApiKey`: shared with 20_PF.
- `10_DP_MusicBrainzUserAgent`.
- `PersonalEmail` (folder `Shared`).

Deprecated but kept: `10_DP_SupabaseUrl` and `10_DP_SupabaseApiKey`, because the published 26.10.0 still uses them.

## Documents

- [Lyrebird_DataContract.md](Documentation/Lyrebird_DataContract.md): payloads, statuses, startup (§ 13.1), recovery runbooks (§ 13.7), 2026-10-08 changes (§ 14).
- [Outcome_Matrix.md](Documentation/Outcome_Matrix.md): for every failure, whether the job continues, rejects, retries or stops.
- [Open_Items.md](Documentation/Open_Items.md): owner actions, implementation items, analyzer exceptions (Todo Tree markers).

## Commands

```
uip rpa build . --governance-file-type AutomationOps --governance-file-path Governance/Lyrebird_10_DP.analyzer-policy.json --output json
uip rpa run --file-path "Tests/<Name>TestCase.xaml" --project-dir . --output json
node Tests/Tools/check-project-references.js
node Tests/MainIntegration/main-it.js run      # writes to the _Main_IT queues and LYREBIRD_IT MAIN rows
node Tests/MainIntegration/main-it.js cleanup
```

---

### Documentation is included in the Documentation folder ###


### REFrameWork Template ###
**Robotic Enterprise Framework**

* Built on top of *Transactional Business Process* template
* Uses *State Machine* layout for the phases of automation project
* Offers high level logging, exception handling and recovery
* Keeps external settings in *Config.xlsx* file and Orchestrator assets
* Pulls credentials from Orchestrator assets and *Windows Credential Manager*
* Gets transaction data from Orchestrator queue and updates back status
* Takes screenshots in case of system exceptions


### How It Works ###

1. **INITIALIZE PROCESS**
 + ./Framework/*InitiAllSettings* - Load configuration data from Config.xlsx file and from assets
 + ./Framework/*GetAppCredential* - Retrieve credentials from Orchestrator assets or local Windows Credential Manager
 + ./Framework/*InitiAllApplications* - Open and login to applications used throughout the process

2. **GET TRANSACTION DATA**
 + ./Framework/*GetTransactionData* - Fetches transactions from an Orchestrator queue defined by Config("OrchestratorQueueName") or any other configured data source

3. **PROCESS TRANSACTION**
 + *Process* - Process trasaction and invoke other workflows related to the process being automated 
 + ./Framework/*SetTransactionStatus* - Updates the status of the processed transaction (Orchestrator transactions by default): Success, Business Rule Exception or System Exception

4. **END PROCESS**
 + ./Framework/*CloseAllApplications* - Logs out and closes applications used throughout the process


### For New Project ###

1. Check the Config.xlsx file and add/customize any required fields and values
2. Implement InitiAllApplications.xaml and CloseAllApplicatoins.xaml workflows, linking them in the Config.xlsx fields
3. Implement GetTransactionData.xaml and SetTransactionStatus.xaml according to the transaction type being used (Orchestrator queues by default)
4. Implement Process.xaml workflow and invoke other workflows related to the process being automated
