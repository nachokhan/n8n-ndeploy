import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { PlanService } from "../services/PlanService.js";
import { PlanSummaryService } from "../services/PlanSummaryService.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import {
  backupProjectPlanIfExists,
  ensureProjectDir,
  fileExists,
  readJsonFile,
  resolveProjectPlanFilePath,
  resolveProjectPlanSummaryFilePath,
  resolveProjectMetadataFilePath,
  ProjectMetadata,
  writeJsonFile,
} from "../utils/file.js";
import { ApiError, DependencyError, ValidationError } from "../errors/index.js";

export function registerNPlanCommand(program: Command): void {
  const nplan = new Command("plan");

  nplan
    .argument("<project>", "Project directory")
    .description("Generate deployment plan from project root workflow")
    .action(async (project: string) => {
      const spinner = ora("Preparing nplan execution").start();
      try {
        const env = loadEnv();
        spinner.succeed("Environment loaded");
        const metadataPath = resolveProjectMetadataFilePath(project);
        const projectMetadata = await readProjectMetadata(project, metadataPath);
        const workflowIdDev = projectMetadata.plan.root_workflow_id_dev;
        if (!workflowIdDev) {
          throw new ValidationError(
            `Project "${project}" has no root workflow configured. Run: ndeploy create <workflow_id_dev> [project_root]`,
          );
        }
        logger.info(`[NPLAN] root_workflow_id=${workflowIdDev}`);
        logger.info(`[NPLAN] project=${project}`);
        logger.debug(`[NPLAN] source=${env.N8N_DEV_URL} target=${env.N8N_PROD_URL}`);

        const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);
        const service = new PlanService(devClient, prodClient, env.N8N_DEV_URL, env.N8N_PROD_URL);
        const summaryService = new PlanSummaryService();

        logger.info("[NPLAN] Starting plan generation pipeline");
        const plan = await service.buildPlan(workflowIdDev);
        const summary = summaryService.buildSummary(plan);
        logger.info("[NPLAN] Plan generated in memory, writing JSON file");
        await ensureProjectDir(project);
        const outputFile = resolveProjectPlanFilePath(project);
        const summaryFile = resolveProjectPlanSummaryFilePath(project);
        const backupFile = await backupProjectPlanIfExists(project);
        if (backupFile) {
          logger.success(`[NPLAN] Existing plan backed up to: ${backupFile}`);
        }
        await writeJsonFile(outputFile, plan);
        await writeJsonFile(summaryFile, summary);
        const rootWorkflowAction = plan.actions.find(
          (action) => action.type === "WORKFLOW" && action.dev_id === workflowIdDev,
        );
        if (rootWorkflowAction && rootWorkflowAction.name !== projectMetadata.plan.root_workflow_name) {
          const now = new Date().toISOString();
          projectMetadata.plan.root_workflow_name = rootWorkflowAction.name;
          projectMetadata.plan.updated_at = now;
          projectMetadata.updated_at = now;
          await writeJsonFile(metadataPath, projectMetadata);
          logger.success(
            `[NPLAN] Project metadata updated with root workflow name="${rootWorkflowAction.name}"`,
          );
        }

        logger.success("[NPLAN] Plan JSON persisted");
        logger.success(`Plan file: ${outputFile}`);
        logger.success(`Plan summary file: ${summaryFile}`);
        logger.info(
          `[NPLAN] Summary -> actions=${plan.actions.length}, plan_id=${plan.metadata.plan_id}`,
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

async function readProjectMetadata(
  project: string,
  metadataPath: string,
): Promise<ProjectMetadata> {
  const exists = await fileExists(metadataPath);
  if (!exists) {
    throw new ValidationError(
      `Project "${project}" is not initialized. Run: ndeploy create <workflow_id_dev> [project_root]`,
    );
  }
  const metadata = await readJsonFile<ProjectMetadata>(metadataPath);
  if (!metadata.plan) {
    throw new ValidationError(
      `Project "${project}" metadata is missing "plan" configuration. Run: ndeploy create <workflow_id_dev> [project_root]`,
    );
  }
  return metadata;
}
