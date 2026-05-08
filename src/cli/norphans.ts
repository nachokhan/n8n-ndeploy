import ora from "ora";
import { Command } from "commander";
import { ValidationError } from "../errors/index.js";
import { readRequiredProjectMetadata } from "../utils/project.js";
import { logger } from "../utils/logger.js";
import { buildApiFromRuntime } from "./apiFactory.js";

interface OrphansCommandOptions {
  profile?: string;
  side?: string;
  workflows?: boolean;
  credentials?: boolean;
  dataTables?: boolean;
  datatables?: boolean;
  all?: boolean;
  output?: string;
}

export function registerNOrphansCommand(program: Command): void {
  program
    .command("orphans")
    .argument("[project]", "Project directory (defaults to current directory)")
    .description("List unreferenced workflows, credentials, and data tables")
    .option("--profile <name>", "Override project profile for this run")
    .requiredOption("--side <source|target>", "Choose which configured instance to analyze")
    .option("--workflows", "Include orphan workflows")
    .option("--credentials", "Include orphan credentials")
    .option("--data-tables", "Include orphan data tables")
    .option("--datatables", "Alias of --data-tables")
    .option("--all", "Include all entity types")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .action(async (projectArg: string | undefined, options: OrphansCommandOptions) => {
      const spinner = ora("Preparing orphan analysis").start();
      try {
        const { project, metadata } = await readRequiredProjectMetadata(projectArg);
        const side = parseSide(options.side);
        const { api, profileName } = await buildApiFromRuntime({ profile: options.profile, projectMetadata: metadata });
        const response = await api.findOrphans({
          projectPath: project,
          side,
          workflows: options.workflows,
          credentials: options.credentials,
          datatables: options.dataTables === true || options.datatables === true,
          all: options.all,
          outputPath: options.output,
        });
        spinner.succeed("Orphan analysis completed");
        if (profileName) logger.info(`[NORPHANS] profile=${profileName}`);
        console.log(JSON.stringify(response, null, 2));
      } catch (error) {
        if (spinner.isSpinning) spinner.fail("Orphan analysis failed");
        throw error;
      }
    });

  logger.debug("Command orphans registered");
}

function parseSide(value: string | undefined): "source" | "target" {
  if (value === "source" || value === "target") return value;
  throw new ValidationError("Option --side must be one of: source, target");
}
