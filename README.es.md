# ndeploy

CLI en TypeScript para planificar y aplicar despliegues de workflows de **n8n** entre **DEV -> PROD** de forma determinística e idempotente.

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
  cli/            # comandos plan/apply/publish
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
