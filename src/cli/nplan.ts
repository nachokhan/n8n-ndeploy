import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { PlanService } from "../services/PlanService.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import {
  backupWorkspacePlanIfExists,
  ensureWorkspaceDir,
  resolveWorkspacePlanFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { ApiError, DependencyError, ValidationError } from "../errors/index.js";

export function registerNPlanCommand(program: Command): void {
  const nplan = new Command("plan");

  nplan
    .command("flow")
    .argument("<workflow_id_dev>", "Workflow ID in DEV")
    .argument("<workspace>", "Workspace directory")
    .description("Generate deployment plan in workspace/plan.json from DEV workflow and dependencies")
    .action(async (workflowIdDev: string, workspace: string) => {
      const spinner = ora("Preparing nplan execution").start();
      try {
        const env = loadEnv();
        spinner.succeed("Environment loaded");
        logger.info(`[NPLAN] root_workflow_id=${workflowIdDev}`);
        logger.info(`[NPLAN] workspace=${workspace}`);
        logger.debug(`[NPLAN] source=${env.N8N_DEV_URL} target=${env.N8N_PROD_URL}`);

        const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);
        const service = new PlanService(devClient, prodClient, env.N8N_DEV_URL, env.N8N_PROD_URL);

        logger.info("[NPLAN] Starting plan generation pipeline");
        const plan = await service.buildPlan(workflowIdDev);
        logger.info("[NPLAN] Plan generated in memory, writing JSON file");
        await ensureWorkspaceDir(workspace);
        const outputFile = resolveWorkspacePlanFilePath(workspace);
        const backupFile = await backupWorkspacePlanIfExists(workspace);
        if (backupFile) {
          logger.info(`[NPLAN] Existing plan backed up to: ${backupFile}`);
        }
        await writeJsonFile(outputFile, plan);

        logger.success("[NPLAN] Plan JSON persisted");
        logger.success(`Plan file: ${outputFile}`);
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
