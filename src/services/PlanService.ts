import { randomUUID } from "crypto";
import { ApiError, DependencyError, ValidationError } from "../errors/index.js";
import { N8nClient } from "./N8nClient.js";
import { sha256 } from "../utils/hash.js";
import { DeploymentPlan, PlanActionItem } from "../types/plan.js";
import { DependencySnapshot, N8nWorkflow } from "../types/n8n.js";
import { logger } from "../utils/logger.js";

interface WorkflowDetail {
  workflow: N8nWorkflow;
  dependencies: DependencySnapshot;
}

export class PlanService {
  constructor(
    private readonly devClient: N8nClient,
    private readonly prodClient: N8nClient,
    private readonly sourceUrl: string,
    private readonly targetUrl: string,
  ) {}

  async buildPlan(rootWorkflowId: string): Promise<DeploymentPlan> {
    try {
      logger.info(`[PLAN][00] Start plan generation for root workflow ${rootWorkflowId}`);
      const visitedWorkflowIds = new Set<string>();
      const workflowMap = new Map<string, WorkflowDetail>();
      const credentialIds = new Set<string>();
      const dataTableIds = new Set<string>();

      await this.runStep("01", "Recursive dependency discovery", async () => {
        await this.discoverWorkflowRecursive(
          rootWorkflowId,
          visitedWorkflowIds,
          workflowMap,
          credentialIds,
          dataTableIds,
        );
        logger.debug(
          `[PLAN][01] Discovery summary: workflows=${workflowMap.size}, credentials=${credentialIds.size}, dataTables=${dataTableIds.size}`,
        );
      });

      const actions: PlanActionItem[] = [];

      await this.runStep("02", "Analyze credentials (DEV vs PROD)", async () => {
        for (const credentialId of credentialIds) {
          logger.debug(`[PLAN][02] Resolving credential dev_id=${credentialId}`);
          const credential = await this.devClient.getCredentialById(credentialId);
          const existing = await this.prodClient.findCredentialByName(credential.name);
          const action = existing ? "MAP_EXISTING" : "CREATE";
          logger.debug(
            `[PLAN][02] Credential name=\"${credential.name}\" -> action=${action}${existing ? ` prod_id=${existing.id}` : ""}`,
          );
          actions.push({
            order: 0,
            type: "CREDENTIAL",
            action,
            dev_id: credential.id,
            prod_id: existing?.id ?? null,
            name: credential.name,
            warning: null,
            payload: {
              name: credential.name,
              type: credential.type,
            },
            dependencies: [],
          });
        }
      });

      await this.runStep("03", "Analyze data tables (DEV vs PROD)", async () => {
        for (const dataTableId of dataTableIds) {
          logger.debug(`[PLAN][03] Resolving data table dev_id=${dataTableId}`);
          const table = await this.devClient.getDataTableById(dataTableId);
          const rows = await this.devClient.getDataTableRows(dataTableId);
          const existing = await this.prodClient.findDataTableByName(table.name);
          const action = existing ? "MAP_EXISTING" : "CREATE";

          let warning: string | null = null;
          if (existing) {
            const sameSchema = sha256(table.columns) === sha256(existing.columns);
            if (!sameSchema) {
              warning = "Schema differs from PROD table with same name.";
              logger.warn(`[PLAN][03] Data table warning for \"${table.name}\": ${warning}`);
            }
          }

          logger.debug(
            `[PLAN][03] Data table name=\"${table.name}\" -> action=${action}${existing ? ` prod_id=${existing.id}` : ""} rows=${rows.length}`,
          );

          actions.push({
            order: 0,
            type: "DATATABLE",
            action,
            dev_id: table.id,
            prod_id: existing?.id ?? null,
            name: table.name,
            warning,
            payload: {
              name: table.name,
              columns: table.columns,
              rows,
            },
            dependencies: [],
          });
        }
      });

      await this.runStep("04", "Analyze workflows and dependencies", async () => {
        const workflowIds = [...workflowMap.keys()];
        for (const workflowId of workflowIds) {
          logger.debug(`[PLAN][04] Resolving workflow dev_id=${workflowId}`);
          const detail = workflowMap.get(workflowId);
          if (!detail) {
            throw new DependencyError("Workflow detail not found after discovery", { workflowId });
          }

          const existing = await this.prodClient.findWorkflowByName(detail.workflow.name);
          const action = existing ? "UPDATE" : "CREATE";
          const dependencyList = [
            ...detail.dependencies.credentialIds,
            ...detail.dependencies.dataTableIds,
            ...detail.dependencies.subWorkflowIds,
          ];

          logger.debug(
            `[PLAN][04] Workflow name=\"${detail.workflow.name}\" -> action=${action}${existing ? ` prod_id=${existing.id}` : ""} dependencies=${dependencyList.length}`,
          );

          actions.push({
            order: 0,
            type: "WORKFLOW",
            action,
            dev_id: detail.workflow.id,
            prod_id: existing?.id ?? null,
            name: detail.workflow.name,
            warning: null,
            payload: {
              checksum: sha256(detail.workflow),
              raw_json: detail.workflow,
            },
            dependencies: dependencyList,
          });
        }
      });

      await this.runStep("05", "Sort execution graph and assign order", async () => {
        // Order leaves -> root via dependency depth and root at the end.
        actions.sort((a, b) => {
          const typeWeight = (type: PlanActionItem["type"]): number => {
            if (type === "CREDENTIAL") return 1;
            if (type === "DATATABLE") return 2;
            return 3;
          };
          const typeDiff = typeWeight(a.type) - typeWeight(b.type);
          if (typeDiff !== 0) return typeDiff;

          if (a.type === "WORKFLOW" && b.type === "WORKFLOW") {
            if (a.dev_id === rootWorkflowId) return 1;
            if (b.dev_id === rootWorkflowId) return -1;
            const depDiff = a.dependencies.length - b.dependencies.length;
            if (depDiff !== 0) return depDiff;
          }

          return a.name.localeCompare(b.name);
        });

        actions.forEach((action, index) => {
          action.order = index + 1;
        });

        logger.debug(`[PLAN][05] Ordered actions count=${actions.length}`);
      });

      const root = await this.runStep("06", "Compute plan metadata and root checksum", async () => {
        const rootWorkflow = workflowMap.get(rootWorkflowId);
        if (!rootWorkflow) {
          throw new DependencyError("Root workflow not found after recursive discovery", {
            rootWorkflowId,
          });
        }
        return rootWorkflow;
      });

      const plan: DeploymentPlan = {
        metadata: {
          plan_id: randomUUID(),
          generated_at: new Date().toISOString(),
          root_workflow_id: rootWorkflowId,
          source_instance: this.sourceUrl,
          target_instance: this.targetUrl,
          checksum_root: sha256(root.workflow),
        },
        actions,
      };

      logger.success(
        `[PLAN][DONE] Plan generated: actions=${plan.actions.length}, root_workflow_id=${rootWorkflowId}`,
      );
      return plan;
    } catch (error) {
      this.logStepError("XX", "Plan generation aborted", error);
      throw error;
    }
  }

  private async discoverWorkflowRecursive(
    workflowId: string,
    visited: Set<string>,
    workflowMap: Map<string, WorkflowDetail>,
    credentialIds: Set<string>,
    dataTableIds: Set<string>,
  ): Promise<void> {
    if (visited.has(workflowId)) {
      logger.debug(`[PLAN][01] Workflow ${workflowId} already visited, skipping`);
      return;
    }

    logger.info(`[PLAN][01] Discovering workflow dev_id=${workflowId}`);
    visited.add(workflowId);
    const workflow = await this.devClient.getWorkflowById(workflowId);
    logger.debug(`[PLAN][01] Loaded workflow \"${workflow.name}\" with nodes=${workflow.nodes.length}`);

    const dependencies: DependencySnapshot = {
      credentialIds: new Set<string>(),
      dataTableIds: new Set<string>(),
      subWorkflowIds: new Set<string>(),
    };

    for (const node of workflow.nodes) {
      if (node.credentials) {
        for (const credential of Object.values(node.credentials)) {
          const credentialId = this.extractReferenceId(credential?.id);
          if (!credentialId) {
            logger.warn(
              `[PLAN][01] Node \"${node.name}\" has credential without resolvable id`,
            );
            continue;
          }
          dependencies.credentialIds.add(credentialId);
          credentialIds.add(credentialId);
        }
      }

      const workflowParam = node.parameters?.workflowId;
      if (node.type === "n8n-nodes-base.executeWorkflow") {
        const workflowParamId = this.extractReferenceId(workflowParam);
        if (workflowParamId) {
          dependencies.subWorkflowIds.add(workflowParamId);
          logger.debug(
            `[PLAN][01] Node \"${node.name}\" discovered sub-workflow dependency=${workflowParamId}`,
          );
        } else {
          logger.warn(
            `[PLAN][01] Node \"${node.name}\" executeWorkflow has no resolvable workflowId`,
          );
        }
      }

      const tableParam = node.parameters?.tableId;
      if (node.type === "n8n-nodes-base.dataTable") {
        const tableParamId = this.extractReferenceId(tableParam);
        if (tableParamId) {
          dependencies.dataTableIds.add(tableParamId);
          dataTableIds.add(tableParamId);
          logger.debug(
            `[PLAN][01] Node \"${node.name}\" discovered data-table dependency=${tableParamId}`,
          );
        } else {
          logger.warn(`[PLAN][01] Node \"${node.name}\" dataTable has no resolvable tableId`);
        }
      }
    }

    workflowMap.set(workflow.id, {
      workflow,
      dependencies,
    });
    logger.debug(
      `[PLAN][01] Workflow \"${workflow.name}\" dependencies: credentials=${dependencies.credentialIds.size}, dataTables=${dependencies.dataTableIds.size}, subWorkflows=${dependencies.subWorkflowIds.size}`,
    );

    for (const subWorkflowId of dependencies.subWorkflowIds) {
      await this.discoverWorkflowRecursive(
        subWorkflowId,
        visited,
        workflowMap,
        credentialIds,
        dataTableIds,
      );
    }
  }

  private async runStep(
    step: string,
    description: string,
    run: () => Promise<void>,
  ): Promise<void>;
  private async runStep<T>(
    step: string,
    description: string,
    run: () => Promise<T>,
  ): Promise<T>;
  private async runStep<T>(
    step: string,
    description: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info(`[PLAN][${step}] ${description}`);
    try {
      const result = await run();
      const elapsedMs = Date.now() - startedAt;
      logger.success(`[PLAN][${step}] OK (${elapsedMs} ms)`);
      return result;
    } catch (error) {
      this.logStepError(step, description, error);
      throw error;
    }
  }

  private logStepError(step: string, description: string, error: unknown): void {
    logger.error(`[PLAN][${step}] FAIL: ${description}`);
    if (error instanceof ApiError) {
      logger.error(`[PLAN][${step}] ApiError: ${error.message}`);
      if (error.status) {
        logger.error(`[PLAN][${step}] status=${error.status}`);
      }
      if (error.context) {
        logger.error(`[PLAN][${step}] context=${JSON.stringify(error.context, null, 2)}`);
      }
      return;
    }
    if (error instanceof DependencyError) {
      logger.error(`[PLAN][${step}] DependencyError: ${error.message}`);
      if (error.context) {
        logger.error(`[PLAN][${step}] context=${JSON.stringify(error.context, null, 2)}`);
      }
      return;
    }
    if (error instanceof ValidationError) {
      logger.error(`[PLAN][${step}] ValidationError: ${error.message}`);
      if (error.details) {
        logger.error(`[PLAN][${step}] details=${JSON.stringify(error.details, null, 2)}`);
      }
      return;
    }
    const fallback = error as Error;
    logger.error(`[PLAN][${step}] Error: ${fallback.message}`);
  }

  private extractReferenceId(reference: unknown): string | null {
    if (typeof reference === "string" || typeof reference === "number") {
      return String(reference);
    }

    if (!reference || typeof reference !== "object") {
      return null;
    }

    const record = reference as Record<string, unknown>;
    const directValue = record.value;
    if (typeof directValue === "string" || typeof directValue === "number") {
      return String(directValue);
    }

    const directId = record.id;
    if (typeof directId === "string" || typeof directId === "number") {
      return String(directId);
    }

    return null;
  }
}
