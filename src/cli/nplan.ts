import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { PlanService } from "../services/PlanService.js";
import { PlanSummaryService } from "../services/PlanSummaryService.js";
import { ProductionCredentialsService } from "../services/ProductionCredentialsService.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import {
  backupWorkspacePlanIfExists,
  ensureWorkspaceDir,
  fileExists,
  readJsonFile,
  resolveWorkspacePlanFilePath,
  resolveWorkspacePlanSummaryFilePath,
  resolveWorkspaceProductionCredentialsFilePath,
  resolveWorkspaceMetadataFilePath,
  WorkspaceMetadata,
  writeJsonFile,
} from "../utils/file.js";
import { ApiError, DependencyError, ValidationError } from "../errors/index.js";

export function registerNPlanCommand(program: Command): void {
  const nplan = new Command("plan");

  nplan
    .argument("<workspace>", "Workspace directory")
    .description("Generate deployment plan from workspace root workflow")
    .action(async (workspace: string) => {
      const spinner = ora("Preparing nplan execution").start();
      try {
        const env = loadEnv();
        spinner.succeed("Environment loaded");
        const metadataPath = resolveWorkspaceMetadataFilePath(workspace);
        const workspaceMetadata = await readWorkspaceMetadata(workspace, metadataPath);
        const workflowIdDev = workspaceMetadata.plan.root_workflow_id_dev;
        if (!workflowIdDev) {
          throw new ValidationError(
            `Workspace "${workspace}" has no root workflow configured. Run: ndeploy create <workflow_id_dev> [workspace_root]`,
          );
        }
        logger.info(`[NPLAN] root_workflow_id=${workflowIdDev}`);
        logger.info(`[NPLAN] workspace=${workspace}`);
        logger.debug(`[NPLAN] source=${env.N8N_DEV_URL} target=${env.N8N_PROD_URL}`);

        const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);
        const service = new PlanService(devClient, prodClient, env.N8N_DEV_URL, env.N8N_PROD_URL);
        const summaryService = new PlanSummaryService();
        const productionCredentialsService = new ProductionCredentialsService();

        logger.info("[NPLAN] Starting plan generation pipeline");
        const plan = await service.buildPlan(workflowIdDev);
        const summary = summaryService.buildSummary(plan);
        const productionCredentials = productionCredentialsService.build(plan);
        logger.info("[NPLAN] Plan generated in memory, writing JSON file");
        await ensureWorkspaceDir(workspace);
        const outputFile = resolveWorkspacePlanFilePath(workspace);
        const summaryFile = resolveWorkspacePlanSummaryFilePath(workspace);
        const productionCredentialsFile = resolveWorkspaceProductionCredentialsFilePath(workspace);
        const backupFile = await backupWorkspacePlanIfExists(workspace);
        if (backupFile) {
          logger.info(`[NPLAN] Existing plan backed up to: ${backupFile}`);
        }
        await writeJsonFile(outputFile, plan);
        await writeJsonFile(summaryFile, summary);
        await writeJsonFile(productionCredentialsFile, productionCredentials);
        const rootWorkflowAction = plan.actions.find(
          (action) => action.type === "WORKFLOW" && action.dev_id === workflowIdDev,
        );
        if (rootWorkflowAction && rootWorkflowAction.name !== workspaceMetadata.plan.root_workflow_name) {
          const now = new Date().toISOString();
          workspaceMetadata.plan.root_workflow_name = rootWorkflowAction.name;
          workspaceMetadata.plan.updated_at = now;
          workspaceMetadata.updated_at = now;
          await writeJsonFile(metadataPath, workspaceMetadata);
          logger.info(
            `[NPLAN] Workspace metadata updated with root workflow name="${rootWorkflowAction.name}"`,
          );
        }

        logger.success("[NPLAN] Plan JSON persisted");
        logger.success(`Plan file: ${outputFile}`);
        logger.success(`Plan summary file: ${summaryFile}`);
        logger.success(`Production credentials file: ${productionCredentialsFile}`);
        logger.info(
          `[NPLAN] Summary -> actions=${plan.actions.length}, plan_id=${plan.metadata.plan_id}, missing_credentials_in_prod=${productionCredentials.summary.missing_in_prod}`,
        );
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("nplan failed");
        } else {
          logger.error("[NPLAN] nplan failed");
        }
        if (error instanceof ApiError) {
          logger.error(`[NPLAN] ApiError: ${error.message}`);
          if (error.context) {
            logger.error(`[NPLAN] context=${JSON.stringify(error.context, null, 2)}`);
          }
        } else if (error instanceof DependencyError) {
          logger.error(`[NPLAN] DependencyError: ${error.message}`);
          if (error.context) {
            logger.error(`[NPLAN] context=${JSON.stringify(error.context, null, 2)}`);
          }
        } else if (error instanceof ValidationError) {
          logger.error(`[NPLAN] ValidationError: ${error.message}`);
          if (error.details) {
            logger.error(`[NPLAN] details=${JSON.stringify(error.details, null, 2)}`);
          }
        } else {
          const fallback = error as Error;
          logger.error(`[NPLAN] Error: ${fallback.message}`);
        }
        throw error;
      }
    });

  program.addCommand(nplan);
}

async function readWorkspaceMetadata(
  workspace: string,
  metadataPath: string,
): Promise<WorkspaceMetadata> {
  const exists = await fileExists(metadataPath);
  if (!exists) {
    throw new ValidationError(
      `Workspace "${workspace}" is not initialized. Run: ndeploy create <workflow_id_dev> [workspace_root]`,
    );
  }
  const metadata = await readJsonFile<WorkspaceMetadata>(metadataPath);
  if (!metadata.plan) {
    throw new ValidationError(
      `Workspace "${workspace}" metadata is missing "plan" configuration. Run: ndeploy create <workflow_id_dev> [workspace_root]`,
    );
  }
  return metadata;
}
