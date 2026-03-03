import { DeploymentPlan, DeploymentPlanSchema, PlanActionItem } from "../types/plan.js";
import { N8nClient } from "./N8nClient.js";
import { TransformService } from "./TransformService.js";
import { ApiError, ValidationError } from "../errors/index.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

interface DeployServiceOptions {
  forceUpdate?: boolean;
}

export class DeployService {
  constructor(
    private readonly devClient: N8nClient,
    private readonly prodClient: N8nClient,
    private readonly transformService: TransformService,
    private readonly options: DeployServiceOptions = {},
  ) {}

  async validatePlan(plan: unknown): Promise<DeploymentPlan> {
    logger.info("[DEPLOY][VAL][00] Start plan validation");
    try {
      const parsed = await this.runStep("VAL", "01", "Validate deployment plan schema", async () => {
        const result = DeploymentPlanSchema.safeParse(plan);
        if (!result.success) {
          throw new ValidationError("Invalid deployment plan schema", result.error.flatten());
        }
        return result;
      });

      await this.runStep("VAL", "02", "Validate root workflow action exists", async () => {
        const root = parsed.data.actions.find(
          (a) => a.type === "WORKFLOW" && a.dev_id === parsed.data.metadata.root_workflow_id,
        );
        if (!root) {
          throw new ValidationError("Root workflow action not found in plan", parsed.data.metadata);
        }
      });

      await this.runStep("VAL", "03", "Validate DEV workflow checksums have not changed", async () => {
        const workflowActions = parsed.data.actions.filter((action) => action.type === "WORKFLOW");
        logger.debug(
          `[DEPLOY][VAL][03] validating checksum for workflow actions=${workflowActions.length}`,
        );

        for (const action of workflowActions) {
          const payload = action.payload as { checksum?: unknown };
          if (typeof payload.checksum !== "string" || payload.checksum.length === 0) {
            throw new ValidationError(
              "Workflow payload checksum missing. Regenerate plan before deploy.",
              {
                action_order: action.order,
                workflow_name: action.name,
                workflow_dev_id: action.dev_id,
              },
            );
          }

          const currentWorkflow = await this.devClient.getWorkflowById(action.dev_id);
          const currentHash = sha256(currentWorkflow);
          if (currentHash !== payload.checksum) {
            throw new ValidationError("DEV workflow has changed since plan generation", {
              action_order: action.order,
              workflow_name: action.name,
              workflow_dev_id: action.dev_id,
              expected: payload.checksum,
              actual: currentHash,
            });
          }

          if (action.dev_id === parsed.data.metadata.root_workflow_id) {
            if (currentHash !== parsed.data.metadata.checksum_root) {
              throw new ValidationError(
                "Root workflow checksum mismatch between metadata and workflow action payload",
                {
                  workflow_dev_id: action.dev_id,
                  metadata_checksum_root: parsed.data.metadata.checksum_root,
                  action_checksum: payload.checksum,
                  current_dev_checksum: currentHash,
                },
              );
            }
          }
        }
      });

      await this.runStep(
        "VAL",
        "04",
        "Validate workflow payloads include required fields for deploy",
        async () => {
          for (const action of parsed.data.actions) {
            if (action.type !== "WORKFLOW") {
              continue;
            }
            const payload = action.payload as { raw_json?: unknown };
            if (!this.hasWorkflowDeployShape(payload.raw_json)) {
              throw new ValidationError(
                "Workflow payload is missing required fields (expected nodes + connections). Regenerate plan.",
                {
                  action_order: action.order,
                  workflow_name: action.name,
                  workflow_dev_id: action.dev_id,
                },
              );
            }
          }
        },
      );

      logger.success(
        `[DEPLOY][VAL][DONE] Plan valid plan_id=${parsed.data.metadata.plan_id} actions=${parsed.data.actions.length}`,
      );
      return parsed.data;
    } catch (error) {
      this.logStepError("VAL", "XX", "Plan validation aborted", error);
      throw error;
    }
  }

  async executePlan(plan: DeploymentPlan): Promise<void> {
    logger.info(
      `[DEPLOY][RUN][00] Start deployment plan_id=${plan.metadata.plan_id} actions=${plan.actions.length}`,
    );
    const idMap: Record<string, string> = {};
    const orderedActions = this.topologicalSortActions(plan.actions);

    for (const action of orderedActions) {
      const actionTag = `${action.order.toString().padStart(3, "0")}`;
      const unresolvedDeps = action.dependencies.filter((depId) => !idMap[depId]);
      logger.info(
        `[DEPLOY][RUN][${actionTag}] Execute ${action.type}/${action.action} name="${action.name}" dev_id=${action.dev_id}`,
      );
      if (unresolvedDeps.length > 0) {
        logger.warn(
          `[DEPLOY][RUN][${actionTag}] unresolved dependencies before action: ${unresolvedDeps.join(", ")}`,
        );
      }

      const startedAt = Date.now();
      try {
        await this.executeAction(action, idMap, plan.metadata.root_workflow_id);
        const elapsedMs = Date.now() - startedAt;
        const mappedId = idMap[action.dev_id] ?? "n/a";
        logger.success(
          `[DEPLOY][RUN][${actionTag}] OK (${elapsedMs} ms) mapped ${action.dev_id} -> ${mappedId}`,
        );
      } catch (error) {
        this.logStepError("RUN", actionTag, `Action failed (${action.type}/${action.action})`, error);
        throw error;
      }
    }

    logger.success(`[DEPLOY][RUN][DONE] Deployment completed, mapped_ids=${Object.keys(idMap).length}`);
  }

  private async executeAction(
    action: PlanActionItem,
    idMap: Record<string, string>,
    rootWorkflowDevId: string,
  ): Promise<void> {
    if (action.type === "CREDENTIAL") {
      await this.executeCredential(action, idMap);
      return;
    }

    if (action.type === "DATATABLE") {
      await this.executeDataTable(action, idMap);
      return;
    }

    await this.executeWorkflow(action, idMap, rootWorkflowDevId);
  }

  private async executeCredential(action: PlanActionItem, idMap: Record<string, string>): Promise<void> {
    if (action.action === "MAP_EXISTING" && action.prod_id) {
      logger.debug(
        `[DEPLOY][RUN][CREDENTIAL] MAP_EXISTING name="${action.name}" dev_id=${action.dev_id} prod_id=${action.prod_id}`,
      );
      idMap[action.dev_id] = action.prod_id;
      return;
    }

    const payload = action.payload as { name: string; type: string };
    logger.debug(
      `[DEPLOY][RUN][CREDENTIAL] CREATE placeholder name="${payload.name}" type="${payload.type}" data=auto-from-schema`,
    );
    const created = await this.prodClient.createCredentialPlaceholder({
      name: payload.name,
      type: payload.type,
    });
    idMap[action.dev_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][CREDENTIAL] CREATED name="${payload.name}" dev_id=${action.dev_id} prod_id=${created.id}`,
    );
  }

  private async executeDataTable(action: PlanActionItem, idMap: Record<string, string>): Promise<void> {
    if (action.action === "MAP_EXISTING" && action.prod_id) {
      logger.debug(
        `[DEPLOY][RUN][DATATABLE] MAP_EXISTING name="${action.name}" dev_id=${action.dev_id} prod_id=${action.prod_id}`,
      );
      idMap[action.dev_id] = action.prod_id;
      return;
    }

    const payload = action.payload as {
      name: string;
      columns: Array<Record<string, unknown>>;
      rows: Array<Record<string, unknown>>;
    };
    logger.debug(
      `[DEPLOY][RUN][DATATABLE] CREATE name="${payload.name}" columns=${payload.columns.length} rows=${payload.rows.length}`,
    );
    const created = await this.prodClient.createDataTable(payload);
    idMap[action.dev_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][DATATABLE] CREATED name="${payload.name}" dev_id=${action.dev_id} prod_id=${created.id}`,
    );
  }

  private async executeWorkflow(
    action: PlanActionItem,
    idMap: Record<string, string>,
    rootWorkflowDevId: string,
  ): Promise<void> {
    const payload = action.payload as {
      raw_json: unknown;
    };

    logger.debug(
      `[DEPLOY][RUN][WORKFLOW] Preparing workflow name="${action.name}" deps=${action.dependencies.length}`,
    );
    const beforeHash = sha256(payload.raw_json);
    const patchedWorkflow = this.transformService.patchWorkflowIds(payload.raw_json, idMap);
    const afterHash = sha256(patchedWorkflow);
    logger.debug(
      `[DEPLOY][RUN][WORKFLOW] Patch result changed=${beforeHash !== afterHash} checksum_before=${beforeHash.slice(0, 8)} checksum_after=${afterHash.slice(0, 8)}`,
    );

    if (action.action === "UPDATE") {
      const targetId = action.prod_id ?? idMap[action.dev_id];
      if (!targetId) {
        throw new ValidationError("Workflow UPDATE action missing prod_id mapping", {
          devId: action.dev_id,
          name: action.name,
        });
      }
      let currentProdWorkflow: unknown | null = null;
      const mustLoadCurrentProd =
        action.dev_id === rootWorkflowDevId || !this.options.forceUpdate;
      if (mustLoadCurrentProd) {
        currentProdWorkflow = await this.prodClient.getWorkflowById(targetId);
      }

      if (!this.options.forceUpdate) {
        const normalizedDesired = this.prodClient.normalizeWorkflowForWrite(patchedWorkflow);
        const normalizedCurrent = this.prodClient.normalizeWorkflowForWrite(currentProdWorkflow);
        const desiredHash = sha256(normalizedDesired);
        const currentHash = sha256(normalizedCurrent);
        if (desiredHash === currentHash) {
          logger.info(
            `[DEPLOY][RUN][WORKFLOW] SKIP UPDATE (unchanged in PROD) name="${action.name}" prod_id=${targetId} checksum=${currentHash.slice(0, 8)}`,
          );
          idMap[action.dev_id] = targetId;
          return;
        }
        logger.debug(
          `[DEPLOY][RUN][WORKFLOW] UPDATE required (diff detected) name="${action.name}" target_prod_id=${targetId} checksum_current=${currentHash.slice(0, 8)} checksum_desired=${desiredHash.slice(0, 8)}`,
        );
      } else {
        logger.info(
          `[DEPLOY][RUN][WORKFLOW] FORCED UPDATE (--force-update) name="${action.name}" target_prod_id=${targetId}`,
        );
      }

      if (action.dev_id === rootWorkflowDevId) {
        if (this.isWorkflowActive(currentProdWorkflow)) {
          logger.info(
            `[DEPLOY][RUN][WORKFLOW] Root workflow is active, deactivating before update id=${targetId}`,
          );
          await this.prodClient.deactivateWorkflow(targetId);
        }
      }
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATE name="${action.name}" target_prod_id=${targetId}`,
      );
      const updated = await this.prodClient.updateWorkflow(targetId, patchedWorkflow);
      idMap[action.dev_id] = updated.id;
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATED name="${action.name}" dev_id=${action.dev_id} prod_id=${updated.id}`,
      );
      await this.postWorkflowWrite(updated.id, action, rootWorkflowDevId);
      return;
    }

    logger.debug(`[DEPLOY][RUN][WORKFLOW] CREATE name="${action.name}"`);
    const created = await this.prodClient.createWorkflow(patchedWorkflow);
    idMap[action.dev_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][WORKFLOW] CREATED name="${action.name}" dev_id=${action.dev_id} prod_id=${created.id}`,
    );
    await this.postWorkflowWrite(created.id, action, rootWorkflowDevId);
  }

  private async runStep(
    phase: "VAL" | "RUN",
    step: string,
    description: string,
    run: () => Promise<void>,
  ): Promise<void>;
  private async runStep<T>(
    phase: "VAL" | "RUN",
    step: string,
    description: string,
    run: () => Promise<T>,
  ): Promise<T>;
  private async runStep<T>(
    phase: "VAL" | "RUN",
    step: string,
    description: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info(`[DEPLOY][${phase}][${step}] ${description}`);
    try {
      const result = await run();
      const elapsedMs = Date.now() - startedAt;
      logger.success(`[DEPLOY][${phase}][${step}] OK (${elapsedMs} ms)`);
      return result;
    } catch (error) {
      this.logStepError(phase, step, description, error);
      throw error;
    }
  }

  private logStepError(
    phase: "VAL" | "RUN",
    step: string,
    description: string,
    error: unknown,
  ): void {
    logger.error(`[DEPLOY][${phase}][${step}] FAIL: ${description}`);
    if (error instanceof ApiError) {
      logger.error(`[DEPLOY][${phase}][${step}] ApiError: ${error.message}`);
      if (error.status) {
        logger.error(`[DEPLOY][${phase}][${step}] status=${error.status}`);
      }
      if (error.context) {
        logger.error(`[DEPLOY][${phase}][${step}] context=${JSON.stringify(error.context, null, 2)}`);
      }
      return;
    }
    if (error instanceof ValidationError) {
      logger.error(`[DEPLOY][${phase}][${step}] ValidationError: ${error.message}`);
      if (error.details) {
        logger.error(`[DEPLOY][${phase}][${step}] details=${JSON.stringify(error.details, null, 2)}`);
      }
      return;
    }
    const fallback = error as Error;
    logger.error(`[DEPLOY][${phase}][${step}] Error: ${fallback.message}`);
  }

  private hasWorkflowDeployShape(rawWorkflow: unknown): boolean {
    if (!rawWorkflow || typeof rawWorkflow !== "object" || Array.isArray(rawWorkflow)) {
      return false;
    }
    const candidate = rawWorkflow as Record<string, unknown>;
    const hasNodes = Array.isArray(candidate.nodes);
    const connections = candidate.connections;
    const hasConnections =
      !!connections && typeof connections === "object" && !Array.isArray(connections);
    return hasNodes && hasConnections;
  }

  private topologicalSortActions(actions: PlanActionItem[]): PlanActionItem[] {
    const byDevId = new Map<string, PlanActionItem>();
    for (const action of actions) {
      byDevId.set(action.dev_id, action);
    }

    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const action of actions) {
      indegree.set(action.dev_id, 0);
      outgoing.set(action.dev_id, []);
    }

    for (const action of actions) {
      for (const dependency of action.dependencies) {
        if (dependency === action.dev_id) {
          logger.warn(
            `[DEPLOY][RUN][ORDER] Ignoring self dependency dev_id=${action.dev_id}`,
          );
          continue;
        }
        if (!byDevId.has(dependency)) {
          logger.warn(
            `[DEPLOY][RUN][ORDER] Ignoring external dependency not present in plan dev_id=${action.dev_id} dependency=${dependency}`,
          );
          continue;
        }
        indegree.set(action.dev_id, (indegree.get(action.dev_id) ?? 0) + 1);
        outgoing.get(dependency)?.push(action.dev_id);
      }
    }

    const queue: string[] = [];
    for (const action of actions) {
      if ((indegree.get(action.dev_id) ?? 0) === 0) {
        queue.push(action.dev_id);
      }
    }
    queue.sort((a, b) => this.compareActionsForRuntimeOrder(byDevId.get(a)!, byDevId.get(b)!));

    const result: PlanActionItem[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) {
        break;
      }
      const action = byDevId.get(currentId);
      if (!action) {
        continue;
      }
      result.push(action);

      for (const dependentId of outgoing.get(currentId) ?? []) {
        const next = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, next);
        if (next === 0) {
          queue.push(dependentId);
          queue.sort((a, b) =>
            this.compareActionsForRuntimeOrder(byDevId.get(a)!, byDevId.get(b)!),
          );
        }
      }
    }

    if (result.length !== actions.length) {
      const placed = new Set(result.map((action) => action.dev_id));
      const remaining = actions
        .filter((action) => !placed.has(action.dev_id))
        .sort((a, b) => this.compareActionsForRuntimeOrder(a, b));

      logger.warn(
        `[DEPLOY][RUN][ORDER] Cycle detected in plan dependencies; applying deterministic fallback for remaining actions=${remaining.length}`,
      );
      result.push(...remaining);
    }

    logger.debug(
      `[DEPLOY][RUN][ORDER] Runtime topological order applied actions=${result.length}`,
    );
    return result;
  }

  private compareActionsForRuntimeOrder(a: PlanActionItem, b: PlanActionItem): number {
    const typeWeight = (type: PlanActionItem["type"]): number => {
      if (type === "CREDENTIAL") return 1;
      if (type === "DATATABLE") return 2;
      return 3;
    };
    const typeDiff = typeWeight(a.type) - typeWeight(b.type);
    if (typeDiff !== 0) {
      return typeDiff;
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.name.localeCompare(b.name);
  }

  private async postWorkflowWrite(
    prodWorkflowId: string,
    action: PlanActionItem,
    rootWorkflowDevId: string,
  ): Promise<void> {
    if (action.dev_id === rootWorkflowDevId) {
      logger.info(
        `[DEPLOY][RUN][WORKFLOW] Skip auto-publish for ROOT workflow name="${action.name}" prod_id=${prodWorkflowId}`,
      );
      return;
    }

    logger.info(
      `[DEPLOY][RUN][WORKFLOW] Auto-publishing sub-workflow name="${action.name}" prod_id=${prodWorkflowId}`,
    );
    await this.prodClient.activateWorkflow(prodWorkflowId);
  }

  private isWorkflowActive(workflow: unknown): boolean {
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      return false;
    }
    const candidate = workflow as Record<string, unknown>;
    return candidate.active === true;
  }
}
