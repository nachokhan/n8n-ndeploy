import ora from "ora";
import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { buildApiFromRuntime } from "./apiFactory.js";

export function registerNPublishCommand(program: Command): void {
  program
    .command("publish")
    .argument("<workflow_id_target>", "Workflow ID in the configured target instance to publish")
    .option("--profile <name>", "Use a named profile from ~/.ndeploy/profiles.json")
    .description("Manually publish a workflow in the configured target instance")
    .action(async (workflowIdTarget: string, options: { profile?: string }) => {
      const spinner = ora("Publishing workflow in target instance").start();
      try {
        const { api, profileName } = await buildApiFromRuntime({ profile: options.profile });
        await api.publishWorkflow({ workflowIdTarget });
        spinner.succeed("Workflow published");
        if (profileName) logger.info(`[NPUBLISH] profile=${profileName}`);
        logger.success(`[NPUBLISH] Published workflow ${workflowIdTarget}`);
      } catch (error) {
        spinner.fail("Manual publish failed");
        throw error;
      }
    });
}
