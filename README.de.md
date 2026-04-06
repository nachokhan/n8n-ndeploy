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
# Optionaler Fallback für Credential-Fill:
# n8n-Webhook-Endpunkt, der Credential-Daten anhand angeforderter IDs zurückgibt
N8N_DEV_CREDENTIAL_EXPORT_URL=
# Bearer-Token für diesen Endpunkt
N8N_DEV_CREDENTIAL_EXPORT_TOKEN=
```

## Schnellüberblick

![Ndeploy Professional Guide](./img/ndeploy_guide.png)

## Befehle

### 1) Project erstellen

```bash
ndeploy create <workflow_id_dev> [project_root]
```

Erstellt den Project-Ordner auf Basis des Workflow-Namens in DEV und initialisiert `project.json`.
Mit optionalem `project_root` kann das Zielverzeichnis gewählt werden (Standard: aktuelles Verzeichnis).
Mit `--force` wird die Metadata neu initialisiert, wenn der Project bereits existiert.

### 2) Plan erzeugen

```bash
ndeploy plan <project>
```

Verwendet den in `<project>/project.json` konfigurierten Root-Workflow.
Erzeugt:
- `<project>/plan.json`
- `<project>/reports/plan_summary.json`

Falls `plan.json` bereits existiert, wird ein Backup als `plan_backup_<timestamp>.json` erstellt.

`ndeploy create` schreibt die Root-Workflow-Konfiguration in `project.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`

### 3) Plan anwenden

```bash
ndeploy apply <project>
```

Führt den Plan in PROD aus (Credentials, Data Tables, Workflows).
Schreibt:
- `<project>/reports/deploy_result.json`
- `<project>/reports/deploy_summary.json`

Wenn das Deployment mitten im Lauf fehlschlägt, werden trotzdem partielle Ergebnisdateien geschrieben.

Workflow-Updates erzwingen, auch wenn PROD bereits äquivalent ist:

```bash
ndeploy apply <project> --force-update
```

### 4) Manuell veröffentlichen

```bash
ndeploy publish <workflow_id_prod>
```

Manueller Publish-Befehl für Root-Workflow (oder beliebigen Workflow) in PROD.

### 5) Project-Info

```bash
ndeploy info <project>
```

Zeigt den Project-Status als JSON:
- Metadaten aus `project.json`
- Existenz und Kern-Metadaten von `plan.json` / `reports/plan_summary.json` / `production_credentials.json`
- Existenz und Kernzähler von `reports/deploy_result.json` / `reports/deploy_summary.json`

Optional:

```bash
ndeploy info <project> --output <file_path>
```

### 6) Ressourcen löschen

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

### 7) Orphans finden

```bash
ndeploy orphans <project> --side <source|target>
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
- Standard-Ausgabedatei (wenn `--output` fehlt): `<project>/reports/orphans_<side>.json`

Beispiele:

```bash
ndeploy orphans <project> --side target
ndeploy orphans <project> --side source --credentials
ndeploy orphans <project> --side target --workflows --datatables
```

### 8) Dangling References finden

```bash
ndeploy dangling-refs <project> --side <source|target>
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
- Standard-Ausgabedatei (wenn `--output` fehlt): `<project>/reports/dangling_<side>.json`

Beispiele:

```bash
ndeploy dangling-refs <project> --side target
ndeploy dangling <project> --side source --credentials
ndeploy dangling-refs <project> --side target --workflows --datatables
```

### 9) Credentials-Datei aktualisieren

```bash
ndeploy credentials update <project>
```

Erstellt oder aktualisiert `<project>/production_credentials.json` aus DEV-Abhängigkeiten des Root-Workflows (rekursive Sub-Workflows).

- Wenn die Datei nicht existiert:
  - erstellt alle aktiven Credentials mit vollständigem Template.
  - mit `--fill` werden neue Credentials so weit wie per DEV-API möglich vorausgefüllt.
- Wenn die Datei existiert:
  - neue Credentials werden hinzugefügt.
  - nicht mehr verwendete Credentials werden nach `archived_credentials` verschoben.
  - bestehende aktive Einträge bleiben unverändert (außer Namensabgleich per `dev_id`).
  - `--fill` gilt nur für neu hinzugefügte Credentials.
- Reihenfolge der Fill-Quellen bei `--fill`:
  - zuerst DEV Public API.
  - optionaler Webhook-Fallback (`N8N_DEV_CREDENTIAL_EXPORT_URL` + `N8N_DEV_CREDENTIAL_EXPORT_TOKEN`) für weiterhin ungelöste Credentials.

Optional:

```bash
ndeploy credentials update <project> --fill
```

### 10) Credential-Templates validieren

```bash
ndeploy credentials validate <project>
```

Validiert erforderliche Felder aktiver Credentials (`template.required_fields` gegen `template.data`) und gibt einen JSON-Report aus.
Dieser Befehl ruft keine DEV/PROD-APIs auf und liest nur `<project>/production_credentials.json`.

Optional:

```bash
ndeploy credentials validate <project> --output <file_path>
ndeploy credentials validate <project> --strict
```

## Empfohlener Ablauf

1. `ndeploy create <workflow_id_dev> [project_root]`
2. `ndeploy plan <project>`
3. `reports/plan_summary.json` prüfen (optional auch `plan.json`).
4. Credentials-Datei aktualisieren: `ndeploy credentials update <project> --fill`
5. `production_credentials.json` für PROD-Werte prüfen/anpassen.
6. Credentials validieren: `ndeploy credentials validate <project> --strict`
7. `ndeploy apply <project>`
8. `reports/deploy_summary.json` prüfen (optional auch `reports/deploy_result.json`).
9. Root-Workflow manuell veröffentlichen:
   - `ndeploy publish <root_workflow_id_prod>`

## Wichtige Hinweise

- Idempotenz:
  - Ressourcen werden, wenn möglich, per Name in PROD gemappt.
- Credentials:
  - `production_credentials.json` wird mit `ndeploy credentials update` verwaltet, nicht mit `plan`.
  - Dateistruktur:
    - `active_credentials`: aktuell verwendete Credentials im Root-Workflow-Graph.
    - `archived_credentials`: nicht mehr verwendete Credentials als Verlauf.
  - Jede aktive Credential enthält `template.required_fields`, `template.fields` und editierbares `template.data`.
- Data Tables:
  - Erstellung/Mapping über Namen.
  - Schema-Unterschiede erzeugen Warnings im Plan.
- Workflows:
  - Schreib-Payload wird auf n8n-API-Schema bereinigt.
  - Vor der Ausführung wird die DEV-Freshness für alle Workflow-Aktionen geprüft (`payload.checksum`).
  - Workflow-Aktionen enthalten informative `observability`-Felder im Plan:
    - `prod_comparison_at_plan`: `equal|different|unknown|not_applicable`
    - `comparison_reason`: Grund für das beobachtete Ergebnis zum Zeitpunkt der Plan-Erstellung.
  - Plan-Observability ist nur eine Zeitpunktaufnahme; `apply` bleibt die Quelle der Wahrheit für das finale `UPDATE` vs `SKIP`.
  - Der Äquivalenzvergleich ignoriert nicht-funktionale Metadaten (z. B. `node.position`, `node.id`, `credentials.*.name`, `staticData`), um False Positives zu reduzieren.
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
  cli/            # create/plan/apply/publish/info/remove/orphans/dangling
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
