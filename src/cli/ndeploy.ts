import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { DeployService } from "../services/DeployService.js";
import { TransformService } from "../services/TransformService.js";
import { readJsonFile } from "../utils/file.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { ApiError, ValidationError } from "../errors/index.js";

export function registerNDeployCommand(program: Command): void {
  program
    .command("ndeploy")
    .argument("<plan_file_path>", "Path to plan JSON")
    .description("Execute deployment plan in PROD")
    .action(async (planFilePath: string) => {
      const validateSpinner = ora("Preparing ndeploy execution").start();
      let deploySpinner: ReturnType<typeof ora> | null = null;
      try {
        const env = loadEnv();
        validateSpinner.succeed("Environment loaded");
        logger.info(`[NDEPLOY] plan_file=${planFilePath}`);
        logger.debug(`[NDEPLOY] source=${env.N8N_DEV_URL} target=${env.N8N_PROD_URL}`);

        const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);
        const service = new DeployService(devClient, prodClient, new TransformService());

        logger.info("[NDEPLOY] Reading plan file");
        const rawPlan = await readJsonFile<unknown>(planFilePath);
        logger.info("[NDEPLOY] Validating plan");
        const plan = await service.validatePlan(rawPlan);

        logger.success(
          `[NDEPLOY] Plan valid plan_id=${plan.metadata.plan_id} actions=${plan.actions.length}`,
        );

        deploySpinner = ora(`Executing ${plan.actions.length} actions`).start();
        await service.executePlan(plan);
        deploySpinner.succeed("Deployment completed successfully");
      } catch (error) {
        if (deploySpinner?.isSpinning) {
          deploySpinner.fail("Deployment failed during action execution");
        } else if (validateSpinner.isSpinning) {
          validateSpinner.fail("Deployment failed");
        } else {
          logger.error("[NDEPLOY] Deployment failed");
        }
        if (error instanceof ApiError) {
          logger.error(`[NDEPLOY] ApiError: ${error.message}`);
          if (error.context) {
            logger.error(`[NDEPLOY] context=${JSON.stringify(error.context, null, 2)}`);
          }
        } else if (error instanceof ValidationError) {
          logger.error(`[NDEPLOY] ValidationError: ${error.message}`);
          if (error.details) {
            logger.error(`[NDEPLOY] details=${JSON.stringify(error.details, null, 2)}`);
          }
        } else {
          const fallback = error as Error;
          logger.error(`[NDEPLOY] Error: ${fallback.message}`);
        }
        throw error;
      }
    });

  logger.debug("Command ndeploy registered");
}
