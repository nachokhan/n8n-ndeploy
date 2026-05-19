import { randomUUID } from "crypto";
import { DeploymentPlan, DeploymentPlanSchema, PlanActionItem } from "../types/plan.js";
import {
  DeployActionResultItem,
  DeployActionStatus,
  DeployResult,
  WorkflowPublishStatus,
} from "../types/deployResult.js";
import { CredentialsManifestEntry } from "../types/credentials.js";
import { N8nClient } from "./N8nClient.js";
import { TransformService } from "./TransformService.js";
import { ApiError, ValidationError } from "../errors/index.js";
import { sha256, sha256Stable } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

interface DeployServiceOptions {
  forceUpdate?: boolean;
}

interface ExecuteActionOutcome {
  status: Exclude<DeployActionStatus, "failed">;
  target_id: string | null;
  publish_status: WorkflowPublishStatus;
}

export class DeployService {
  private lastDeployResult: DeployResult | null = null;

  constructor(
    private readonly sourceClient: N8nClient,
    private readonly targetClient: N8nClient,
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
          (a) => a.type === "WORKFLOW" && a.source_id === parsed.data.metadata.root_workflow_id,
        );
        if (!root) {
          throw new ValidationError("Root workflow action not found in plan", parsed.data.metadata);
        }
      });

      await this.runStep("VAL", "03", "Validate source workflow checksums have not changed", async () => {
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
                workflow_source_id: action.source_id,
              },
            );
          }

          const currentWorkflow = await this.sourceClient.getWorkflowById(action.source_id);
          const currentHash = sha256(currentWorkflow);
          if (currentHash !== payload.checksum) {
            throw new ValidationError("Source workflow has changed since plan generation", {
              action_order: action.order,
              workflow_name: action.name,
              workflow_source_id: action.source_id,
              expected: payload.checksum,
              actual: currentHash,
            });
          }

          if (action.source_id === parsed.data.metadata.root_workflow_id) {
            if (currentHash !== parsed.data.metadata.checksum_root) {
              throw new ValidationError(
                "Root workflow checksum mismatch between metadata and workflow action payload",
                {
                  workflow_source_id: action.source_id,
                  metadata_checksum_root: parsed.data.metadata.checksum_root,
                  action_checksum: payload.checksum,
                  current_source_checksum: currentHash,
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
                  workflow_source_id: action.source_id,
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
    await this.executePlanWithResult(plan, "unknown");
  }

  async executePlanWithResult(
    plan: DeploymentPlan,
    project: string,
    credentialsManifestBySourceId: Map<string, CredentialsManifestEntry> | null = null,
  ): Promise<DeployResult> {
    logger.info(
      `[DEPLOY][RUN][00] Start deployment plan_id=${plan.metadata.plan_id} actions=${plan.actions.length}`,
    );
    const startedAt = new Date().toISOString();
    const byType = {
      CREDENTIAL: plan.actions.filter((action) => action.type === "CREDENTIAL").length,
      DATATABLE: plan.actions.filter((action) => action.type === "DATATABLE").length,
      WORKFLOW: plan.actions.filter((action) => action.type === "WORKFLOW").length,
    };
    const byAction = {
      CREATE: plan.actions.filter((action) => action.action === "CREATE").length,
      UPDATE: plan.actions.filter((action) => action.action === "UPDATE").length,
      MAP_EXISTING: plan.actions.filter((action) => action.action === "MAP_EXISTING").length,
    };
    const result: DeployResult = {
      metadata: {
        run_id: randomUUID(),
        plan_id: plan.metadata.plan_id,
        project,
        started_at: startedAt,
        finished_at: startedAt,
        force_update: this.options.forceUpdate === true,
      },
      totals: {
        total: plan.actions.length,
        executed: 0,
        skipped: 0,
        failed: 0,
        by_type: byType,
        by_action: byAction,
      },
      credentials: [],
      datatables: [],
      workflows: [],
      errors: [],
    };

    const idMap: Record<string, string> = {};
    const orderedActions = this.topologicalSortActions(plan.actions);

    for (const action of orderedActions) {
      const actionTag = `${action.order.toString().padStart(3, "0")}`;
      const unresolvedDeps = action.dependencies.filter((depId) => !idMap[depId]);
      logger.info(
        `[DEPLOY][RUN][${actionTag}] Execute ${action.type}/${action.action} name="${action.name}" source_id=${action.source_id}`,
      );
      if (unresolvedDeps.length > 0) {
        logger.warn(
          `[DEPLOY][RUN][${actionTag}] unresolved dependencies before action: ${unresolvedDeps.join(", ")}`,
        );
      }

      const startedAt = Date.now();
      try {
        const outcome = await this.executeAction(
          action,
          idMap,
          plan.metadata.root_workflow_id,
          credentialsManifestBySourceId,
        );
        const elapsedMs = Date.now() - startedAt;
        const mappedId = idMap[action.source_id] ?? "n/a";
        const actionResult: DeployActionResultItem = {
          order: action.order,
          type: action.type,
          action: action.action,
          name: action.name,
          status: outcome.status,
          target_id: outcome.target_id,
          duration_ms: elapsedMs,
          dependencies: action.dependencies,
          observability: action.observability ?? null,
          publish_status: outcome.publish_status,
          error: null,
        };
        this.pushActionResult(result, actionResult);
        if (outcome.status === "executed") {
          result.totals.executed += 1;
        } else {
          result.totals.skipped += 1;
        }
        logger.success(
          `[DEPLOY][RUN][${actionTag}] OK (${elapsedMs} ms) mapped ${action.source_id} -> ${mappedId}`,
        );
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const actionResult: DeployActionResultItem = {
          order: action.order,
          type: action.type,
          action: action.action,
          name: action.name,
          status: "failed",
          target_id: idMap[action.source_id] ?? action.target_id ?? null,
          duration_ms: elapsedMs,
          dependencies: action.dependencies,
          observability: action.observability ?? null,
          publish_status: "not_applicable",
          error: {
            message: this.extractErrorMessage(error),
            status_code: this.extractErrorStatus(error),
          },
        };
        this.pushActionResult(result, actionResult);
        result.totals.failed += 1;
        result.errors.push({
          order: action.order,
          type: action.type,
          name: action.name,
          message: this.extractErrorMessage(error),
          status_code: this.extractErrorStatus(error),
        });
        result.metadata.finished_at = new Date().toISOString();
        this.lastDeployResult = result;
        this.logStepError("RUN", actionTag, `Action failed (${action.type}/${action.action})`, error);
        throw error;
      }
    }

    result.metadata.finished_at = new Date().toISOString();
    this.lastDeployResult = result;
    logger.success(`[DEPLOY][RUN][DONE] Deployment completed, mapped_ids=${Object.keys(idMap).length}`);
    return result;
  }

  getLastDeployResult(): DeployResult | null {
    return this.lastDeployResult;
  }

  private async executeAction(
    action: PlanActionItem,
    idMap: Record<string, string>,
    rootWorkflowSourceId: string,
    credentialsManifestBySourceId: Map<string, CredentialsManifestEntry> | null,
  ): Promise<ExecuteActionOutcome> {
    if (action.type === "CREDENTIAL") {
      return this.executeCredential(action, idMap, credentialsManifestBySourceId);
    }

    if (action.type === "DATATABLE") {
      return this.executeDataTable(action, idMap);
    }

    return this.executeWorkflow(action, idMap, rootWorkflowSourceId);
  }

  private async executeCredential(
    action: PlanActionItem,
    idMap: Record<string, string>,
    credentialsManifestBySourceId: Map<string, CredentialsManifestEntry> | null,
  ): Promise<ExecuteActionOutcome> {
    if (action.action === "MAP_EXISTING" && action.target_id) {
      logger.debug(
        `[DEPLOY][RUN][CREDENTIAL] MAP_EXISTING name="${action.name}" source_id=${action.source_id} target_id=${action.target_id}`,
      );
      idMap[action.source_id] = action.target_id;
      return {
        status: "executed",
        target_id: action.target_id,
        publish_status: "not_applicable",
      };
    }

    const payload = action.payload as { name: string; type: string };
    const manifestEntry = credentialsManifestBySourceId?.get(action.source_id) ?? null;
    if (!manifestEntry) {
      throw new ValidationError("Credential manifest entry missing for credential CREATE action", {
        source_id: action.source_id,
        name: payload.name,
        type: payload.type,
      });
    }

    const requiredFields = [
      ...new Set([
        ...manifestEntry.template.required_fields,
        ...this.getCredentialTypeRequiredDataFields(payload.type),
      ]),
    ];
    const missingRequiredFields = requiredFields.filter((field) =>
      this.isMissingManifestValue(manifestEntry.template.data[field]),
    );
    if (missingRequiredFields.length > 0) {
      throw new ValidationError("Credential manifest entry is missing required fields", {
        source_id: action.source_id,
        name: payload.name,
        type: payload.type,
        missing_required_fields: missingRequiredFields,
      });
    }

    const dataKeys = Object.keys(manifestEntry.template.data);
    if (!this.hasManifestData(manifestEntry.template.data)) {
      throw new ValidationError("Credential manifest entry has no data for credential CREATE action", {
        source_id: action.source_id,
        name: payload.name,
        type: payload.type,
      });
    }

    logger.debug(
      `[DEPLOY][RUN][CREDENTIAL] CREATE from manifest name="${payload.name}" type="${payload.type}" data_keys=${dataKeys.length}`,
    );
    const created = await this.targetClient.createCredentialPlaceholder({
      name: payload.name,
      type: payload.type,
      data: manifestEntry.template.data,
    });
    idMap[action.source_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][CREDENTIAL] CREATED name="${payload.name}" source_id=${action.source_id} target_id=${created.id}`,
    );
    return {
      status: "executed",
      target_id: created.id,
      publish_status: "not_applicable",
    };
  }

  private async executeDataTable(
    action: PlanActionItem,
    idMap: Record<string, string>,
  ): Promise<ExecuteActionOutcome> {
    if (action.action === "MAP_EXISTING" && action.target_id) {
      logger.debug(
        `[DEPLOY][RUN][DATATABLE] MAP_EXISTING name="${action.name}" source_id=${action.source_id} target_id=${action.target_id}`,
      );
      idMap[action.source_id] = action.target_id;
      return {
        status: "executed",
        target_id: action.target_id,
        publish_status: "not_applicable",
      };
    }

    const payload = action.payload as {
      name: string;
      columns: Array<Record<string, unknown>>;
      rows: Array<Record<string, unknown>>;
    };
    logger.debug(
      `[DEPLOY][RUN][DATATABLE] CREATE name="${payload.name}" columns=${payload.columns.length} rows=${payload.rows.length}`,
    );
    const created = await this.targetClient.createDataTable(payload);
    idMap[action.source_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][DATATABLE] CREATED name="${payload.name}" source_id=${action.source_id} target_id=${created.id}`,
    );
    return {
      status: "executed",
      target_id: created.id,
      publish_status: "not_applicable",
    };
  }

  private async executeWorkflow(
    action: PlanActionItem,
    idMap: Record<string, string>,
    rootWorkflowSourceId: string,
  ): Promise<ExecuteActionOutcome> {
    let targetIdForUpdate: string | null = null;
    if (action.action === "UPDATE") {
      const resolvedTargetId = action.target_id ?? idMap[action.source_id];
      if (!resolvedTargetId) {
        throw new ValidationError("Workflow UPDATE action missing target_id mapping", {
          sourceId: action.source_id,
          name: action.name,
        });
      }
      // Pre-map the workflow itself so self-references can be patched to the target id.
      idMap[action.source_id] = resolvedTargetId;
      targetIdForUpdate = resolvedTargetId;
    }

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
      const targetId = targetIdForUpdate as string;
      let currentTargetWorkflow: unknown | null = null;
      const mustLoadCurrentTarget =
        action.source_id === rootWorkflowSourceId || !this.options.forceUpdate;
      if (mustLoadCurrentTarget) {
        currentTargetWorkflow = await this.targetClient.getWorkflowById(targetId);
      }

      if (!this.options.forceUpdate) {
        const normalizedDesired = this.targetClient.normalizeWorkflowForComparison(patchedWorkflow);
        const normalizedCurrent = this.targetClient.normalizeWorkflowForComparison(currentTargetWorkflow);
        const desiredHash = sha256Stable(normalizedDesired);
        const currentHash = sha256Stable(normalizedCurrent);
        if (desiredHash === currentHash) {
          logger.info(
            `[DEPLOY][RUN][WORKFLOW] SKIP UPDATE (unchanged in target) name="${action.name}" target_id=${targetId} checksum=${currentHash.slice(0, 8)}`,
          );
          idMap[action.source_id] = targetId;
          return {
            status: "skipped",
            target_id: targetId,
            publish_status: "not_applicable",
          };
        }
        logger.debug(
          `[DEPLOY][RUN][WORKFLOW] UPDATE required (diff detected) name="${action.name}" target_id=${targetId} checksum_current=${currentHash.slice(0, 8)} checksum_desired=${desiredHash.slice(0, 8)}`,
        );
      } else {
        logger.info(
          `[DEPLOY][RUN][WORKFLOW] FORCED UPDATE (--force-update) name="${action.name}" target_target_id=${targetId}`,
        );
      }

      if (action.source_id === rootWorkflowSourceId) {
        if (this.isWorkflowActive(currentTargetWorkflow)) {
          logger.info(
            `[DEPLOY][RUN][WORKFLOW] Root workflow is active, deactivating before update id=${targetId}`,
          );
          await this.targetClient.deactivateWorkflow(targetId);
        }
      }
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATE name="${action.name}" target_target_id=${targetId}`,
      );
      const updated = await this.targetClient.updateWorkflow(targetId, patchedWorkflow);
      idMap[action.source_id] = updated.id;
      logger.debug(
        `[DEPLOY][RUN][WORKFLOW] UPDATED name="${action.name}" source_id=${action.source_id} target_id=${updated.id}`,
      );
      const publishStatus = await this.postWorkflowWrite(updated.id, action, rootWorkflowSourceId);
      return {
        status: "executed",
        target_id: updated.id,
        publish_status: publishStatus,
      };
    }

    logger.debug(`[DEPLOY][RUN][WORKFLOW] CREATE name="${action.name}"`);
    const created = await this.targetClient.createWorkflow(patchedWorkflow);
    idMap[action.source_id] = created.id;
    logger.debug(
      `[DEPLOY][RUN][WORKFLOW] CREATED name="${action.name}" source_id=${action.source_id} target_id=${created.id}`,
    );
    const publishStatus = await this.postWorkflowWrite(created.id, action, rootWorkflowSourceId);
    return {
      status: "executed",
      target_id: created.id,
      publish_status: publishStatus,
    };
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
    const bySourceId = new Map<string, PlanActionItem>();
    for (const action of actions) {
      bySourceId.set(action.source_id, action);
    }

    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const action of actions) {
      indegree.set(action.source_id, 0);
      outgoing.set(action.source_id, []);
    }

    for (const action of actions) {
      for (const dependency of action.dependencies) {
        if (dependency === action.source_id) {
          logger.warn(
            `[DEPLOY][RUN][ORDER] Ignoring self dependency source_id=${action.source_id}`,
          );
          continue;
        }
        if (!bySourceId.has(dependency)) {
          logger.warn(
            `[DEPLOY][RUN][ORDER] Ignoring external dependency not present in plan source_id=${action.source_id} dependency=${dependency}`,
          );
          continue;
        }
        indegree.set(action.source_id, (indegree.get(action.source_id) ?? 0) + 1);
        outgoing.get(dependency)?.push(action.source_id);
      }
    }

    const queue: string[] = [];
    for (const action of actions) {
      if ((indegree.get(action.source_id) ?? 0) === 0) {
        queue.push(action.source_id);
      }
    }
    queue.sort((a, b) => this.compareActionsForRuntimeOrder(bySourceId.get(a)!, bySourceId.get(b)!));

    const result: PlanActionItem[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) {
        break;
      }
      const action = bySourceId.get(currentId);
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
            this.compareActionsForRuntimeOrder(bySourceId.get(a)!, bySourceId.get(b)!),
          );
        }
      }
    }

    if (result.length !== actions.length) {
      const placed = new Set(result.map((action) => action.source_id));
      const remaining = actions
        .filter((action) => !placed.has(action.source_id))
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
    targetWorkflowId: string,
    action: PlanActionItem,
    rootWorkflowSourceId: string,
  ): Promise<WorkflowPublishStatus> {
    if (action.source_id === rootWorkflowSourceId) {
      logger.info(
        `[DEPLOY][RUN][WORKFLOW] Skip auto-publish for ROOT workflow name="${action.name}" target_id=${targetWorkflowId}`,
      );
      return "skipped_root";
    }

    logger.info(
      `[DEPLOY][RUN][WORKFLOW] Auto-publishing sub-workflow name="${action.name}" target_id=${targetWorkflowId}`,
    );
    await this.targetClient.activateWorkflow(targetWorkflowId);
    return "auto_published";
  }

  private isWorkflowActive(workflow: unknown): boolean {
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      return false;
    }
    const candidate = workflow as Record<string, unknown>;
    return candidate.active === true;
  }

  private pushActionResult(result: DeployResult, actionResult: DeployActionResultItem): void {
    if (actionResult.type === "CREDENTIAL") {
      result.credentials.push(actionResult);
      return;
    }
    if (actionResult.type === "DATATABLE") {
      result.datatables.push(actionResult);
      return;
    }
    result.workflows.push(actionResult);
  }

  private extractErrorStatus(error: unknown): number | null {
    if (error instanceof ApiError) {
      return error.status ?? null;
    }
    return null;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof ApiError || error instanceof ValidationError) {
      return error.message;
    }
    const fallback = error as Error;
    return fallback.message;
  }

  private isMissingManifestValue(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true;
    }

    if (typeof value === "string") {
      return value.trim().length === 0;
    }

    return false;
  }

  private hasManifestData(data: Record<string, unknown>): boolean {
    return Object.keys(data).some((key) => !this.isMissingManifestValue(data[key]));
  }

  private getCredentialTypeRequiredDataFields(type: string): string[] {
    if (type === "httpHeaderAuth") {
      return ["name", "value"];
    }
    return [];
  }
}
