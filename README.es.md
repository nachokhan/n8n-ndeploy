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

Crear `.env` (o copiar `.env.example`):

```env
N8N_DEV_URL=http://localhost:5678
N8N_DEV_API_KEY=dev_api_key
N8N_PROD_URL=http://localhost:5679
N8N_PROD_API_KEY=prod_api_key
# Fallback opcional para completar credenciales:
# Endpoint webhook de n8n que devuelve data por ids solicitados
N8N_DEV_CREDENTIAL_EXPORT_URL=
# Token Bearer para ese endpoint
N8N_DEV_CREDENTIAL_EXPORT_TOKEN=
```

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

### 2) Generar plan

```bash
ndeploy plan <project>
```

Usa el workflow root configurado en `<project>/project.json`.
Genera:
- `<project>/plan.json`
- `<project>/reports/plan_summary.json`

Si `plan.json` ya existe, hace backup como `plan_backup_<timestamp>.json`.

`ndeploy create` guarda la configuración del workflow root en `project.json`:
- `plan.root_workflow_id_dev`
- `plan.root_workflow_name`
- `plan.updated_at`

### 3) Aplicar plan

```bash
ndeploy apply <project>
```

Ejecuta el plan en PROD (credenciales, data tables, workflows).
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
ndeploy publish <workflow_id_prod>
```

Comando manual para publicar el root workflow (u otro workflow) en PROD.

### 5) Info del project

```bash
ndeploy info <project>
```

Muestra estado del project en JSON:
- metadata de `project.json`
- presencia y metadata clave de `plan.json` / `reports/plan_summary.json` / `production_credentials.json`
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

### 9) Actualizar archivo de credenciales

```bash
ndeploy credentials update <project>
```

Crea o actualiza `<project>/production_credentials.json` desde las credenciales usadas en DEV por el workflow root y sus subworkflows recursivos.

- Si no existe el archivo:
  - crea todas las credenciales activas con su template de campos requeridos.
  - con `--fill`, completa lo máximo posible con datos disponibles por API de DEV.
- Si el archivo existe:
  - agrega credenciales nuevas detectadas en DEV.
  - mueve a `archived_credentials` las que ya no se usan.
  - no modifica las credenciales activas ya existentes (salvo sincronizar `name` por `dev_id`).
  - `--fill` aplica solo a credenciales nuevas.
- Caso especial: cuando usas `--fill --side target`, también se refrescan las credenciales activas existentes con valores resueltos desde PROD.
- `--side` controla desde qué instancia intenta obtener valores `--fill`:
  - `source` (default): obtiene valores desde DEV.
  - `target`: intenta obtener valores desde PROD por coincidencia de nombre de credencial.
- Orden de fuentes cuando usas `--fill --side source`:
  - Primero API pública de DEV.
  - Fallback opcional a webhook (`N8N_DEV_CREDENTIAL_EXPORT_URL` + `N8N_DEV_CREDENTIAL_EXPORT_TOKEN`) para las credenciales que sigan sin data.
- Orden de fuentes cuando usas `--fill --side target`:
  - Primero API pública de PROD, usando coincidencia por nombre.
  - Fallback opcional a webhook (`N8N_PROD_CREDENTIAL_EXPORT_URL` + `N8N_PROD_CREDENTIAL_EXPORT_TOKEN`) para las credenciales que sigan sin data.

Opcional:

```bash
ndeploy credentials update <project> --fill
ndeploy credentials update <project> --fill --side source
ndeploy credentials update <project> --fill --side target
```

### 10) Validar templates de credenciales

```bash
ndeploy credentials validate <project>
```

Valida campos requeridos de credenciales activas en `production_credentials.json` (`template.required_fields` contra `template.data`) y devuelve un reporte JSON.
No llama APIs de DEV ni PROD. Solo lee `<project>/production_credentials.json`.

Opcional:

```bash
ndeploy credentials validate <project> --output <file_path>
ndeploy credentials validate <project> --strict
```

- `--output`: escribe el reporte a archivo.
- `--strict`: falla con error si faltan campos requeridos.

## Flujo recomendado

1. `ndeploy create <workflow_id_dev> [project_root]`
2. `ndeploy plan <project>`
3. Revisar `reports/plan_summary.json` (y `plan.json` si hace falta).
4. Actualizar credenciales: `ndeploy credentials update <project> --fill`
5. Revisar/ajustar `production_credentials.json` con valores de PROD.
6. Validar credenciales: `ndeploy credentials validate <project> --strict`
7. `ndeploy apply <project>`
8. Revisar `reports/deploy_summary.json` (y `reports/deploy_result.json` si hace falta).
9. Publicación manual del root workflow:
   - `ndeploy publish <root_workflow_id_prod>`

## Comportamiento importante

- Idempotencia:
  - Se mapean recursos por nombre en PROD cuando es posible.
- Credenciales:
  - `production_credentials.json` se gestiona con `ndeploy credentials update`, no con `plan`.
  - Estructura del archivo:
    - `active_credentials`: credenciales usadas actualmente por el grafo del root workflow.
    - `archived_credentials`: credenciales que ya no se usan, conservadas como historial.
  - Cada credencial activa incluye `template.required_fields`, `template.fields` y `template.data` editable.
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
