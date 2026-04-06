<p align="center">
  <img src="./img/ndploy-cover.png" alt="ndeploy cover" />
</p>

# ndeploy

Deterministic, idempotent TypeScript CLI to plan and apply **n8n** workflow deployments from **DEV -> PROD**.

## License

This project is licensed under **Business Source License 1.1**. Professional
services and internal business use are allowed, including paid n8n consulting
and workflow delivery, but creating or monetizing a product, hosted service,
SaaS, white-label, OEM, or commercial bundle based substantially on this
project is not allowed. See [`LICENSE`](./LICENSE).

## Installation Guide

This is the fastest way to get `ndeploy` running for any user on macOS, Linux, or Ubuntu servers.

### 1) Requirements

- Node.js `>= 18`
- npm
- API access to DEV and PROD n8n instances

Check your Node version:

```bash
node -v
```

### 2) Fresh Install

Clone the repository, install dependencies, build the CLI, and link it globally:

```bash
git clone https://github.com/nachokhan/n8n-ndeploy.git ndeploy
cd n8n-ndeploy
npm install
npm run build
chmod +x dist/index.js
sudo npm link
ndeploy --help
```

If `ndeploy --help` prints the command list, the CLI is ready to use.

### 3) Update an Existing Install

If the project is already installed on a server, update it like this:

```bash
cd /your/ndeploy/folder
git pull
npm run build
chmod +x dist/index.js
sudo npm link
ndeploy --help
```

This is enough after pulling new changes, even on Ubuntu, as long as the server is running Node.js 18 or newer.

### 4) Configure Environment Variables

Create `.env` (or copy from `.env.example`):

```env
N8N_DEV_URL=http://localhost:5678
N8N_DEV_API_KEY=dev_api_key
N8N_PROD_URL=http://localhost:5679
N8N_PROD_API_KEY=prod_api_key
# Optional fallback for credentials fill:
# N8N webhook endpoint that returns credential data by requested ids
N8N_DEV_CREDENTIAL_EXPORT_URL=
# Bearer token for that endpoint
N8N_DEV_CREDENTIAL_EXPORT_TOKEN=
# Optional fallback when using `ndeploy credentials update --fill --side target`
N8N_PROD_CREDENTIAL_EXPORT_URL=
N8N_PROD_CREDENTIAL_EXPORT_TOKEN=
```

### 5) First Smoke Test

Run:

```bash
ndeploy --help
```

Then you can start with:

```bash
ndeploy create <workflow_id_dev> [project_root]
```

## Did this app help you?
If this app was useful to you, you can buy me a flat white or expresso as a thank you.

[![Buy me a cortadito](https://cdn.cafecito.app/imgs/buttons/button_6.svg)](https://cafecito.app/nachokhan)

## Documentation Languages

- English (official): `README.md`
- Spanish (secondary): [`README.es.md`](./README.es.md)
- German: [`README.de.md`](./README.de.md)

## What It Does

- Recursively discovers workflow dependencies:
  - sub-workflows
  - credentials
  - data tables
- Generates a reproducible deployment plan JSON.
- Applies the plan in PROD with `DEV_ID -> PROD_ID` mapping.
- Patches internal workflow references without global string replacements.
- Auto-publishes sub-workflows when needed.
- Never auto-publishes the root workflow (manual human action only).

## At a Glance

![Ndeploy professional guide](./img/ndeploy_guide.png)

## Commands

### 1) Create Project

```bash
ndeploy create <workflow_id_dev> [project_root]
```

Creates the project directory from the DEV workflow name and initializes `project.json`.
Optional `project_root` lets you choose where that folder is created (default: current directory).
Use `--force` to re-initialize metadata if the target project already exists.

### 2) Generate Plan

```bash
ndeploy plan <project>
```

Uses the root workflow configured in `<project>/project.json`.
Creates:
- `<project>/plan.json`
- `<project>/reports/plan_summary.json`

If `plan.json` already exists, it's backed up as `plan_backup_<timestamp>.json`.

`ndeploy create` stores root workflow information in `project.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`

### 3) Apply Plan

```bash
ndeploy apply <project>
```

Executes the plan in PROD (credentials, data tables, workflows).
Writes:
- `<project>/reports/deploy_result.json`
- `<project>/reports/deploy_summary.json`

If deployment fails mid-run, partial result files are still written.

Force workflow updates even when PROD already matches:

```bash
ndeploy apply <project> --force-update
```

### 4) Manual Publish

```bash
ndeploy publish <workflow_id_prod>
```

Manual publish command for root workflow (or any workflow) in PROD.

### 5) Project Info

```bash
ndeploy info <project>
```

Shows project status in JSON:
- `project.json` metadata
- `plan.json` / `reports/plan_summary.json` / `production_credentials.json` presence and key metadata
- `reports/deploy_result.json` / `reports/deploy_summary.json` presence and key counters

Optional:

```bash
ndeploy info <project> --output <file_path>
```

### 6) Remove Resources

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Removes selected resources from PROD.

- IDs use CSV format: `id1,id2,id3`
- Alias: `--datatables` (same as `--data-tables`)
- Shortcut for everything: `--all`
- `--archived-workflows` limits workflow deletion to archived workflows only
- Confirmation behavior:
  - with `--yes`: executes immediately
  - without `--yes`: asks to type `yes` interactively in console

Examples:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --workflows all --archived-workflows --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

### 7) Find Orphans

```bash
ndeploy orphans <project> --side <source|target>
```

Lists entities not referenced by any non-archived workflow and prints pretty JSON.

- `--side` is required:
  - `source` -> uses `N8N_DEV_*`
  - `target` -> uses `N8N_PROD_*`
- Entity filters:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (alias: `--datatables`)
  - `--all`
- If no entity filter is provided, it defaults to `--all`.
- Default output file (if `--output` is omitted): `<project>/reports/orphans_<side>.json`

Examples:

```bash
ndeploy orphans <project> --side target
ndeploy orphans <project> --side source --credentials
ndeploy orphans <project> --side target --workflows --datatables
```

### 8) Find Dangling References

```bash
ndeploy dangling-refs <project> --side <source|target>
```

Lists workflows that reference entities which no longer exist.

- `--side` is required:
  - `source` -> uses `N8N_DEV_*`
  - `target` -> uses `N8N_PROD_*`
- Reference filters:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (alias: `--datatables`)
  - `--all`
- If no reference filter is provided, it defaults to `--all`.
- Alias command: `ndeploy dangling`
- Default output file (if `--output` is omitted): `<project>/reports/dangling_<side>.json`

Examples:

```bash
ndeploy dangling-refs <project> --side target
ndeploy dangling <project> --side source --credentials
ndeploy dangling-refs <project> --side target --workflows --datatables
```

### 9) Update Credential File

```bash
ndeploy credentials update <project>
```

Creates or updates `<project>/production_credentials.json` from DEV root workflow dependencies (recursive sub-workflows).

- If file does not exist:
  - creates all active credentials with required template fields.
  - `--fill` pre-fills as much as DEV API provides.
- If file exists:
  - adds new credentials detected in DEV.
  - moves no-longer-used credentials to `archived_credentials`.
  - keeps existing `active_credentials` entries untouched (except name sync by `dev_id`).
  - `--fill` applies only to newly added credentials.
- Special case: when using `--fill --side target`, existing active credentials are also refreshed with values resolved from PROD.
- `--side` controls where `--fill` obtains credential values:
  - `source` (default): resolve values from DEV.
  - `target`: try to resolve values from PROD by credential name match.
- Fill source order when `--fill --side source` is used:
  - DEV public API first.
  - Optional fallback webhook (`N8N_DEV_CREDENTIAL_EXPORT_URL` + `N8N_DEV_CREDENTIAL_EXPORT_TOKEN`) for credentials still unresolved.
- Fill source order when `--fill --side target` is used:
  - PROD public API first, using name-matched credentials in PROD.
  - Optional fallback webhook (`N8N_PROD_CREDENTIAL_EXPORT_URL` + `N8N_PROD_CREDENTIAL_EXPORT_TOKEN`) for credentials still unresolved.

Optional:

```bash
ndeploy credentials update <project> --fill
ndeploy credentials update <project> --fill --side source
ndeploy credentials update <project> --fill --side target
```

### 10) Validate Credential Templates

```bash
ndeploy credentials validate <project>
```

Validates active credentials required fields (`template.required_fields` against `template.data`) and prints a JSON report.
It does not call DEV or PROD APIs. It only reads `<project>/production_credentials.json`.

Optional:

```bash
ndeploy credentials validate <project> --output <file_path>
ndeploy credentials validate <project> --strict
```

- `--output`: writes the validation report to file.
- `--strict`: exits with error when required fields are missing.

## Recommended Flow

1. `ndeploy create <workflow_id_dev> [project_root]`
2. `ndeploy plan <project>`
3. Review `reports/plan_summary.json` (and `plan.json` if needed).
4. Update credentials file: `ndeploy credentials update <project> --fill`
5. Review/adjust `production_credentials.json` for PROD values.
6. Validate credentials: `ndeploy credentials validate <project> --strict`
7. `ndeploy apply <project>`
8. Review `reports/deploy_summary.json` (and `reports/deploy_result.json` if needed).
9. Human/manual publish of root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Important Behavior

- Idempotency:
  - Resources are matched in PROD by name whenever possible.
- Credentials:
  - `production_credentials.json` is managed by `ndeploy credentials update`, not by `plan`.
  - File structure uses:
    - `active_credentials`: credentials currently used by root workflow graph.
    - `archived_credentials`: credentials no longer used but kept as historical entries.
  - Each active credential includes `template.required_fields`, `template.fields`, and editable `template.data`.
- Data tables:
  - Created/mapped by name.
  - Schema mismatch adds warnings in the plan.
- Workflows:
  - Write payloads are sanitized to comply with n8n public API schema.
  - Before execution, DEV freshness is validated for all workflow actions (`payload.checksum`).
  - Workflow actions include informative `observability` fields in the plan:
    - `prod_comparison_at_plan`: `equal|different|unknown|not_applicable`
    - `comparison_reason`: reason for the observed result at plan generation time.
  - Plan observability is a point-in-time snapshot; `apply` remains the source of truth for final `UPDATE` vs `SKIP`.
  - Equivalence comparison ignores non-functional metadata (for example `node.position`, `node.id`, `credentials.*.name`, `staticData`) to reduce false positives.
  - `UPDATE` actions are skipped when normalized PROD content is already equivalent.
  - `--force-update` disables skip logic and always executes workflow updates.
  - ID patching targets:
    - `node.credentials.*.id`
    - `parameters.workflowId`
    - `parameters.dataTableId` / `parameters.tableId`
    - `settings.errorWorkflow`
- Publishing policy:
  - Sub-workflows can be auto-published during `apply`.
  - Root workflow is never auto-published.

## Logging

Detailed step logging is included:

- Plan: `[PLAN][..]`
- Deploy: `[DEPLOY][VAL][..]` and `[DEPLOY][RUN][..]`
- API client: `[N8N_CLIENT]`

This makes failures traceable by phase, entity, and API response context.

## Useful Scripts

```bash
npm run dev -- --help
npm run typecheck
npm run build
```

## Project Structure

```text
src/
  cli/            # create/plan/apply/publish/info/remove/orphans/dangling commands
  services/       # API, planning, deploy, transforms
  types/          # Zod schemas + TS types
  utils/          # env, logger, hash, file helpers
  errors/         # ApiError / DependencyError / ValidationError
```

## Quick Troubleshooting

- `must have required property 'connections'`:
  - Plan was generated with incomplete workflow payload; regenerate plan.
- `must NOT have additional properties`:
  - Workflow/settings payload includes unsupported fields.
- `referenced workflow ... is not published`:
  - A called sub-workflow in PROD is not published yet.
- `405 GET method not allowed` on credentials:
  - n8n does not support `GET /credentials/{id}`; use list + resolve.
