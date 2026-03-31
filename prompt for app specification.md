# MASTER SPECIFICATION: NDeploy CLI TOOL (ARCHITECT VERSION 2)

**Role:** Senior Lead Software Engineer / DevOps Architect.
**Project:** A deterministic, idempotent CLI deployment tool for n8n between DEV and PROD environments.
**Strict Instruction:** NO simplified solutions. Use modular design, strict typing, and defensive programming.

---

## 1. PROJECT ARCHITECTURE
The tool must be written in **TypeScript** for Node.js.
Folder Structure:
- `src/cli/`: Command definitions (nplan, ndeploy) using `commander`.
- `src/services/`: 
    - `N8nClient.ts`: Axios wrapper for n8n API (v1). Handles Auth and base URLs.
    - `PlanService.ts`: Logic to traverse dependencies and generate the execution graph.
    - `DeployService.ts`: Logic to execute the plan, handle mappings, and push to PROD.
    - `TransformService.ts`: Deep object traversal to patch IDs in JSON.
- `src/types/`: Zod schemas and TS Interfaces for n8n objects.
- `src/utils/`: Logger (with colors), Hash generator (SHA-256), and File manager.

---

## 2. COMMAND SPECIFICATIONS

### Command: `nplan flow <workflow_id_dev>`
1. **Recursive Discovery:** - Fetch the workflow from DEV.
    - Traverse nodes searching for:
        - Sub-workflows: `type === 'n8n-nodes-base.executeWorkflow'`.
        - Data Tables: `type === 'n8n-nodes-base.dataTable'`.
        - Credentials: All IDs listed in any node's `credentials` property.
2. **State Analysis (DEV vs PROD):**
    - For every artifact found: Check PROD API by **Name**.
    - **Logic for Data Tables:** - If name exists in PROD: Action = `MAP_EXISTING`. Compare column schemas. If they differ, add a `warning` field to the plan.
        - If name NOT exists: Action = `CREATE`. Include schema (columns) and rows from DEV in the plan.
    - **Logic for Credentials:**
        - If name exists: Action = `MAP_EXISTING`.
        - If not: Action = `CREATE`. (Note: Create dummy credentials, user must fill secrets later).
3. **Execution Graph:** Order artifacts from "leaves" (credentials/tables) to "root" (main workflow).
4. **Output:** Write `plan_<id>_<timestamp>.json`. Include `raw_json` of every workflow to ensure the deploy uses the exact same version analyzed.

### Command: `ndeploy <plan_file_path>`
1. **Validation:** Use `Zod` to validate the plan schema. Check metadata checksums against current DEV status.
2. **Execution Phase:**
    - Iterate through the `actions` array in the plan.
    - **Mapping ID Dictionary:** Maintain a `Record<string, string>` mapping `DEV_ID -> PROD_ID`.
    - **Workflow Patching Logic:** - Before POST/PUT to PROD, the workflow JSON must be processed.
        - **DO NOT** use global string replace. Use a recursive function to target:
            - `node.credentials.[key].id`
            - `node.parameters.workflowId`
            - `node.parameters.tableId`
        - Replace values using the Mapping Dictionary.
    - **Atomic Deployment:** If any API call fails, stop execution immediately and log the full error context.

---

## 3. TECHNICAL CONSTRAINTS
- **Idempotency:** Using names as unique keys to prevent duplicates in PROD.
- **Security:** Do not log or transfer credential `data` (secrets).
- **Environment:** Use `.env` for:
    - `N8N_DEV_URL`, `N8N_DEV_API_KEY`
    - `N8N_PROD_URL`, `N8N_PROD_API_KEY`
- **Error Handling:** Custom error classes for `ApiError`, `DependencyError`, and `ValidationError`.

---

## 4. JSON PLAN SCHEMA (MANDATORY)
```json
{
  "metadata": { "id": "string", "timestamp": "string", "dev_hash": "string" },
  "actions": [
    {
      "order": "number",
      "type": "CREDENTIAL | DATATABLE | WORKFLOW",
      "action": "CREATE | UPDATE | MAP_EXISTING",
      "dev_id": "string",
      "prod_id": "string | null",
      "name": "string",
      "warning": "string | null",
      "payload": "any (The raw JSON or schema needed)",
      "dependencies": ["string (dev_ids)"]
    }
  ]
}
```

### 4.1 Ejemplo
```json
{
  "metadata": {
    "plan_id": "uuid-o-timestamp",
    "generated_at": "ISO-8601-Timestamp",
    "root_workflow_id": "ID-en-DEV",
    "source_instance": "URL-DEV",
    "target_instance": "URL-PROD",
    "checksum_root": "hash-del-workflow-principal-en-dev"
  },
  "actions": [
    {
      "order": 1,
      "type": "CREDENTIAL",
      "name": "Nombre de la Credencial",
      "n8n_type": "n8n-nodes-base.googleDriveApi",
      "dev_id": "dev-id-123",
      "action": "CREATE | MAP_EXISTING",
      "prod_id": "null | id-si-existe-en-prod",
      "data": { "name": "...", "type": "..." } 
    },
    {
      "order": 2,
      "type": "DATATABLE",
      "name": "Nombre de la Tabla",
      "dev_id": "table-dev-456",
      "action": "CREATE | MAP_EXISTING | WARNING",
      "prod_id": "null | id-si-existe",
      "schema_match": true,
      "columns": ["col1", "col2"],
      "initial_data_count": 150
    },
    {
      "order": 3,
      "type": "WORKFLOW",
      "name": "Nombre del Subflujo",
      "dev_id": "wf-sub-789",
      "action": "CREATE | UPDATE",
      "prod_id": "null | id-si-existe",
      "checksum": "hash-para-validar-cambios",
      "dependencies": {
        "credentials": ["dev-id-123"],
        "tables": ["table-dev-456"],
        "subflows": []
      },
      "raw_json": { "...content-from-dev..." }
    },
    {
      "order": 4,
      "type": "WORKFLOW",
      "name": "Flujo Principal",
      "dev_id": "wf-main-000",
      "action": "UPDATE",
      "prod_id": "id-en-prod",
      "checksum": "...",
      "dependencies": {
        "credentials": ["dev-id-123"],
        "tables": [],
        "subflows": ["wf-sub-789"]
      },
      "raw_json": { "..." }
    }
  ]
}
```

---

**FINAL NOTE:** Focus on clean code. The CLI should have professional output with spinners or progress bars for long processes.