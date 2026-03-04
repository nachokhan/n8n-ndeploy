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

## 4.1 Generar plan

```bash
ndeploy plan flow <workflow_id_dev>
```

Resultado esperado:

1. Se genera un archivo `plan_<id>_<timestamp>.json`.
2. Ese plan contiene acciones para credenciales, data tables y workflows.

## 4.2 Aplicar plan

```bash
ndeploy apply <plan_file_path>
```

Resultado esperado:

1. Ejecuta las acciones del plan en PROD.
2. Auto-publica subworkflows cuando corresponde.
3. No auto-publica el root workflow.

## 4.3 Publicar manualmente

```bash
ndeploy publish <workflow_id_prod>
```

Uso típico:

1. Publicar el root workflow al final del proceso.
2. Publicar manualmente cualquier workflow específico en PROD.

## 4.4 Eliminar recursos en PROD

```bash
ndeploy remove --workflows <ids|all> --credentials <ids|all> --data-tables <ids|all>
```

Reglas:

1. Puedes combinar flags según lo que quieras borrar.
2. IDs se pasan en formato CSV (`id1,id2,id3`).
3. `--all` selecciona todo (workflows, credenciales y data tables).
4. `--datatables` es alias de `--data-tables`.

Confirmación de seguridad:

1. Si pasas `--yes`, se ejecuta sin preguntar.
2. Si no pasas `--yes`, se te pedirá escribir `yes` en consola.

Ejemplos:

```bash
ndeploy remove --workflows 12,18 --yes
ndeploy remove --credentials all --data-tables all
ndeploy remove --all --yes
```

## 4.5 Detectar huérfanos

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

## 5. Flujo recomendado de uso

1. Generar plan:

```bash
ndeploy plan flow YI2AqhHvG8gfsyM2
```

2. Revisar el plan JSON (acciones, warnings, dependencias).

3. Aplicar el plan:

```bash
ndeploy apply ./plan_YI2AqhHvG8gfsyM2_2026-02-27T23-51-43.514Z.json
```

4. Publicar root manualmente:

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
ndeploy apply --help
ndeploy publish --help
ndeploy remove --help
ndeploy orphans --help

# Flujo base
ndeploy plan flow <workflow_id_dev>
ndeploy apply <plan_file_path>
ndeploy publish <workflow_id_prod>
ndeploy remove --all --yes
ndeploy orphans --side target
```
