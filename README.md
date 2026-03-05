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

### 1) Generate Plan

```bash
ndeploy plan flow <workflow_id_dev>
```

Creates `plan_<id>_<timestamp>.json` with metadata and ordered actions.

### 2) Apply Plan

```bash
ndeploy apply <plan_file_path>
```

Executes the plan in PROD (credentials, data tables, workflows).

Force workflow updates even when PROD already matches:

```bash
ndeploy apply <plan_file_path> --force-update
```

### 3) Manual Publish

```bash
ndeploy publish <workflow_id_prod>
```

Manual publish command for root workflow (or any workflow) in PROD.

### 4) Remove Resources

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

### 5) Find Orphans

```bash
ndeploy orphans --side <source|target>
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

Examples:

```bash
ndeploy orphans --side target
ndeploy orphans --side source --credentials
ndeploy orphans --side target --workflows --datatables
```

### 6) Find Dangling References

```bash
ndeploy dangling-refs --side <source|target>
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

Examples:

```bash
ndeploy dangling-refs --side target
ndeploy dangling --side source --credentials
ndeploy dangling-refs --side target --workflows --datatables
```

## Recommended Flow

1. `ndeploy plan flow <workflow_id_dev>`
2. Review generated plan JSON.
3. `ndeploy apply <plan_file_path>`
4. Human/manual publish of root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Important Behavior

- Idempotency:
  - Resources are matched in PROD by name whenever possible.
- Credentials:
  - Missing credentials are created as placeholders (no secrets copied).
  - Placeholder `data` is generated dynamically from credential schema.
- Data tables:
  - Created/mapped by name.
  - Schema mismatch adds warnings in the plan.
- Workflows:
  - Write payloads are sanitized to comply with n8n public API schema.
  - Before execution, DEV freshness is validated for all workflow actions (`payload.checksum`).
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
  cli/            # plan/apply/publish/remove/orphans/dangling commands
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
