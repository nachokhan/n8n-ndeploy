# Manual de Usuario - ndeploy

Este documento explica **cómo usar** `ndeploy` de punta a punta.
No está orientado a la implementación interna, sino a la operación diaria.

## 1. Objetivo

`ndeploy` sirve para:

1. Generar un plan de despliegue de un workflow de n8n desde DEV a PROD.
2. Aplicar ese plan en PROD.
3. Publicar manualmente un workflow en PROD (por ejemplo, el root).
4. Eliminar recursos en PROD (workflows, credenciales, data tables).
5. Detectar entidades huérfanas (no referenciadas).
6. Detectar referencias colgantes (entidades faltantes referenciadas por workflows).

## 2. Requisitos previos

Antes de ejecutar comandos, verifica:

1. Tener Node.js 18+.
2. Tener acceso API a DEV y PROD de n8n.
3. Tener `.env` configurado en la raíz del proyecto.

Ejemplo de `.env`:

```env
N8N_DEV_URL=https://tu-dev
N8N_DEV_API_KEY=xxxxx
N8N_PROD_URL=https://tu-prod
N8N_PROD_API_KEY=yyyyy
```

## 3. Instalación para uso directo

Desde la carpeta del proyecto:

```bash
npm install
npm run build
npm link
```

Con eso puedes usar `ndeploy` sin `npm run`.

## 4. Comandos disponibles

## 4.1 Crear workspace

```bash
ndeploy create <workflow_id_dev> [workspace_root]
```

Resultado esperado:

1. Se crea la carpeta del workspace usando el nombre del workflow en DEV.
2. Se inicializa `<workspace>/workspace.json` con metadata base.
3. Queda configurado el root workflow en `workspace.json` (`plan.root_workflow_id_dev` y `plan.root_workflow_name`).
4. Si pasas `--force`, se re-inicializa `workspace.json` existente.
5. `workspace_root` es opcional para indicar dónde crear la carpeta (por defecto, directorio actual).

## 4.2 Generar plan

```bash
ndeploy plan <workspace>
```

Resultado esperado:

1. Se genera un archivo `<workspace>/plan.json`.
2. Se genera `<workspace>/plan_summary.json` para vista rápida.
3. Si ya existe `plan.json`, se renombra a `plan_backup_<timestamp>.json`.
4. Ese plan contiene acciones para credenciales, data tables y workflows.

Importante:

1. `ndeploy plan <workspace>` usa el workflow root guardado en `<workspace>/workspace.json`.
2. Si no hay workflow root configurado, el comando falla y te pedirá crear/configurar el workspace.

## 4.3 Aplicar plan

```bash
ndeploy apply <workspace>
```

Resultado esperado:

1. Ejecuta las acciones del plan en PROD.
2. Auto-publica subworkflows cuando corresponde.
3. No auto-publica el root workflow.
4. Genera `<workspace>/deploy_result.json` (resultado completo).
5. Genera `<workspace>/deploy_summary.json` (vista rápida).
6. Si falla en mitad del deploy, igualmente escribe resultados parciales.

## 4.4 Publicar manualmente

```bash
ndeploy publish <workflow_id_prod>
```

Uso típico:

1. Publicar el root workflow al final del proceso.
2. Publicar manualmente cualquier workflow específico en PROD.

## 4.5 Info del workspace

```bash
ndeploy info <workspace>
```

Resultado esperado:

1. Imprime JSON con estado del workspace.
2. Muestra metadata de `workspace.json`.
3. Muestra si existen `plan.json`, `plan_summary.json`, `deploy_result.json`, `deploy_summary.json`.
4. Si los archivos existen, muestra metadata y contadores útiles (por ejemplo `plan_id`, `run_id`, `executed/skipped/failed`).
5. Con `--output`, también escribe ese JSON en el path indicado.

## 4.6 Eliminar recursos en PROD

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Reglas:

1. Puedes combinar flags según lo que quieras borrar.
2. IDs se pasan en formato CSV (`id1,id2,id3`).
3. `--all` selecciona todo (workflows, credenciales y data tables).
4. `--datatables` es alias de `--data-tables`.
5. `--archived-workflows` limita el borrado de workflows solo a archivados.

Confirmación de seguridad:

1. Si pasas `--yes`, se ejecuta sin preguntar.
2. Si no pasas `--yes`, se te pedirá escribir `yes` en consola.

Ejemplos:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --workflows all --archived-workflows --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

## 4.7 Detectar huérfanos

```bash
ndeploy orphans --side <source|target>
```

Reglas:

1. `--side` es obligatorio.
2. `source` usa variables `N8N_DEV_*`; `target` usa `N8N_PROD_*`.
3. Filtros disponibles: `--workflows`, `--credentials`, `--data-tables` (alias `--datatables`) y `--all`.
4. Si no pasas filtros de entidad, se asume `--all`.
5. Los workflows archivados se consideran borrados y no cuentan para referencias.

Salida:

1. Imprime JSON pretty con listas de huérfanos por entidad.
2. En credenciales incluye `type`.

Ejemplos:

```bash
ndeploy orphans --side target
ndeploy orphans --side source --credentials
ndeploy orphans --side target --workflows --datatables
```

## 4.8 Detectar referencias colgantes

```bash
ndeploy dangling-refs --side <source|target>
```

Reglas:

1. `--side` es obligatorio.
2. `source` usa variables `N8N_DEV_*`; `target` usa `N8N_PROD_*`.
3. Filtros disponibles: `--workflows`, `--credentials`, `--data-tables` (alias `--datatables`) y `--all`.
4. Si no pasas filtros, se asume `--all`.
5. Solo se analizan workflows no archivados.

Salida:

1. Imprime JSON pretty con `summary` y detalle por workflow afectado.
2. Cada referencia colgante incluye `node_name`, `node_type`, `field` y `missing_id`.
3. Alias del comando: `ndeploy dangling`.

Ejemplos:

```bash
ndeploy dangling-refs --side target
ndeploy dangling --side source --credentials
ndeploy dangling-refs --side target --workflows --datatables
```

## 5. Flujo recomendado de uso

1. Crear workspace:

```bash
ndeploy create YI2AqhHvG8gfsyM2 tmp
```

2. Tomar el folder generado (basado en el nombre del workflow, normalizado).

3. Generar plan:

```bash
ndeploy plan <workspace_generado>
```

4. Revisar `plan_summary.json` (y `plan.json` si necesitas detalle total).

5. Aplicar el plan:

```bash
ndeploy apply <workspace_generado>
```

6. Revisar `deploy_summary.json` (y `deploy_result.json` si necesitas auditoría completa).

7. Publicar root manualmente:

```bash
ndeploy publish <root_workflow_id_en_prod>
```

## 6. Política de publicación

`ndeploy` maneja la publicación así:

1. Subworkflows: puede publicarlos automáticamente durante `apply`.
2. Root workflow: **siempre manual** por comando `publish`.

Esto reduce riesgos de activar el flujo principal sin revisión humana.

## 7. Manual de logs (sección dedicada)

Esta sección explica qué significan los logs más importantes y qué debes hacer.

## 7.1 Prefijos principales

- `[NPLAN]`: logs generales del comando `plan`.
- `[PLAN][NN]`: pasos internos de generación de plan.
- `[NDEPLOY]`: logs generales del comando `apply`.
- `[DEPLOY][VAL][NN]`: validaciones previas al despliegue.
- `[DEPLOY][RUN][NNN]`: ejecución de acciones del plan.
- `[NPUBLISH]`: logs del comando manual `publish`.
- `[N8N_CLIENT]`: trazas de llamadas API y sanitización de payload.

## 7.2 Cómo leer una ejecución de `plan`

Ejemplo:

```text
[PLAN][01] Recursive dependency discovery
[PLAN][01] OK (935 ms)
[PLAN][02] Analyze credentials (DEV vs PROD)
[PLAN][02] OK (176 ms)
[PLAN][DONE] Plan generated: actions=24, root_workflow_id=...
```

Interpretación:

1. `01`: descubrió dependencias.
2. `02`: evaluó credenciales.
3. `DONE`: plan listo.

Si aparece `FAIL`, el paso indicado es donde debes enfocarte.

## 7.3 Cómo leer una ejecución de `apply`

Ejemplo:

```text
[DEPLOY][VAL][01] Validate deployment plan schema
[DEPLOY][VAL][01] OK
[DEPLOY][RUN][009] Execute DATATABLE/CREATE name="PLUS - Counters"
[DEPLOY][RUN][009] OK (... ms) mapped iu7B... -> B5L...
```

Interpretación:

1. Fase `VAL`: validaciones previas.
2. Fase `RUN`: ejecución real en PROD.
3. `mapped`: ID DEV mapeado al ID PROD.

## 7.4 Logs de advertencia frecuentes

Ejemplo:

```text
[PLAN][03] Data table warning for "PLUS - Drive IDs": Schema differs from PROD table with same name.
```

Significado:

1. Existe tabla con mismo nombre en PROD.
2. El esquema no coincide exactamente.
3. El plan sigue, pero debes revisar compatibilidad funcional.

## 7.5 Logs de error: estructura

Cuando falla, normalmente verás:

```text
... FAIL: Action failed (...)
ApiError: Request failed with status code 400
context={ ... }
```

Guía rápida:

1. Mira primero `Action failed (...)` para saber qué tipo de recurso falló.
2. Mira `status` HTTP (`400`, `404`, etc.).
3. Mira `context.responseData.message` para la causa concreta.

## 7.6 Errores típicos y qué significan

## A) `request/body must have required property 'connections'`

Significado:

- Payload de workflow incompleto en el plan o en update.

Acción recomendada:

1. Regenerar plan.
2. Reintentar `apply`.

## B) `request/body must NOT have additional properties`

Significado:

- Se enviaron campos de workflow/settings que la API no permite.

Acción recomendada:

1. Usar la versión actual del CLI (ya sanitiza payload).
2. Reintentar `apply`.

## C) `... references workflow ... which is not published`

Significado:

- Un workflow padre referencia un subworkflow no publicado en PROD.

Acción recomendada:

1. Publicar subworkflow(s) antes del padre.
2. Luego publicar root manualmente.

## D) `GET method not allowed` en credenciales

Significado:

- Tu instancia no permite `GET /credentials/{id}`.

Acción recomendada:

- Usar versión actual del CLI (resuelve credenciales por listado).

## 7.7 Logs de publicación automática/manual

Ejemplos:

```text
[DEPLOY][RUN][WORKFLOW] Auto-publishing sub-workflow name="..." prod_id=...
[DEPLOY][RUN][WORKFLOW] Skip auto-publish for ROOT workflow name="..." prod_id=...
[NPUBLISH] Published workflow ...
```

Interpretación:

1. Subworkflows pueden activarse automáticamente.
2. Root se omite intencionalmente.
3. `publish` confirma activación manual.

## 8. Buenas prácticas de operación

1. Mantener un plan por ejecución (no reusar planes viejos si DEV cambió).
2. Guardar el plan aplicado en historial de cambios.
3. Publicar el root recién después de validar subworkflows.
4. Revisar warnings de data tables antes de ir a producción.

## 9. Comandos rápidos de referencia

```bash
# Ayuda general
ndeploy --help

# Ayuda de subcomandos
ndeploy plan --help
ndeploy create --help
ndeploy apply --help
ndeploy publish --help
ndeploy info --help
ndeploy remove --help
ndeploy orphans --help
ndeploy dangling-refs --help

# Flujo base
ndeploy create <workflow_id_dev> [workspace_root]
ndeploy plan <workspace>
ndeploy apply <workspace>
ndeploy info <workspace>
ndeploy publish <workflow_id_prod>
ndeploy remove --all --yes
ndeploy orphans --side target
ndeploy dangling-refs --side target
```
