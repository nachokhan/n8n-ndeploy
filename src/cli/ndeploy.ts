import ora from "ora";
import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { readRequiredProjectMetadata } from "../utils/project.js";
import { buildApiFromRuntime } from "./apiFactory.js";

export function registerNDeployCommand(program: Command): void {
  program
    .command("apply")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--force-update", "Always execute workflow UPDATE actions, even when target content is already equivalent")
    .option("--profile <name>", "Override project profile for this run")
    .description("Execute project/plan.json deployment plan in the configured target instance")
    .action(async (projectArg: string | undefined, options: { forceUpdate?: boolean; profile?: string }) => {
      const validateSpinner = ora("Preparing ndeploy execution").start();
      try {
        const { project, metadata } = await readRequiredProjectMetadata(projectArg);
        const { api, profileName } = await buildApiFromRuntime({
          profile: options.profile,
          projectMetadata: metadata,
        });
        validateSpinner.succeed("Environment loaded");
        if (profileName) logger.info(`[NDEPLOY] profile=${profileName}`);
        const deploySpinner = ora("Executing plan actions").start();
        const result = await api.applyPlan({ projectPath: project, forceUpdate: options.forceUpdate === true });
        deploySpinner.succeed(result.partial ? "Deployment completed with partial result" : "Deployment completed successfully");
        logger.success(`Deploy result file: ${result.resultPath}`);
        logger.success(`Deploy summary file: ${result.summaryPath}`);
      } catch (error) {
        if (validateSpinner.isSpinning) validateSpinner.fail("Deployment failed");
        throw error;
      }
    });

  logger.debug("Command apply registered");
}
