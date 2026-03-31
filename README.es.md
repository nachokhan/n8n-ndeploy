<p align="center">
  <img src="./img/ndploy-cover.png" alt="ndeploy cover" />
</p>

# ndeploy

CLI en TypeScript para planificar y aplicar despliegues de workflows de **n8n** entre **DEV -> PROD** de forma determinística e idempotente.

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

Crear `.env` (o copiar `.env.example`):

```env
N8N_DEV_URL=http://localhost:5678
N8N_DEV_API_KEY=dev_api_key
N8N_PROD_URL=http://localhost:5679
N8N_PROD_API_KEY=prod_api_key
```

## Vista rápida

![Guía profesional de Ndeploy](./img/ndeploy_guide.png)

## Comandos

### 1) Crear workspace

```bash
ndeploy create <workflow_id_dev> [workspace_root]
```

Crea la carpeta del workspace usando el nombre del workflow en DEV e inicializa `workspace.json`.
`workspace_root` es opcional para elegir dónde crear la carpeta (default: directorio actual).
Usa `--force` para re-inicializar metadata si el workspace ya existe.

### 2) Generar plan

```bash
ndeploy plan <workspace>
```

Usa el workflow root configurado en `<workspace>/workspace.json`.
Genera:
- `<workspace>/plan.json`
- `<workspace>/plan_summary.json`

Si `plan.json` ya existe, hace backup como `plan_backup_<timestamp>.json`.

`ndeploy create` guarda la configuración del workflow root en `workspace.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`

### 3) Aplicar plan

```bash
ndeploy apply <workspace>
```

Ejecuta el plan en PROD (credenciales, data tables, workflows).
Genera:
- `<workspace>/deploy_result.json`
- `<workspace>/deploy_summary.json`

Si el deploy falla a mitad de ejecución, igual se escriben resultados parciales.

Forzar updates de workflows aunque PROD ya sea equivalente:

```bash
ndeploy apply <workspace> --force-update
```

### 4) Publicar manualmente

```bash
ndeploy publish <workflow_id_prod>
```

Comando manual para publicar el root workflow (u otro workflow) en PROD.

### 5) Info del workspace

```bash
ndeploy info <workspace>
```

Muestra estado del workspace en JSON:
- metadata de `workspace.json`
- presencia y metadata clave de `plan.json` / `plan_summary.json`
- presencia y contadores clave de `deploy_result.json` / `deploy_summary.json`

Opcional:

```bash
ndeploy info <workspace> --output <file_path>
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
ndeploy orphans <workspace> --side <source|target>
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
- Archivo de salida por defecto (si no pasas `--output`): `<workspace>/orphans_<side>.json`

Ejemplos:

```bash
ndeploy orphans <workspace> --side target
ndeploy orphans <workspace> --side source --credentials
ndeploy orphans <workspace> --side target --workflows --datatables
```

### 8) Buscar referencias colgantes

```bash
ndeploy dangling-refs <workspace> --side <source|target>
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
- Archivo de salida por defecto (si no pasas `--output`): `<workspace>/dangling_<side>.json`

Ejemplos:

```bash
ndeploy dangling-refs <workspace> --side target
ndeploy dangling <workspace> --side source --credentials
ndeploy dangling-refs <workspace> --side target --workflows --datatables
```

## Flujo recomendado

1. `ndeploy create <workflow_id_dev> [workspace_root]`
2. `ndeploy plan <workspace>`
3. Revisar `plan_summary.json` (y `plan.json` si hace falta).
4. `ndeploy apply <workspace>`
5. Revisar `deploy_summary.json` (y `deploy_result.json` si hace falta).
6. Publicación manual del root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Comportamiento importante

- Idempotencia:
  - Se mapean recursos por nombre en PROD cuando es posible.
- Credenciales:
  - Las faltantes se crean como placeholder (sin copiar secretos).
  - El `data` placeholder se genera dinámicamente desde el schema.
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
