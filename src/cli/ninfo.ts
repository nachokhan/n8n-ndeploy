import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { buildApiFromRuntime } from "./apiFactory.js";
import { resolveProjectArg } from "../utils/project.js";

interface InfoCommandOptions {
  output?: string;
  profile?: string;
}

export function registerNInfoCommand(program: Command): void {
  program
    .command("info")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--profile <name>", "Override project profile for this run")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .description("Show project metadata and generated artifact status")
    .action(async (projectArg: string | undefined, options: InfoCommandOptions) => {
      const project = resolveProjectArg(projectArg);
      const { api } = await buildApiFromRuntime({ profile: options.profile });
      const output = await api.getProjectInfo({ projectPath: project, outputPath: options.output });
      if (options.output) logger.success(`[NINFO] Result JSON written to ${options.output}`);
      console.log(JSON.stringify(output, null, 2));
    });

  logger.debug("Command info registered");
}
