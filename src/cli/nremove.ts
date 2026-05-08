import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../errors/index.js";
import { buildApiFromRuntime } from "./apiFactory.js";
import { resolveRuntimeConfig } from "../utils/runtime.js";

type TargetSelection = { mode: "all" } | { mode: "ids"; ids: string[] };

interface RemoveCommandOptions {
  profile?: string;
  workflows?: string;
  archivedWorkflows?: boolean;
  credentials?: string;
  dataTables?: string;
  datatables?: string;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  output?: string;
}

export function registerNRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description("Remove workflows, credentials, and/or data tables from the configured target instance")
    .option("--profile <name>", "Use a named profile from ~/.ndeploy/profiles.json")
    .option("--workflows <ids|all>", "Workflow IDs in target separated by commas, or 'all'")
    .option("--archived-workflows", "Remove only archived workflows")
    .option("--credentials <ids|all>", "Credential IDs in target separated by commas, or 'all'")
    .option("--data-tables <ids|all>", "Data table IDs in target separated by commas, or 'all'")
    .option("--datatables <ids|all>", "Alias of --data-tables")
    .option("--all", "Remove all workflows, credentials, and data tables")
    .option("--yes", "Skip interactive confirmation")
    .option("--dry-run", "Show what would be removed without executing")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .action(async (options: RemoveCommandOptions) => {
      const spinner = ora("Preparing remove execution").start();
      try {
        const { api } = await buildApiFromRuntime({ profile: options.profile });
        let workflowsSelection = parseTargetSelection(options.workflows, "workflows");
        let credentialsSelection = parseTargetSelection(options.credentials, "credentials");
        const dataTableRaw = options.dataTables ?? options.datatables;
        let dataTablesSelection = parseTargetSelection(dataTableRaw, "data-tables");

        if (options.all === true) {
          workflowsSelection = workflowsSelection ?? { mode: "all" };
          credentialsSelection = credentialsSelection ?? { mode: "all" };
          dataTablesSelection = dataTablesSelection ?? { mode: "all" };
        }

        if (!workflowsSelection && !credentialsSelection && !dataTablesSelection) {
          throw new ValidationError("Nothing selected to remove. Use --workflows/--credentials/--data-tables/--all.");
        }

        if (options.archivedWorkflows === true) {
          const runtime = await resolveRuntimeConfig({ profile: options.profile });
          const targetClient = new N8nClient(runtime.target.url, runtime.target.apiKey);
          const archivedIds = (await targetClient.listWorkflowsSummary()).filter((w) => w.archived).map((w) => w.id);
          workflowsSelection = { mode: "ids", ids: archivedIds };
        }

        const workflowIds = toIds(workflowsSelection);
        const credentialIds = toIds(credentialsSelection);
        const datatableIds = toIds(dataTablesSelection);

        const totalTargets = workflowIds.length + credentialIds.length + datatableIds.length;
        if (totalTargets === 0) {
          spinner.succeed("No resources matched the selection");
          return;
        }

        spinner.succeed("Remove targets resolved");

        if (!options.yes && options.dryRun !== true) {
          await requireYesConfirmation();
        }

        const result = await api.removeResources({
          workflows: workflowsSelection?.mode === "all" ? "all" : workflowIds,
          credentials: credentialsSelection?.mode === "all" ? "all" : credentialIds,
          datatables: dataTablesSelection?.mode === "all" ? "all" : datatableIds,
          dryRun: options.dryRun === true,
          confirm: options.yes === true || options.dryRun === true,
          outputPath: options.output,
        });

        logger.success("[NREMOVE] Remove completed");
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        if (spinner.isSpinning) spinner.fail("Remove failed");
        throw error;
      }
    });

  logger.debug("Command remove registered");
}

function parseTargetSelection(raw: string | undefined, flagName: string): TargetSelection | null {
  if (raw === undefined) return null;
  const normalized = raw.trim();
  if (!normalized) throw new ValidationError(`Option --${flagName} cannot be empty`);
  if (normalized.toLowerCase() === "all") return { mode: "all" };
  const ids = [...new Set(normalized.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ValidationError(`Option --${flagName} must be 'all' or comma-separated IDs`);
  return { mode: "ids", ids };
}

function toIds(selection: TargetSelection | null): string[] {
  if (!selection || selection.mode === "all") return [];
  return selection.ids;
}

async function requireYesConfirmation(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new ValidationError("Interactive confirmation requires a TTY. Re-run with --yes.");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Type 'yes' to confirm deletion: ");
    if (answer.trim() !== "yes") {
      throw new ValidationError("Remove cancelled. Confirmation requires typing exactly 'yes'.");
    }
  } finally {
    rl.close();
  }
}
