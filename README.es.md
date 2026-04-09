<p align="center">
  <img src="./img/ndploy-cover.png" alt="ndeploy cover" />
</p>

# ndeploy

CLI en TypeScript para planificar y aplicar despliegues de workflows de **n8n** entre **DEV -> PROD** de forma determinística e idempotente.

## Licencia

Este proyecto está licenciado bajo **Business Source License 1.1**. Se permite
el uso interno y la prestación de servicios profesionales, incluyendo
consultoría paga de n8n y entrega de workflows, pero no se permite crear ni
monetizar un producto, servicio hosteado, SaaS, white-label, OEM o bundle
comercial basado sustancialmente en este proyecto. Ver [`LICENSE`](./LICENSE).

## Te sirve esta app?
Si te sirvió la App, podes invitrme un flat white o un cortadito como agradecimiento.

[![Invitame un cortadito](https://cdn.cafecito.app/imgs/buttons/button_6.svg)](https://cafecito.app/nachokhan)

## Idiomas de la documentación

- Inglés (oficial): [`README.md`](./README.md)
- Español (secundario): `README.es.md`
- Alemán: [`README.de.md`](./README.de.md)

## Qué hace

- Descubre dependencias recursivas de un workflow:
  - subworkflows
  - credenciales
  - data tables
- Genera un plan JSON reproducible.
- Aplica el plan en PROD con mapeo `DEV_ID -> PROD_ID`.
- Parchea referencias internas de IDs sin reemplazos globales de texto.
- Publica automáticamente subworkflows cuando corresponde.
- Nunca publica automáticamente el root workflow (acción manual humana).

## Requisitos

- Node.js `>= 18`
- npm
- Acceso API a instancias n8n DEV y PROD

## Instalación

```bash
npm install
npm run build
```

Para usarlo sin `npm run`:

```bash
npm link
```

Luego puedes ejecutar `ndeploy ...` directamente.

## Configuración

La configuración recomendada ahora es `~/.ndeploy/profiles.json`, tomando
[`profiles.example.json`](./profiles.example.json) como plantilla. Los perfiles
son privados del operador y no deberían versionarse.

```json
{
  "schema_version": 1,
  "profiles": {
    "dev-to-prod": {
      "source": {
        "url": "https://dev.example.com",
        "api_key": "dev_api_key"
      },
      "target": {
        "url": "https://prod.example.com",
        "api_key": "prod_api_key"
      }
    }
  }
}
```

El `.env` sigue funcionando como compatibilidad legacy. Ver [`.env.example`](./.env.example).

## Vista rápida

![Guía profesional de Ndeploy](./img/ndeploy_guide.png)

## Comandos

### 1) Crear project

```bash
ndeploy create <workflow_id_dev> [project_root]
```

Crea la carpeta del project usando el nombre del workflow en DEV e inicializa `project.json`.
`project_root` es opcional para elegir dónde crear la carpeta (default: directorio actual).
Usa `--force` para re-inicializar metadata si el project ya existe.
Usa `--profile <name>` para persistir un perfil en `project.json`.
`ndeploy init` sigue disponible como alias de compatibilidad.

### 2) Generar plan

```bash
ndeploy plan [project]
```

Usa el workflow root configurado en `<project>/project.json`.
Si omites `project`, usa el directorio actual.
Genera:
- `<project>/plan.json`
- `<project>/reports/plan_summary.json`

Si `plan.json` ya existe, hace backup como `plan_backup_<timestamp>.json`.

`ndeploy create` guarda la configuración del workflow root en `project.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`
- `deploy.profile` (cuando se selecciona un perfil)

### 3) Aplicar plan

```bash
ndeploy apply [project]
```

Ejecuta el plan en PROD (credenciales, data tables, workflows).
Si omites `project`, usa el directorio actual.
Genera:
- `<project>/reports/deploy_result.json`
- `<project>/reports/deploy_summary.json`

Si el deploy falla a mitad de ejecución, igual se escriben resultados parciales.

Forzar updates de workflows aunque PROD ya sea equivalente:

```bash
ndeploy apply <project> --force-update
```

### 4) Publicar manualmente

```bash
ndeploy publish <workflow_id_prod> [--profile <name>]
```

Comando manual para publicar el root workflow (u otro workflow) en PROD.

### 5) Info del project

```bash
ndeploy info <project>
```

Muestra estado del project en JSON:
- metadata de `project.json`
- presencia y metadata clave de `plan.json` / `reports/plan_summary.json` / `credentials_manifest.json`
- presencia y contadores clave de `reports/deploy_result.json` / `reports/deploy_summary.json`

Opcional:

```bash
ndeploy info <project> --output <file_path>
```

### 6) Eliminar recursos

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Elimina recursos seleccionados en PROD.

- Los IDs se pasan como CSV: `id1,id2,id3`
- Alias: `--datatables` (igual que `--data-tables`)
- Atajo para todo: `--all`
- `--archived-workflows` limita el borrado de workflows solo a archivados
- Confirmación:
  - con `--yes`: ejecuta directamente
  - sin `--yes`: pide escribir `yes` en consola

Ejemplos:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --workflows all --archived-workflows --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

### 7) Buscar huérfanos

```bash
ndeploy orphans <project> --side <source|target>
```

Enumera entidades no referenciadas por ningún workflow no archivado y devuelve JSON pretty.

- `--side` es obligatorio:
  - `source` -> usa `N8N_DEV_*`
  - `target` -> usa `N8N_PROD_*`
- Filtros de entidad:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (alias: `--datatables`)
  - `--all`
- Si no pasas filtros de entidad, se asume `--all`.
- Archivo de salida por defecto (si no pasas `--output`): `<project>/reports/orphans_<side>.json`

Ejemplos:

```bash
ndeploy orphans <project> --side target
ndeploy orphans <project> --side source --credentials
ndeploy orphans <project> --side target --workflows --datatables
```

### 8) Buscar referencias colgantes

```bash
ndeploy dangling-refs <project> --side <source|target>
```

Enumera workflows que referencian entidades que ya no existen.

- `--side` es obligatorio:
  - `source` -> usa `N8N_DEV_*`
  - `target` -> usa `N8N_PROD_*`
- Filtros de referencia:
  - `--workflows`
  - `--credentials`
  - `--data-tables` (alias: `--datatables`)
  - `--all`
- Si no pasas filtros, se asume `--all`.
- Alias del comando: `ndeploy dangling`
- Archivo de salida por defecto (si no pasas `--output`): `<project>/reports/dangling_<side>.json`

Ejemplos:

```bash
ndeploy dangling-refs <project> --side target
ndeploy dangling <project> --side source --credentials
ndeploy dangling-refs <project> --side target --workflows --datatables
```

### 9) Obtener snapshots de credenciales

```bash
ndeploy credentials fetch <project>
```

Genera snapshots completos del grafo de credenciales y escribe:
- `<project>/credentials_source.json`
- `<project>/credentials_target.json`

Opcional:

```bash
ndeploy credentials fetch <project> --side source
ndeploy credentials fetch <project> --side target
ndeploy credentials fetch <project> --side both
```

### 10) Agregar faltantes al manifest

```bash
ndeploy credentials merge-missing <project>
```

Crea o actualiza `<project>/credentials_manifest.json` agregando solo credenciales faltantes.

- Nunca pisa valores ya editados.
- `--side source`: siembra faltantes desde `credentials_source.json`.
- `--side target`: siembra faltantes desde `credentials_target.json`.
- `--side both` (default): usa target primero y source como fallback.

### 11) Comparar source y target

```bash
ndeploy credentials compare <project>
```

Compara `credentials_source.json` y `credentials_target.json` e informa:
- `identical`
- `different`
- `missing_in_source`
- `missing_in_target`
- `type_mismatch`

### 12) Validar artefactos de credenciales

```bash
ndeploy credentials validate <project>
```

Valida campos requeridos en un artefacto por vez.
El side default es `manifest`.

Opcional:

```bash
ndeploy credentials validate <project> --side source
ndeploy credentials validate <project> --side target
ndeploy credentials validate <project> --side manifest
ndeploy credentials validate <project> --side all --strict
ndeploy credentials validate <project> --output <file_path>
```

## Flujo recomendado

1. `ndeploy create <workflow_id_dev> [project_root]`
2. `cd <project>`
3. `ndeploy plan`
4. Revisar `reports/plan_summary.json` (y `plan.json` si hace falta).
5. Obtener snapshots: `ndeploy credentials fetch`
6. Comparar source y target: `ndeploy credentials compare`
7. Agregar faltantes al manifest: `ndeploy credentials merge-missing`
8. Revisar/ajustar `credentials_manifest.json` con valores de PROD.
9. Validar manifest: `ndeploy credentials validate --side manifest --strict`
10. `ndeploy apply`
11. Revisar `reports/deploy_summary.json` (y `reports/deploy_result.json` si hace falta).
12. Publicación manual del root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Comportamiento importante

- Idempotencia:
  - Se mapean recursos por nombre en PROD cuando es posible.
- Credenciales:
  - `credentials_source.json` y `credentials_target.json` son snapshots.
  - `credentials_manifest.json` es el manifest editable para deploy.
  - `ndeploy credentials merge-missing` solo agrega faltantes y no pisa ediciones manuales.
  - `ndeploy credentials compare` es informativo y no modifica archivos.
- Data tables:
  - Se crean/mapean por nombre.
  - Diferencias de esquema agregan warnings en el plan.
- Workflows:
  - El payload se sanitiza para cumplir el schema público de n8n.
  - Antes de ejecutar, se valida freshness en DEV para todas las acciones workflow (`payload.checksum`).
  - Las acciones workflow del plan incluyen `observability` informativa:
    - `prod_comparison_at_plan`: `equal|different|unknown|not_applicable`
    - `comparison_reason`: motivo del resultado observado al generar el plan.
  - La observabilidad del plan es solo una foto en el momento de `plan`; `apply` sigue siendo la decisión final de `UPDATE` o `SKIP`.
  - La comparación de equivalencia ignora metadata no funcional (por ejemplo `node.position`, `node.id`, `credentials.*.name`, `staticData`) para evitar falsos positivos.
  - Las acciones `UPDATE` se omiten si el contenido normalizado en PROD ya es equivalente.
  - `--force-update` desactiva ese skip y fuerza la ejecución de updates de workflow.
  - Se parchean IDs en:
    - `node.credentials.*.id`
    - `parameters.workflowId`
    - `parameters.dataTableId` / `parameters.tableId`
    - `settings.errorWorkflow`
- Política de publicación:
  - Subworkflows se pueden auto-publicar en `apply`.
  - El root workflow nunca se auto-publica.

## Logging

El CLI incluye logging detallado por etapas:

- Plan: `[PLAN][..]`
- Deploy: `[DEPLOY][VAL][..]` y `[DEPLOY][RUN][..]`
- Cliente API: `[N8N_CLIENT]`

## Scripts útiles

```bash
npm run dev -- --help
npm run typecheck
npm run build
```

## Estructura

```text
src/
  cli/            # comandos create/plan/apply/publish/info/remove/orphans/dangling
  services/       # API, planificación, deploy, transformaciones
  types/          # schemas Zod + tipos TS
  utils/          # env, logger, hash, helpers de archivos
  errors/         # ApiError / DependencyError / ValidationError
```

## Troubleshooting rápido

- `must have required property 'connections'`:
  - El plan se generó con payload incompleto; regenerar plan.
- `must NOT have additional properties`:
  - El payload de workflow/settings contiene claves no soportadas.
- `referenced workflow ... is not published`:
  - Un subworkflow referenciado en PROD no está publicado.
- `405 GET method not allowed` en credenciales:
  - n8n no soporta `GET /credentials/{id}`; usar listado + resolución.
