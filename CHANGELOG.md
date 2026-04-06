# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and Semantic Versioning.

## [2.0.0] - 2026-04-05
### Added
- New project-first flow with `ndeploy create`, `ndeploy info`, `plan_summary.json`, `deploy_summary.json`, and `deploy_result.json`.
- New credential management workflow with `ndeploy credentials update` and `ndeploy credentials validate`.
- Editable `production_credentials.json` templates with PROD existence status and schema-aware field templates.
- Optional credential fill support from DEV or PROD using `--fill --side <source|target>`.
- Included generic n8n webhook fallback template and instructions under `n8n/` for credential export recovery.

### Changed
- Planning and deployment now operate around a persisted project model instead of the previous direct plan flow.
- Generated reports moved under `project/reports` and operator docs were refreshed across README, MANUAL, and site docs.
- CLI compatibility improved by pinning `ora` to v5 for Node 18 CommonJS environments.

### Fixed
- Credential fill can now fall back to an n8n endpoint when the standard API does not expose decrypted credential data.

## [1.4.0] - 2026-03-17
### Added
- New `--archived-workflows` filter in `ndeploy remove` to target archived workflows.
- New technical docs section under `docs/tech/` with operator-focused guides (`plan/apply`, `operations`, and `observability`).

### Changed
- Improved workflow equivalence checks in `plan` and `deploy` for observability-related fields, improving skip logic stability.
- Documentation updates in `README.md`, `README.es.md`, `README.de.md`, `MANUAL.md`, and `docs/index.html`.
- Project website docs index updated to include the GitHub repository link and technical docs navigation.

### Fixed
- Deployment now patches workflow self-references before workflow updates.
- Workflow dependency discovery now includes `settings.errorWorkflow` references in planning/dangling analysis.
- Orphan workflow detection now treats `settings.errorWorkflow` as a valid workflow reference.

## [1.3.0] - 2026-03-04
### Added
- New `ndeploy dangling-refs` command (alias: `ndeploy dangling`) to detect missing referenced entities.
- Required `--side <source|target>` option for `dangling-refs`.
- Reference filters for `dangling-refs`: `--workflows`, `--credentials`, `--data-tables`/`--datatables`, and `--all`.
- Pretty JSON output with summary and per-workflow dangling reference details.

### Changed
- Documentation updated in `README.md`, `README.es.md`, `README.de.md`, `MANUAL.md`, and `docs/index.html`.

## [1.2.0] - 2026-03-04
### Added
- New `ndeploy orphans` command to list unreferenced entities.
- Required `--side <source|target>` option for `orphans`.
- Entity filters for `orphans`: `--workflows`, `--credentials`, `--data-tables`/`--datatables`, and `--all`.
- Default behavior in `orphans` to include all entity types when no filter is provided.
- Pretty JSON output for orphans, including credential `type`.

### Changed
- Documentation updated in `README.md`, `README.es.md`, `README.de.md`, `MANUAL.md`, and `docs/index.html`.

## [1.1.0] - 2026-03-04
### Added
- New `ndeploy remove` command to remove workflows, credentials, and data tables.
- Selection options in `remove`: `--workflows`, `--credentials`, `--data-tables`/`--datatables`, and `--all`.
- Interactive safety confirmation for `remove` requiring the user to type `yes` when `--yes` is not present.
- `--yes` option to force execution without interactive prompt.
- `--dry-run` option for previewing deletions without executing.

### Changed
- Documentation updated in `README.md`, `README.es.md`, `README.de.md`, `MANUAL.md`, and `docs/index.html`.

## [1.0.0] - 2026-02-27
### Added
- Initial CLI release with `plan`, `apply`, and `publish` commands.
- Deterministic and idempotent DEV -> PROD deployment workflow for n8n.
