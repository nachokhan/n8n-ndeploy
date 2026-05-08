import ora from "ora";
import { Command } from "commander";
import { ValidationError } from "../errors/index.js";
import { readRequiredProjectMetadata } from "../utils/project.js";
import { logger } from "../utils/logger.js";
import { buildApiFromRuntime } from "./apiFactory.js";

interface DanglingCommandOptions {
  profile?: string;
  side?: string;
  workflows?: boolean;
  credentials?: boolean;
  dataTables?: boolean;
  datatables?: boolean;
  all?: boolean;
  output?: string;
}

export function registerNDanglingRefsCommand(program: Command): void {
  program
    .command("dangling-refs")
    .alias("dangling")
    .argument("[project]", "Project directory (defaults to current directory)")
    .description("List workflows containing references to entities that no longer exist")
    .option("--profile <name>", "Override project profile for this run")
    .requiredOption("--side <source|target>", "Choose which configured instance to analyze")
    .option("--workflows", "Check workflow references")
    .option("--credentials", "Check credential references")
    .option("--data-tables", "Check data table references")
    .option("--datatables", "Alias of --data-tables")
    .option("--all", "Check all reference types")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .action(async (projectArg: string | undefined, options: DanglingCommandOptions) => {
      const spinner = ora("Preparing dangling reference analysis").start();
      try {
        const { project, metadata } = await readRequiredProjectMetadata(projectArg);
        const side = parseSide(options.side);
        const { api, profileName } = await buildApiFromRuntime({ profile: options.profile, projectMetadata: metadata });
        const response = await api.findDanglingReferences({
          projectPath: project,
          side,
          workflows: options.workflows,
          credentials: options.credentials,
          datatables: options.dataTables === true || options.datatables === true,
          all: options.all,
          outputPath: options.output,
        });
        spinner.succeed("Dangling reference analysis completed");
        if (profileName) logger.info(`[NDANGLING] profile=${profileName}`);
        console.log(JSON.stringify(response, null, 2));
      } catch (error) {
        if (spinner.isSpinning) spinner.fail("Dangling reference analysis failed");
        throw error;
      }
    });

  logger.debug("Command dangling-refs registered");
}

function parseSide(value: string | undefined): "source" | "target" {
  if (value === "source" || value === "target") return value;
  throw new ValidationError("Option --side must be one of: source, target");
}
