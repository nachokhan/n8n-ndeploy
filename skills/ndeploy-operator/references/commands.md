# ndeploy Command Reference

## Install Global Command

From the ndeploy repository root:

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

Use `npm run start -- <command>` when developing inside the ndeploy repo. Use `ndeploy <command>` from any other project once linked.

If TypeScript source changes, run:

```bash
npm run build
```

No need to repeat `npm link` unless the link is missing or `package.json` bin metadata changed.

## Read Status

```bash
npm run start -- info <project>
# or, once installed globally:
ndeploy info <project>
```

Shows project metadata and whether these artifacts exist:

- `plan.json`
- `reports/plan_summary.json`
- `credentials_source.json`
- `credentials_target.json`
- `credentials_manifest.json`
- `reports/deploy_result.json`
- `reports/deploy_summary.json`

No production mutation.

## Generate Plan

```bash
npm run start -- plan <project>
# or:
ndeploy plan <project>
```

Builds source-to-target plan from `project.json`.

Writes:

- `<project>/plan.json`
- `<project>/reports/plan_summary.json`

Backs up old plan if present. Does not apply to target.

## Credential Snapshot

```bash
npm run start -- credentials fetch <project> --side source
npm run start -- credentials fetch <project> --side target
npm run start -- credentials fetch <project> --side both
# or:
ndeploy credentials fetch <project> --side both
```

Writes credential snapshots. Direct API may log 403 for secret reads; fallback export endpoint may still fill data.

Check data presence without printing secrets:

```bash
node -e "const fs=require('fs'); for (const side of ['source','target']) { const p='<project>/credentials_'+side+'.json'; if (!fs.existsSync(p)) continue; const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(side); console.table(j.credentials.map(c=>({name:c.name,type:c.type,resolution:c.resolution,hasData:Object.keys(c.template?.data||{}).length>0,note:c.template?.note}))); }"
```

## Credential Compare

```bash
npm run start -- credentials compare <project> --format table
# or:
ndeploy credentials compare <project> --format table
```

Statuses:

- `identical`: source and target snapshot data match.
- `different`: source and target data differ.
- `missing_in_target`: no target credential matched by source dependency.
- `missing_in_source`: snapshot inconsistency; investigate.
- `type_mismatch`: names/IDs match but types differ; high risk.

Compare does not decide deployment behavior. The plan action decides.

## Manifest Merge

```bash
npm run start -- credentials merge-missing <project> --side source
# or:
ndeploy credentials merge-missing <project> --side source
```

Adds missing credentials to `credentials_manifest.json` from source snapshot. It does not overwrite existing manifest entries and does not touch n8n.

Use when plan has credential `CREATE`.

## Manifest Validate

```bash
npm run start -- credentials validate <project> --side manifest
# or:
ndeploy credentials validate <project> --side manifest
```

Checks manifest entries for missing required fields.

Use `--strict` only when the repository's validator/schema is known to represent all runtime requirements accurately.

## Credential Action Table

```bash
node -e "const p=require('./<project>/plan.json'); console.table(p.actions.filter(a=>a.type==='CREDENTIAL').map(a=>({name:a.name, action:a.action, target_id:a.target_id})))"
```

Interpretation:

- `MAP_EXISTING`: apply maps references to existing target credential. It should not re-create or overwrite that credential.
- `CREATE`: apply creates a credential in target from `credentials_manifest.json`.

## Apply

```bash
npm run start -- apply <project>
# or:
ndeploy apply <project>
```

Requires explicit user confirmation. Mutates target by creating/updating credentials, data tables, and workflows according to `plan.json`.

If the plan includes credential `CREATE`, apply requires `credentials_manifest.json`.

Writes:

- `<project>/reports/deploy_result.json`
- `<project>/reports/deploy_summary.json`

## Publish

```bash
npm run start -- publish <target_workflow_id>
# or:
ndeploy publish <target_workflow_id>
```

Requires explicit user confirmation. Makes target workflow active. The root workflow is not auto-published by apply.

## Orphans and Dangling

```bash
npm run start -- orphans <project> --side source
npm run start -- orphans <project> --side target
npm run start -- dangling <project> --side source
npm run start -- dangling <project> --side target
# or:
ndeploy orphans <project> --side target
ndeploy dangling <project> --side target
```

Use before cleanup or when investigating unexplained references.
