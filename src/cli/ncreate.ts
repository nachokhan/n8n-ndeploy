import ora from "ora";
import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { buildApiFromRuntime } from "./apiFactory.js";

interface InitCommandOptions {
  force?: boolean;
  profile?: string;
}

export function registerNCreateCommand(program: Command): void {
  program
    .command("create")
    .alias("init")
    .argument("<workflow_id_source>", "Workflow ID in the configured source instance")
    .argument("[project_root]", "Base directory where project folder will be created", ".")
    .option("--force", "Re-initialize project.json when it already exists")
    .option("--profile <name>", "Use a named profile from ~/.ndeploy/profiles.json")
    .description("Create project from source workflow and write project.json (deprecated alias: init)")
    .action(async (workflowIdSource: string, projectRoot: string, options: InitCommandOptions) => {
      const spinner = ora("Preparing project initialization").start();
      try {
        const { api } = await buildApiFromRuntime({ profile: options.profile });
        const result = await api.createProject({
          workflowIdSource,
          projectRoot,
          force: options.force === true,
          profileName: options.profile,
        });
        spinner.succeed("Project initialized");
        logger.success(`[NCREATE] Project initialized: ${result.projectPath}`);
        logger.info(`[NCREATE] root_workflow_id=${result.rootWorkflowIdSource}`);
        logger.info(`[NCREATE] root_workflow_name=${result.rootWorkflowName}`);
        logger.success(`[NCREATE] Metadata file: ${result.metadataPath}`);
      } catch (error) {
        if (spinner.isSpinning) spinner.fail("Project initialization failed");
        throw error;
      }
    });
}
