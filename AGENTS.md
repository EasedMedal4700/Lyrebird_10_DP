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
- **The `DB` folder** next to this project (`../DB`, i.e. `C:\Users\fquaa\Documents\UiPath\Lyrebird\DB`):
  one `<table>.sql` file per table with its `create table` statement (for example `DB/wishlist.sql`).

If the `DB` folder doesn't exist, a table is missing from it, or its contents don't match what Supabase returns,
**tell the user** which table is missing or what differs. Don't silently work around it.
The user will then give you the current DDL so you can create or update the file.

### Orchestrator assets

All assets live in the Orchestrator folder **`Lyrebird`** (not `Shared/Lyrebird`) and are named `10_DP_<Name>`:

| Asset | Type | Purpose |
|---|---|---|
| `10_DP_SupabaseUrl` | Text | Supabase base URL |
| `10_DP_SupabaseApiKey` | Secret | Supabase API key |
| `10_DP_SlsknetLogin` | Credential | Soulseek login |
| `10_DP_DataFolder` | Text | Root data folder (`C:\Lyrebird_Data`); build subfolder paths from it, no asset per subfolder |
