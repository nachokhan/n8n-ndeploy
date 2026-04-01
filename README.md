<p align="center">
  <img src="./img/ndploy-cover.png" alt="ndeploy cover" />
</p>

# ndeploy

Deterministic, idempotent TypeScript CLI to plan and apply **n8n** workflow deployments from **DEV -> PROD**.

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

## Requirements

- Node.js `>= 18`
- npm
- API access to DEV and PROD n8n instances

## Installation

```bash
npm install
npm run build
```

To run it as a direct command (without `npm run`):

```bash
npm link
```

Then use `ndeploy ...` directly.

## Configuration

Create `.env` (or copy from `.env.example`):

```env
N8N_DEV_URL=http://localhost:5678
N8N_DEV_API_KEY=dev_api_key
N8N_PROD_URL=http://localhost:5679
N8N_PROD_API_KEY=prod_api_key
```

## At a Glance

![Ndeploy professional guide](./img/ndeploy_guide.png)

## Commands

### 1) Create Workspace

```bash
ndeploy create <workflow_id_dev> [workspace_root]
```

Creates the workspace directory from the DEV workflow name and initializes `workspace.json`.
Optional `workspace_root` lets you choose where that folder is created (default: current directory).
Use `--force` to re-initialize metadata if the target workspace already exists.

### 2) Generate Plan

```bash
ndeploy plan <workspace>
```

Uses the root workflow configured in `<workspace>/workspace.json`.
Creates:
- `<workspace>/plan.json`
- `<workspace>/production_credentials.json`
- `<workspace>/reports/plan_summary.json`

If `plan.json` already exists, it's backed up as `plan_backup_<timestamp>.json`.

`ndeploy create` stores root workflow information in `workspace.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`

### 3) Apply Plan

```bash
ndeploy apply <workspace>
```

Executes the plan in PROD (credentials, data tables, workflows).
Writes:
- `<workspace>/reports/deploy_result.json`
- `<workspace>/reports/deploy_summary.json`

If deployment fails mid-run, partial result files are still written.

Force workflow updates even when PROD already matches:

```bash
ndeploy apply <workspace> --force-update
```

### 4) Manual Publish

```bash
ndeploy publish <workflow_id_prod>
```

Manual publish command for root workflow (or any workflow) in PROD.

### 5) Workspace Info

```bash
ndeploy info <workspace>
```

Shows workspace status in JSON:
- `workspace.json` metadata
- `plan.json` / `reports/plan_summary.json` / `production_credentials.json` presence and key metadata
- `reports/deploy_result.json` / `reports/deploy_summary.json` presence and key counters

Optional:

```bash
ndeploy info <workspace> --output <file_path>
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
ndeploy orphans <workspace> --side <source|target>
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
- Default output file (if `--output` is omitted): `<workspace>/reports/orphans_<side>.json`

Examples:

```bash
ndeploy orphans <workspace> --side target
ndeploy orphans <workspace> --side source --credentials
ndeploy orphans <workspace> --side target --workflows --datatables
```

### 8) Find Dangling References

```bash
ndeploy dangling-refs <workspace> --side <source|target>
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
- Default output file (if `--output` is omitted): `<workspace>/reports/dangling_<side>.json`

Examples:

```bash
ndeploy dangling-refs <workspace> --side target
ndeploy dangling <workspace> --side source --credentials
ndeploy dangling-refs <workspace> --side target --workflows --datatables
```

### 9) Validate Credential Templates

```bash
ndeploy credentials validate <workspace>
```

Validates `production_credentials.json` required fields (`template.required_fields` against `template.data`) and prints a JSON report.
It does not call DEV or PROD APIs. It only reads the local workspace file generated during `ndeploy plan <workspace>`.

Optional:

```bash
ndeploy credentials validate <workspace> --output <file_path>
ndeploy credentials validate <workspace> --strict
```

- `--output`: writes the validation report to file.
- `--strict`: exits with error when required fields are missing.

## Recommended Flow

1. `ndeploy create <workflow_id_dev> [workspace_root]`
2. `ndeploy plan <workspace>`
3. Review `reports/plan_summary.json` (and `plan.json` if needed).
4. Review `production_credentials.json` and complete missing PROD credentials.
5. Validate credentials: `ndeploy credentials validate <workspace> --strict`
6. `ndeploy apply <workspace>`
7. Review `reports/deploy_summary.json` (and `reports/deploy_result.json` if needed).
8. Human/manual publish of root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Important Behavior

- Idempotency:
  - Resources are matched in PROD by name whenever possible.
- Credentials:
  - Missing credentials are created as placeholders (no secrets copied).
  - Placeholder `data` is generated dynamically from credential schema.
  - `production_credentials.json` always lists all credentials used by the plan and marks:
    - `EXISTS_IN_PROD` + `KEEP` (do not touch)
    - `MISSING_IN_PROD` + `CREATE` (must be created/completed in PROD)
  - Each credential now includes `template.required_fields`, `template.fields`, and editable `template.data` (initialized with `null`) so you can fill values manually.
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
