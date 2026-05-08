import ora from "ora";
import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../errors/index.js";
import { readRequiredProjectMetadata } from "../utils/project.js";
import { buildApiFromRuntime } from "./apiFactory.js";

export function registerNPlanCommand(program: Command): void {
  const nplan = new Command("plan");

  nplan
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--profile <name>", "Override project profile for this run")
    .description("Generate deployment plan from project root workflow")
    .action(async (projectArg: string | undefined, options: { profile?: string }) => {
      const spinner = ora("Preparing nplan execution").start();
      try {
        const { project, metadata } = await readRequiredProjectMetadata(projectArg);
        if (!metadata.plan.root_workflow_id_source) {
          throw new ValidationError(`Project \"${project}\" has no root workflow configured. Run: ndeploy create <workflow_id_source> [project_root]`);
        }
        const { api, profileName } = await buildApiFromRuntime({
          profile: options.profile,
          projectMetadata: metadata,
        });
        spinner.succeed("Environment loaded");
        if (profileName) logger.info(`[NPLAN] profile=${profileName}`);
        const result = await api.generatePlan({ projectPath: project });
        if (result.backupPath) logger.success(`[NPLAN] Existing plan backed up to: ${result.backupPath}`);
        logger.success(`Plan file: ${result.planPath}`);
        logger.success(`Plan summary file: ${result.summaryPath}`);
        logger.info(`[NPLAN] Summary -> actions=${result.plan.actions.length}, plan_id=${result.plan.metadata.plan_id}`);
      } catch (error) {
        if (spinner.isSpinning) spinner.fail("nplan failed");
        throw error;
      }
    });

  program.addCommand(nplan);
}
