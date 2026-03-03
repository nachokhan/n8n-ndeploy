# ndeploy

Deterministic, idempotent TypeScript CLI to plan and apply **n8n** workflow deployments from **DEV -> PROD**.

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
  cli/            # plan/apply/publish commands
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
