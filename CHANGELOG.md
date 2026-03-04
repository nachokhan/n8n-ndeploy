# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and Semantic Versioning.

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
