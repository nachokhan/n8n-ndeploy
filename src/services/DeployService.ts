import { DeploymentPlan, DeploymentPlanSchema, PlanActionItem } from "../types/plan.js";
import { N8nClient } from "./N8nClient.js";
import { TransformService } from "./TransformService.js";
import { ApiError, ValidationError } from "../errors/index.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

export class DeployService {
  constructor(
    private readonly devClient: N8nClient,
    private readonly prodClient: N8nClient,
    private readonly transformService: TransformService,
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

      await this.runStep("VAL", "03", "Validate DEV checksum has not changed", async () => {
        const currentRoot = await this.devClient.getWorkflowById(parsed.data.metadata.root_workflow_id);
        const currentHash = sha256(currentRoot);
        if (currentHash !== parsed.data.metadata.checksum_root) {
          throw new ValidationError("DEV root workflow has changed since plan generation", {
            expected: parsed.data.metadata.checksum_root,
            actual: currentHash,
          });
        }
      });

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
    const orderedActions = [...plan.actions].sort((a, b) => a.order - b.order);

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
        await this.executeAction(action, idMap);
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

  private async executeAction(action: PlanActionItem, idMap: Record<string, string>): Promise<void> {
    if (action.type === "CREDENTIAL") {
      await this.executeCredential(action, idMap);
      return;
    }

    if (action.type === "DATATABLE") {
      await this.executeDataTable(action, idMap);
      return;
    }

    await this.executeWorkflow(action, idMap);
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
      `[DEPLOY][RUN][CREDENTIAL] CREATE placeholder name="${payload.name}" type="${payload.type}"`,
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

  private async executeWorkflow(action: PlanActionItem, idMap: Record<string, string>): Promise<void> {
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
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATE name="${action.name}" target_prod_id=${targetId}`,
      );
      const updated = await this.prodClient.updateWorkflow(targetId, patchedWorkflow);
      idMap[action.dev_id] = updated.id;
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATED name="${action.name}" dev_id=${action.dev_id} prod_id=${updated.id}`,
      );
      return;
    }

    logger.debug(`[DEPLOY][RUN][WORKFLOW] CREATE name="${action.name}"`);
    const created = await this.prodClient.createWorkflow(patchedWorkflow);
    idMap[action.dev_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][WORKFLOW] CREATED name="${action.name}" dev_id=${action.dev_id} prod_id=${created.id}`,
    );
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
}
