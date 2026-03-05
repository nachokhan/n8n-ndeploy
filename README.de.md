<p align="center">
  <img src="./img/ndploy-cover.png" alt="ndeploy cover" />
</p>

# ndeploy

TypeScript-CLI zum deterministischen und idempotenten Deployment von **n8n**-Workflows von **DEV -> PROD**.

## Hat dir diese App geholfen?
Wenn dir die App geholfen hat, kannst du mir als Dank einen Flat White oder Expresso spendieren.

[![Spendier mir einen Cortadito](https://cdn.cafecito.app/imgs/buttons/button_6.svg)](https://cafecito.app/nachokhan)

## Dokumentationssprachen

- Englisch (offiziell): [`README.md`](./README.md)
- Spanisch (sekundär): [`README.es.md`](./README.es.md)
- Deutsch: `README.de.md`

## Funktionsumfang

- Rekursive Abhängigkeitsanalyse eines Workflows:
  - Sub-Workflows
  - Credentials
  - Data Tables
- Erzeugt einen reproduzierbaren Deployment-Plan (JSON).
- Führt den Plan in PROD mit `DEV_ID -> PROD_ID`-Mapping aus.
- Patcht interne ID-Referenzen ohne globales String-Replacing.
- Veröffentlicht Sub-Workflows automatisch bei Bedarf.
- Veröffentlicht den Root-Workflow niemals automatisch (nur manuell).

## Voraussetzungen

- Node.js `>= 18`
- npm
- API-Zugriff auf n8n DEV und PROD

## Installation

```bash
npm install
npm run build
```

Für direkte Nutzung ohne `npm run`:

```bash
npm link
```

Danach kann `ndeploy ...` direkt genutzt werden.

## Konfiguration

`.env` erstellen (oder `.env.example` kopieren):

```env
N8N_DEV_URL=http://localhost:5678
N8N_DEV_API_KEY=dev_api_key
N8N_PROD_URL=http://localhost:5679
N8N_PROD_API_KEY=prod_api_key
```

## Schnellüberblick

![Ndeploy Professional Guide](./img/ndeploy_guide.png)

## Befehle

### 1) Plan erzeugen

```bash
ndeploy plan flow <workflow_id_dev>
```

Erzeugt `plan_<id>_<timestamp>.json` mit Metadaten und Aktionen.

### 2) Plan anwenden

```bash
ndeploy apply <plan_file_path>
```

Führt den Plan in PROD aus (Credentials, Data Tables, Workflows).

Workflow-Updates erzwingen, auch wenn PROD bereits äquivalent ist:

```bash
ndeploy apply <plan_file_path> --force-update
```

### 3) Manuell veröffentlichen

```bash
ndeploy publish <workflow_id_prod>
```

Manueller Publish-Befehl für Root-Workflow (oder beliebigen Workflow) in PROD.

### 4) Ressourcen löschen

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Löscht ausgewählte Ressourcen in PROD.

- IDs als CSV: `id1,id2,id3`
- Alias: `--datatables` (gleich wie `--data-tables`)
- Shortcut für alles: `--all`
- `--archived-workflows` begrenzt Workflow-Löschungen auf archivierte Workflows
- Bestätigung:
  - mit `--yes`: sofort ausführen
  - ohne `--yes`: interaktive Eingabe von `yes` in der Konsole

Beispiele:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --workflows all --archived-workflows --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

### 5) Orphans finden

```bash
ndeploy orphans --side <source|target>
```

Listet Entitäten auf, die von keinem nicht-archivierten Workflow referenziert werden, und gibt Pretty-JSON aus.

- `--side` ist Pflicht:
  - `source` -> nutzt `N8N_DEV_*`
  - `target` -> nutzt `N8N_PROD_*`
- Entitätsfilter:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (Alias: `--datatables`)
  - `--all`
- Ohne Entitätsfilter wird automatisch `--all` verwendet.

Beispiele:

```bash
ndeploy orphans --side target
ndeploy orphans --side source --credentials
ndeploy orphans --side target --workflows --datatables
```

### 6) Dangling References finden

```bash
ndeploy dangling-refs --side <source|target>
```

Listet Workflows auf, die Entitäten referenzieren, die nicht mehr existieren.

- `--side` ist Pflicht:
  - `source` -> nutzt `N8N_DEV_*`
  - `target` -> nutzt `N8N_PROD_*`
- Referenzfilter:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (Alias: `--datatables`)
  - `--all`
- Ohne Filter wird automatisch `--all` verwendet.
- Alias-Befehl: `ndeploy dangling`

Beispiele:

```bash
ndeploy dangling-refs --side target
ndeploy dangling --side source --credentials
ndeploy dangling-refs --side target --workflows --datatables
```

## Empfohlener Ablauf

1. `ndeploy plan flow <workflow_id_dev>`
2. Erzeugten Plan prüfen.
3. `ndeploy apply <plan_file_path>`
4. Root-Workflow manuell veröffentlichen:
   - `ndeploy publish <root_workflow_id_prod>`

## Wichtige Hinweise

- Idempotenz:
  - Ressourcen werden, wenn möglich, per Name in PROD gemappt.
- Credentials:
  - Fehlende Credentials werden als Platzhalter erstellt (ohne Secrets).
  - Platzhalter-`data` wird dynamisch aus dem Credential-Schema erzeugt.
- Data Tables:
  - Erstellung/Mapping über Namen.
  - Schema-Unterschiede erzeugen Warnings im Plan.
- Workflows:
  - Schreib-Payload wird auf n8n-API-Schema bereinigt.
  - Vor der Ausführung wird die DEV-Freshness für alle Workflow-Aktionen geprüft (`payload.checksum`).
  - `UPDATE`-Aktionen werden übersprungen, wenn der normalisierte PROD-Inhalt bereits äquivalent ist.
  - `--force-update` deaktiviert dieses Skip-Verhalten und erzwingt Workflow-Updates.
  - ID-Patching in:
    - `node.credentials.*.id`
    - `parameters.workflowId`
    - `parameters.dataTableId` / `parameters.tableId`
    - `settings.errorWorkflow`
- Publishing:
  - Sub-Workflows können bei `apply` auto-published werden.
  - Root-Workflow wird nie auto-published.

## Logging

Detailliertes Step-Logging:

- Plan: `[PLAN][..]`
- Deploy: `[DEPLOY][VAL][..]` und `[DEPLOY][RUN][..]`
- API-Client: `[N8N_CLIENT]`

## Nützliche Scripts

```bash
npm run dev -- --help
npm run typecheck
npm run build
```

## Projektstruktur

```text
src/
  cli/            # plan/apply/publish/remove/orphans/dangling
  services/       # API, Planung, Deploy, Transformationen
  types/          # Zod-Schemas + TS-Typen
  utils/          # env, logger, hash, file-helpers
  errors/         # ApiError / DependencyError / ValidationError
```

## Schnelle Fehleranalyse

- `must have required property 'connections'`:
  - Plan enthält unvollständigen Workflow-Payload; Plan neu erzeugen.
- `must NOT have additional properties`:
  - Workflow-/Settings-Payload enthält nicht erlaubte Felder.
- `referenced workflow ... is not published`:
  - Referenzierter Sub-Workflow in PROD ist nicht veröffentlicht.
- `405 GET method not allowed` bei Credentials:
  - n8n unterstützt `GET /credentials/{id}` nicht; Liste + Auflösung verwenden.
