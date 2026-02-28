import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { ApiError } from "../errors/index.js";

export function registerNPublishCommand(program: Command): void {
  program
    .command("npublish")
    .argument("<workflow_id_prod>", "Workflow ID in PROD to publish")
    .description("Manually publish a workflow in PROD")
    .action(async (workflowIdProd: string) => {
      const spinner = ora("Publishing workflow in PROD").start();
      try {
        const env = loadEnv();
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);

        logger.info(`[NPUBLISH] workflow_id_prod=${workflowIdProd}`);
        await prodClient.activateWorkflow(workflowIdProd);

        spinner.succeed("Workflow published");
        logger.success(`[NPUBLISH] Published workflow ${workflowIdProd}`);
      } catch (error) {
        spinner.fail("Manual publish failed");
        if (error instanceof ApiError) {
          logger.error(`[NPUBLISH] ApiError: ${error.message}`);
          if (error.context) {
            logger.error(`[NPUBLISH] context=${JSON.stringify(error.context, null, 2)}`);
          }
        }
        throw error;
      }
    });
}
