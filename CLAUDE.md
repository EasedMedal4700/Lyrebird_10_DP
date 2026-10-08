# UiPath Project: Lyrebird_10_DP

This is a UiPath automation project. When working on this project, use the appropriate
UiPath skill rather than editing project files directly — the skills understand UiPath
file formats, project conventions, and the `uip` CLI, and will keep the project valid.

## Which skill to use

- **uipath-rpa** — `.xaml` and coded (`.cs`) workflows, UI automation, Object Repository selectors, test cases. The default for most work in this project.
- **uipath-agents** — coded (Python: LangGraph / LlamaIndex / OpenAI) and low-code (`agent.json`) agents.
- **uipath-maestro-flow** — `.flow` Maestro orchestration files.
- **uipath-maestro-bpmn** — `.bpmn` process orchestration.
- **uipath-maestro-case** — case management plans.
- **uipath-coded-apps** — coded web and action apps (`app.config.json`, `action-schema.json`).
- **uipath-api-workflow** — JSON API workflows run by `uip api-workflow run`.
- **uipath-data-fabric** — Data Fabric entities and record CRUD.
- **uipath-human-in-the-loop** — authoring approval / validation / Human Task nodes.
- **uipath-solution** — `.uipx` solutions, SDD/PDD authoring, packaging and publishing.
- **uipath-platform** — Orchestrator, Studio Web, Integration Service, and LLM Gateway operations.
- **uipath-test** — Test Manager projects, cases, and executions.
- **uipath-review** — read-only audit of project structure and best practices.
- **uipath-troubleshoot** — diagnosing failures, errors, and regressions.

If you are unsure where to start, use **uipath-planner** to break the request into tasks
and route each to the right skill.

## Lyrebird specifics

### Database (Supabase)

The process reads and writes a self-hosted Supabase (`http://tower:8000`, Postgres schema `lyrebird`)
through `Workflows/Supabase/GetConnection.xaml`, `GetRows.xaml` and `UpdateRows.xaml`
(HTTP Request activity, PostgREST API). Use those workflows; don't add Invoke Code or Config.xlsx entries for this.

When you need the database structure (tables, columns, allowed status values, constraints), use either source:

- **Supabase itself**: the live database is the source of truth. Query it, for example by running `GetRows.xaml`.
- **The shared `DB` folder** `../Lyrebird_00_Shared/DB` (relative to this project folder; it is part of the
  `Lyrebird` parent repository, not of this project's repository): one `<table>.sql` file per table with its
  `create table` statement (for example `../Lyrebird_00_Shared/DB/wishlist.sql`).
  Don't use absolute paths: the user folder differs per machine.

If the `DB` folder doesn't exist, a table is missing from it, or its contents don't match what Supabase returns,
**tell the user** which table is missing or what differs. Don't silently work around it.
The user will then give you the current DDL so you can create or update the file.

### Orchestrator assets

Process assets live in the Orchestrator folder **`Lyrebird`** (not `Shared/Lyrebird`) and are named `10_DP_<Name>`.
Lyrebird assets used by several processes live in folder **`Lyrebird`** with prefix **`00_SH_`** (since 2026-10-08,
see `../Lyrebird_20_PF_Download/Documentation/Shared_Assets_Migration.md`). The older folder **`Shared`** (no prefix)
still holds `PersonalEmail`.

Used by the source (`Workflows/Supabase/GetConnection.xaml`, `Workflows/MusicBrainz/GetUserAgent.xaml`):

| Asset | Type | Purpose |
|---|---|---|
| `00_SH_SupabaseUrl` | Text | Supabase base URL (shared with 20_PF) |
| `00_SH_SupabaseApiKey` | Secret | Supabase API key (shared with 20_PF); read with Get Secret right before each request |
| `10_DP_MusicBrainzUserAgent` | Text | App name/version for the MusicBrainz User-Agent (`Lyrebird_10_DP/1.0.0`); missing/empty stops the job at startup |
| `PersonalEmail` (folder `Shared`) | Text | Contact email; `ValidateAlbum.xaml` sends `<10_DP_MusicBrainzUserAgent> ( <PersonalEmail> )` as User-Agent; missing/empty only warns |

Deprecated, kept on purpose (do not delete): `10_DP_SupabaseUrl`, `10_DP_SupabaseApiKey` (still read by the **published**
package 26.10.0 until 10_DP is republished; rollback). Not read by any workflow: `10_DP_DataFolder` (10_DP needs no data
root), `10_DP_SlsknetLogin` (Soulseek login; no process logs in).
