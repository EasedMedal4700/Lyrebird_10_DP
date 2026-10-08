# Lyrebird_10_DP: open items

Status 2026-10-08. The markers are UiPath annotations in this format:

`TAG [CATEGORY]: what is missing. Why: impact. Done when: proof.`

The tags are `FIXME [BLOCKER]`, `TODO [USER]` and `TODO [IMPLEMENTATION]`. Todo Tree finds them through [.vscode/settings.json](../.vscode/settings.json), which uses the default tags and extends the regex to annotations. A ripgrep run with that regex finds exactly the 2 markers listed below. Process 20 uses the same convention: `../Lyrebird_20_PF_Download/Documentation/Open_Items.md`.

## Blockers

None for 10_DP itself. The source builds, its tests pass, and it runs supervised. The pipeline as a whole is blocked in 20_PF (UI capture, real downloads).

## Owner actions

| ID | Action | Why | Done when |
|---|---|---|---|
| U1 | **Republish 10_DP** after reviewing the 2026-10-08 changes | The published 26.10.0 still reads `10_DP_SupabaseUrl` / `10_DP_SupabaseApiKey` and has none of the robustness fixes (DataContract § 14) | a new version runs in Orchestrator; then the deprecated `10_DP_Supabase*` assets can be retired (keep them until then) |
| U2 | Verify the Orchestrator **Stop** button in a supervised job | Unverified (§ 13.6) | Stop while items remain: the job ends after the current item |
| U3 | Decide the ST-SEC-009 risk reductions (HTTPS, dedicated Postgres role instead of `service_role`) | Accepted risk (§ 9) | decision recorded |

## Implementation items

| ID | Item | Marker | Done when |
|---|---|---|---|
| I1 | A lost response on the claim PATCH is classified as a human edit (Failed Business, reservation held) | TODO [IMPLEMENTATION] in [ProcessValidateQueueItem.xaml](../Workflows/Wishlist/ProcessValidateQueueItem.xaml) (`Try claim`) | a re-read that shows the claim already applied counts as success; fault-injection test |
| I2 | A business rejection after the claim keeps the reservation, so other rows for that album show as `DUPLICATE` until resolved | none: documented in DataContract § 11.5 / § 14.2 | release the reservation when no output item exists, or keep it documented |
| I3 | Test rows are recognised by the editable `message` column. A resubmitted `LYREBIRD_IT` row (resubmission SQL sets `message = null`) becomes a production row | TODO [IMPLEMENTATION] in [BuildRunSettings.xaml](../Workflows/Main/BuildRunSettings.xaml) (`Assign out_LoadQuery`) | a fixed marker (e.g. an additive `wishlist.is_test` column) is used by 10 and 20 |
| I4 | Fault injection for the new startup checks and the Get/Set Transaction Status stops is not automated in 10_DP | none (test gap) | a test with an unreachable Supabase / missing User-Agent asset |
| I5 | main-it check "MusicBrainz spacing kept across transactions" is **timing-dependent** and failed in all three runs of 2026-10-08. A wait, and its log, happen only when two MusicBrainz requests would start within 1 s (1.1 s for the release lookup). Run 4 evidence: 3 requests, no wait needed. The CLI log entries carry no timestamps, so the spacing cannot be measured from the outside. The spacing logic itself is unchanged; S5 proves its state survives re-initialization. Both waits now log at Info | none (test gap) | a deterministic test: two ValidateAlbum/GetReleaseGroupReleases calls back to back must log a wait |

## Accepted analyzer findings (maintainability only; none blocks compilation or execution)

The analyzed build with `Governance/Lyrebird_10_DP.analyzer-policy.json` passes with 0 errors and 73 warnings (2026-10-08, after the fixes below; 78 before). Unresolved: none.

| Rule | Count | Why it stays |
|---|---|---|
| ST-NMG-004 duplicate display names | 29 | template and generic names (`Then`, `Else`, `Try`, `Catch`, `Body`) repeated in different scopes |
| SY-USG-015 optional argument not passed | 28 | optional test/diagnostic arguments (`in_FailAfterStep`, `in_WaitUntilFoundSeconds`, `out_*` counters, the unused `out_Rows` of the startup Supabase probe) |
| ST-USG-020 no Log Message | 9 | pure decision workflows must not log; the caller logs |
| ST-MRD-007 nesting > 3 | 5 | ProcessValidateQueueItem's guarded write sequence; splitting it would spread the guard logic over more files |
| ST-PRR-004 Delay | 1 | a bounded 1 s poll in FindQueueItemByReference (Orchestrator lists new items with a delay) |
| ST-USG-034 Automation Hub URL | 1 | an organization setting |

Fixed in the 2026-10-08 review:

- ST-NMG-005 (`MissResult` / `MissMessage` defined twice in ProcessValidateQueueItem: the final-update scope now uses `FinalMiss*`).
- ST-USG-009 (unused `DiscardInt` / `DiscardList` in QueueReferenceIntegrationTestCase).
- The new duplicate names in Main that this review had introduced.
