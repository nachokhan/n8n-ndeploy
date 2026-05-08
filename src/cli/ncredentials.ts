import path from "path";
import { Command } from "commander";
import { ValidationError } from "../errors/index.js";
import { logger } from "../utils/logger.js";
import { ensureProjectExists, readRequiredProjectMetadata } from "../utils/project.js";
import { buildApiFromRuntime } from "./apiFactory.js";

interface CredentialsFetchOptions { side?: string; profile?: string; }
interface CredentialsMergeMissingOptions { side?: string; profile?: string; }
interface CredentialsCompareOptions { format?: string; strict?: boolean; profile?: string; }
interface CredentialsValidateOptions { output?: string; strict?: boolean; side?: string; profile?: string; }

type MergeSide = "source" | "target" | "both";
type ValidateSide = "source" | "target" | "manifest" | "all";

export function registerNCredentialsCommand(program: Command): void {
  const credentials = new Command("credentials");
  credentials.description("Credential snapshot and manifest commands");

  credentials
    .command("fetch")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--side <source|target|both>", "Choose which snapshot files to generate", "both")
    .option("--profile <name>", "Override project profile for this run")
    .description("Fetch source/target credential snapshots for the project dependency graph")
    .action(async (projectArg: string | undefined, options: CredentialsFetchOptions) => {
      const { project, metadata } = await readRequiredProjectMetadata(projectArg);
      const { api } = await buildApiFromRuntime({ profile: options.profile, projectMetadata: metadata });
      const side = parseMergeSide(options.side);
      const result = await api.fetchCredentials({ projectPath: project, side });
      if (result.sourcePath) logger.success(`[NCREDENTIALS] Source snapshot written: ${result.sourcePath}`);
      if (result.targetPath) logger.success(`[NCREDENTIALS] Target snapshot written: ${result.targetPath}`);
    });

  credentials
    .command("merge-missing")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--side <source|target|both>", "Choose which snapshots to merge from", "both")
    .option("--profile <name>", "Override project profile for this run")
    .description("Add only missing credentials to credentials_manifest.json from fetched snapshots")
    .action(async (projectArg: string | undefined, options: CredentialsMergeMissingOptions) => {
      const { project, metadata } = await readRequiredProjectMetadata(projectArg);
      const { api } = await buildApiFromRuntime({ profile: options.profile, projectMetadata: metadata });
      const mergeSide = parseMergeSide(options.side);
      const result = await api.mergeMissingCredentials({ projectPath: project, side: mergeSide });
      logger.success(`[NCREDENTIALS] Manifest written: ${result.manifestPath}`);
      logger.success(`[NCREDENTIALS] added=${result.added} skipped_existing=${result.skippedExisting}`);
    });

  credentials
    .command("compare")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--format <json|table>", "Choose output format", "json")
    .option("--strict", "Exit with error if differences are found")
    .option("--profile <name>", "Override project profile for this run")
    .description("Compare credentials_source.json and credentials_target.json")
    .action(async (projectArg: string | undefined, options: CredentialsCompareOptions) => {
      const project = await ensureProjectExists(projectArg);
      const { api } = await buildApiFromRuntime({ profile: options.profile });
      const result = await api.compareCredentials({ projectPath: project, strict: options.strict === true });

      if (options.format === "table") {
        for (const item of result.credentials) {
          const extra = item.differing_fields.length > 0 ? ` fields=${item.differing_fields.map((field) => field.field).join(",")}` : "";
          console.log(`${item.status}\t${item.source_id}\t${item.name}${extra}`);
        }
      } else {
        console.log(JSON.stringify({ project, ...result }, null, 2));
      }
    });

  credentials
    .command("validate")
    .argument("[project]", "Project directory (defaults to current directory)")
    .option("--side <source|target|manifest|all>", "Choose which credential artifact to validate", "manifest")
    .option("-o, --output <file_path>", "Write JSON report to file")
    .option("--strict", "Exit with error if missing required fields are found")
    .option("--profile <name>", "Override project profile for this run")
    .description("Validate source/target snapshots or the editable credentials manifest")
    .action(async (projectArg: string | undefined, options: CredentialsValidateOptions) => {
      const project = await ensureProjectExists(projectArg);
      const { api } = await buildApiFromRuntime({ profile: options.profile });
      const side = parseValidateSide(options.side);
      const outputPath = options.output ? path.resolve(process.cwd(), options.output) : undefined;
      const result = await api.validateCredentials({ projectPath: project, side, strict: options.strict === true, outputPath });
      if (outputPath) logger.success(`[NCREDENTIALS] Validation report written to ${outputPath}`);
      console.log(JSON.stringify(result, null, 2));
    });

  program.addCommand(credentials);
  logger.debug("Command credentials registered");
}

function parseMergeSide(value: string | undefined): MergeSide {
  if (!value || value === "both") return "both";
  if (value === "source" || value === "target") return value;
  throw new ValidationError("Option --side must be one of: source, target, both");
}

function parseValidateSide(value: string | undefined): ValidateSide {
  if (!value || value === "manifest") return "manifest";
  if (value === "source" || value === "target" || value === "manifest" || value === "all") return value;
  throw new ValidationError("Option --side must be one of: source, target, manifest, all");
}
