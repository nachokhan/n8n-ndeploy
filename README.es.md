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

### 1) Generar plan

```bash
ndeploy plan flow <workflow_id_dev>
```

Genera `plan_<id>_<timestamp>.json` con metadata y acciones.

### 2) Aplicar plan

```bash
ndeploy apply <plan_file_path>
```

Ejecuta el plan en PROD (credenciales, data tables, workflows).

Forzar updates de workflows aunque PROD ya sea equivalente:

```bash
ndeploy apply <plan_file_path> --force-update
```

### 3) Publicar manualmente

```bash
ndeploy publish <workflow_id_prod>
```

Comando manual para publicar el root workflow (u otro workflow) en PROD.

### 4) Eliminar recursos

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Elimina recursos seleccionados en PROD.

- Los IDs se pasan como CSV: `id1,id2,id3`
- Alias: `--datatables` (igual que `--data-tables`)
- Atajo para todo: `--all`
- Confirmación:
  - con `--yes`: ejecuta directamente
  - sin `--yes`: pide escribir `yes` en consola

Ejemplos:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

### 5) Buscar huérfanos

```bash
ndeploy orphans --side <source|target>
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

Ejemplos:

```bash
ndeploy orphans --side target
ndeploy orphans --side source --credentials
ndeploy orphans --side target --workflows --datatables
```

### 6) Buscar referencias colgantes

```bash
ndeploy dangling-refs --side <source|target>
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

Ejemplos:

```bash
ndeploy dangling-refs --side target
ndeploy dangling --side source --credentials
ndeploy dangling-refs --side target --workflows --datatables
```

## Flujo recomendado

1. `ndeploy plan flow <workflow_id_dev>`
2. Revisar el plan JSON generado.
3. `ndeploy apply <plan_file_path>`
4. Publicación manual del root workflow:
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
  cli/            # comandos plan/apply/publish/remove/orphans/dangling
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
