---
name: ndeploy-operator
description: Operate n8n ndeploy projects safely from Codex. Use when a user asks to inspect, create, plan, validate, compare, prepare, apply, publish, remove, or troubleshoot an ndeploy project, n8n source-to-target deployment, project.json, plan.json, credentials_manifest.json, plan_summary.json, deploy_summary.json, credential export fallback, orphan/dangling checks, or any workflow deployment using the local ndeploy CLI. Always require explicit user confirmation before running apply, publish, remove, or any destructive/externally visible operation.
---

# ndeploy Operator

## Core Rule

Be useful, but not complacent. Distinguish "the command can run" from "this is operationally safe."

Never run these commands without explicit user confirmation in the current conversation:

- `ndeploy apply` or `npm run start -- apply`
- `ndeploy publish` or `npm run start -- publish`
- `ndeploy remove` or `npm run start -- remove`
- any command that activates, deactivates, deletes, publishes, or mutates production resources

Before asking for confirmation, summarize exactly what will change: credentials, data tables, workflows, root publish status, warnings, and residual risks.

## Command Style

First determine whether `ndeploy` is available globally:

```bash
command -v ndeploy
ndeploy --help
```

If the repo was just cloned and `ndeploy` is not available, install it from the ndeploy repo root:

```bash
npm install
npm run build
npm link
```

Verify:

```bash
which ndeploy
ndeploy --help
```

After source code changes, run `npm run build` again. Re-run `npm link` only if the global link is missing or the package/bin metadata changed.

Prefer the repo-local CLI when actively developing ndeploy itself:

```bash
npm run start -- <command>
```

Use globally linked `ndeploy <command>` when operating projects from outside the ndeploy repository or when the user expects a git-like installed command.

If `npm run start` uses stale `dist` after code changes, run:

```bash
npm run build
```

Use read-only commands freely when they help answer the user:

- `info`
- `plan`
- `credentials fetch`
- `credentials compare`
- `credentials validate`
- `orphans`
- `dangling`

Treat `plan` as read-only with local artifact writes: it can regenerate `plan.json`, `reports/plan_summary.json`, and backup the previous plan.

## Project Discovery

When the user references a project name, first locate it:

```bash
find . -maxdepth 3 -name project.json -o -name plan.json
```

Then run:

```bash
npm run start -- info <project>
```

Read `project.json` for:

- `plan.root_workflow_id_source`
- `plan.root_workflow_name`
- `deploy.profile`

If no project exists, do not invent the root workflow ID. Ask for it or discover candidate workflows with available n8n tooling.

## Standard Status Workflow

For "estado", "status", "plan", "estamos listos", or similar:

1. Run `info <project>`.
2. Inspect `reports/plan_summary.json` if present.
3. Check whether `reports/deploy_result.json` and `reports/deploy_summary.json` exist.
4. If n8n tooling is available, validate the source root workflow and inspect recent executions.
5. Call out stale artifacts: for example, plan generated before the source workflow was last updated.

Report status as one of:

- No project initialized.
- Project initialized, no current plan.
- Plan ready, credentials incomplete.
- Plan ready, credentials valid, not applied.
- Applied with failures.
- Applied successfully but root not published.
- Applied and root published, if verified.

## Pre-Deploy Workflow

Use this sequence before any apply:

```bash
npm run start -- plan <project>
npm run start -- credentials fetch <project> --side both
npm run start -- credentials compare <project> --format table
```

Then inspect credential actions from `plan.json` or `reports/plan_summary.json`.

If any credential has action `CREATE`, run:

```bash
npm run start -- credentials merge-missing <project> --side source
npm run start -- credentials validate <project> --side manifest
```

If no credential has action `CREATE`, the manifest is not required for apply.

Read [references/commands.md](references/commands.md) for output interpretation and command details when needed.

## Credential Semantics

Do not confuse `credentials compare` with deployment behavior.

- `MAP_EXISTING`: target credential exists and apply should map to it. It should not copy, overwrite, or re-create credential data.
- `CREATE`: target credential is missing and apply must create it using `credentials_manifest.json`.
- `different` in `credentials compare`: source and target data differ. This is often expected for OAuth, Google, Redis, and environment-specific secrets.
- `missing_in_target`: target credential does not exist for that source dependency. If the plan says `CREATE`, manifest data must be ready.

For environment-specific credentials, differences are not automatically bad. Be critical:

- OAuth client IDs/secrets often differ by environment.
- Redis `host`/`password` may differ by environment.
- A webhook shared secret may need to be copied exactly if production workflows depend on the same external caller.

## Credential Export Fallback

If direct credential API reads log `403`, do not conclude failure immediately. ndeploy may use `credential_export_url` and `credential_export_token`.

Verify success by inspecting snapshots without printing secret values:

```bash
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('<project>/credentials_source.json','utf8')); console.table(j.credentials.map(c=>({name:c.name,type:c.type,resolution:c.resolution,hasData:Object.keys(c.template?.data||{}).length>0,note:c.template?.note})))"
```

If `hasData` is false for a `CREATE` credential, stop and explain that apply may create an unusable credential.

## Apply Gate

Before asking to run apply, present:

- Project path and profile.
- Source and target instance names/URLs if available.
- Credential actions: `MAP_EXISTING` vs `CREATE`.
- Data table actions.
- Workflow actions: `CREATE`, `UPDATE`, skipped/equal if known.
- Any warnings from validation, compare, plan, or recent failed executions.
- Confirmation that `credentials_manifest.json` exists and validates if credential creation is required.

Ask a direct confirmation question. Example:

```text
¿Confirmás que ejecute apply contra production para este proyecto?
```

Only after explicit confirmation, run:

```bash
npm run start -- apply <project>
```

After apply, immediately read and summarize:

```bash
npm run start -- info <project>
```

and inspect `reports/deploy_summary.json`.

## Publish Gate

ndeploy does not auto-publish the root workflow. It may auto-publish subworkflows when appropriate.

After successful apply:

1. Identify the target root workflow ID from `deploy_result.json` or target lookup.
2. Explain that publishing makes the root externally active.
3. Ask for explicit confirmation.
4. Only then run `publish`.

## Remove Gate

Treat `remove` as destructive. Before any remove:

1. Prefer `orphans` and `dangling` reports first.
2. Present exact resource IDs/names to delete.
3. Require explicit confirmation.
4. Avoid `--all` unless the user explicitly asks and confirms.

## Final Response Standards

Keep the final answer short and operational:

- What was checked.
- What the result means.
- Whether it is safe to proceed.
- Exact next command only when useful.

Never expose credential secret values in chat. Report only names, types, action, missing fields, and whether data exists.
