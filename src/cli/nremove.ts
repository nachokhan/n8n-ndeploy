import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { loadEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../errors/index.js";

type TargetSelection =
  | {
      mode: "all";
    }
  | {
      mode: "ids";
      ids: string[];
    };

interface RemoveCommandOptions {
  workflows?: string;
  credentials?: string;
  dataTables?: string;
  datatables?: string;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export function registerNRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description("Remove workflows, credentials, and/or data tables from PROD")
    .option("--workflows <ids|all>", "Workflow IDs in PROD separated by commas, or 'all'")
    .option("--credentials <ids|all>", "Credential IDs in PROD separated by commas, or 'all'")
    .option("--data-tables <ids|all>", "Data table IDs in PROD separated by commas, or 'all'")
    .option("--datatables <ids|all>", "Alias of --data-tables")
    .option("--all", "Remove all workflows, credentials, and data tables")
    .option("--yes", "Skip interactive confirmation")
    .option("--dry-run", "Show what would be removed without executing")
    .action(async (options: RemoveCommandOptions) => {
      const spinner = ora("Preparing remove execution").start();
      try {
        const env = loadEnv();
        const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);

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
          throw new ValidationError(
            "Nothing selected to remove. Use at least one of --workflows, --credentials, --data-tables, or --all.",
          );
        }

        spinner.text = "Resolving remove targets";

        const workflowIds = await resolveIds(prodClient, "workflows", workflowsSelection);
        const credentialIds = await resolveIds(prodClient, "credentials", credentialsSelection);
        const dataTableIds = await resolveIds(prodClient, "data-tables", dataTablesSelection);

        const totalTargets = workflowIds.length + credentialIds.length + dataTableIds.length;
        if (totalTargets === 0) {
          spinner.succeed("No resources matched the selection");
          return;
        }

        spinner.succeed("Remove targets resolved");

        logger.warn("[NREMOVE] You are about to remove resources from PROD:");
        logger.warn(`[NREMOVE] workflows=${workflowIds.length} ids=${formatIdsForLog(workflowIds)}`);
        logger.warn(
          `[NREMOVE] credentials=${credentialIds.length} ids=${formatIdsForLog(credentialIds)}`,
        );
        logger.warn(`[NREMOVE] data_tables=${dataTableIds.length} ids=${formatIdsForLog(dataTableIds)}`);

        if (options.dryRun === true) {
          logger.info("[NREMOVE] Dry run enabled. No changes executed.");
          return;
        }

        if (options.yes !== true) {
          await requireYesConfirmation();
        } else {
          logger.warn("[NREMOVE] --yes detected: skipping interactive confirmation");
        }

        const execSpinner = ora(`Removing ${totalTargets} resources from PROD`).start();

        try {
          for (const id of workflowIds) {
            execSpinner.text = `Removing workflow ${id}`;
            await prodClient.deleteWorkflow(id);
            logger.success(`[NREMOVE] Removed workflow id=${id}`);
          }

          for (const id of credentialIds) {
            execSpinner.text = `Removing credential ${id}`;
            await prodClient.deleteCredential(id);
            logger.success(`[NREMOVE] Removed credential id=${id}`);
          }

          for (const id of dataTableIds) {
            execSpinner.text = `Removing data table ${id}`;
            await prodClient.deleteDataTable(id);
            logger.success(`[NREMOVE] Removed data table id=${id}`);
          }

          execSpinner.succeed(`Remove completed: removed ${totalTargets} resources`);
        } catch (error) {
          if (execSpinner.isSpinning) {
            execSpinner.fail("Remove failed during execution");
          }
          throw error;
        }
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("Remove failed");
        }
        throw error;
      }
    });

  logger.debug("Command remove registered");
}

function parseTargetSelection(raw: string | undefined, flagName: string): TargetSelection | null {
  if (raw === undefined) {
    return null;
  }

  const normalized = raw.trim();
  if (!normalized) {
    throw new ValidationError(`Option --${flagName} cannot be empty`);
  }

  if (normalized.toLowerCase() === "all") {
    return { mode: "all" };
  }

  const ids = [...new Set(normalized.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new ValidationError(
      `Option --${flagName} must be 'all' or a comma-separated list of IDs`,
    );
  }

  if (ids.some((id) => id.toLowerCase() === "all")) {
    throw new ValidationError(`Option --${flagName} cannot mix IDs with 'all'`);
  }

  return { mode: "ids", ids };
}

async function resolveIds(
  prodClient: N8nClient,
  target: "workflows" | "credentials" | "data-tables",
  selection: TargetSelection | null,
): Promise<string[]> {
  if (!selection) {
    return [];
  }

  if (selection.mode === "ids") {
    return selection.ids;
  }

  if (target === "workflows") {
    return prodClient.listWorkflowIds();
  }

  if (target === "credentials") {
    return prodClient.listCredentialIds();
  }

  return prodClient.listDataTableIds();
}

async function requireYesConfirmation(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new ValidationError(
      "Interactive confirmation requires a TTY. Re-run with --yes to force execution.",
    );
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

function formatIdsForLog(ids: string[]): string {
  if (ids.length === 0) {
    return "[]";
  }
  if (ids.length <= 10) {
    return `[${ids.join(",")}]`;
  }
  const preview = ids.slice(0, 10).join(",");
  return `[${preview},...(+${ids.length - 10} more)]`;
}
