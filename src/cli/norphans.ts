import ora from "ora";
import path from "path";
import { Command } from "commander";
import { N8nClient, WorkflowSummaryItem } from "../services/N8nClient.js";
import { loadEnv } from "../utils/env.js";
import {
  fileExists,
  resolveProjectDir,
  resolveProjectOrphansFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../errors/index.js";

type Side = "source" | "target";

interface OrphansCommandOptions {
  side?: string;
  workflows?: boolean;
  credentials?: boolean;
  dataTables?: boolean;
  datatables?: boolean;
  all?: boolean;
  output?: string;
}

interface OrphansOutput {
  workflows?: Array<{ id: string; name: string; url: string }>;
  credentials?: Array<{ id: string; name: string; type: string }>;
  datatables?: Array<{ id: string; name: string }>;
}

export function registerNOrphansCommand(program: Command): void {
  program
    .command("orphans")
    .argument("<project>", "Project directory")
    .description("List unreferenced workflows, credentials, and data tables")
    .requiredOption("--side <source|target>", "Choose which configured instance to analyze")
    .option("--workflows", "Include orphan workflows")
    .option("--credentials", "Include orphan credentials")
    .option("--data-tables", "Include orphan data tables")
    .option("--datatables", "Alias of --data-tables")
    .option("--all", "Include all entity types")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .action(async (project: string, options: OrphansCommandOptions) => {
      const spinner = ora("Preparing orphan analysis").start();
      try {
        const projectDir = resolveProjectDir(project);
        const projectExists = await fileExists(projectDir);
        if (!projectExists) {
          throw new ValidationError(`Project "${project}" does not exist at ${projectDir}`);
        }

        const env = loadEnv();
        const side = parseSide(options.side);
        const selected = resolveEntitySelection(options);

        const client =
          side === "source"
            ? new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY)
            : new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);

        const instanceUrl = side === "source" ? env.N8N_DEV_URL : env.N8N_PROD_URL;
        logger.info(`[NORPHANS] project=${project} side=${side} instance=${instanceUrl}`);

        spinner.text = "Loading workflows and computing references";
        const workflowSummaries = await client.listWorkflowsSummary();
        const nonArchivedWorkflows = workflowSummaries.filter((workflow) => !workflow.archived);
        const workflowDetails = await Promise.all(
          nonArchivedWorkflows.map((workflow) => client.getWorkflowById(workflow.id)),
        );

        const referencedWorkflowIds = new Set<string>();
        const referencedCredentialIds = new Set<string>();
        const referencedDataTableIds = new Set<string>();

        for (const workflow of workflowDetails) {
          for (const node of workflow.nodes) {
            if (node.credentials) {
              for (const credential of Object.values(node.credentials)) {
                const credentialId = extractReferenceId(credential?.id);
                if (credentialId) {
                  referencedCredentialIds.add(credentialId);
                }
              }
            }

            if (node.type === "n8n-nodes-base.executeWorkflow") {
              const subWorkflowId = extractReferenceId(node.parameters?.workflowId);
              if (subWorkflowId && subWorkflowId !== workflow.id) {
                referencedWorkflowIds.add(subWorkflowId);
              }
            }

            if (node.type === "n8n-nodes-base.dataTable") {
              const dataTableId = extractReferenceId(
                node.parameters?.dataTableId ?? node.parameters?.tableId,
              );
              if (dataTableId) {
                referencedDataTableIds.add(dataTableId);
              }
            }
          }

          const settingsRecord =
            workflow.settings &&
            typeof workflow.settings === "object" &&
            !Array.isArray(workflow.settings)
              ? (workflow.settings as Record<string, unknown>)
              : null;
          const errorWorkflowId = extractReferenceId(settingsRecord?.errorWorkflow);
          if (errorWorkflowId && errorWorkflowId !== workflow.id) {
            referencedWorkflowIds.add(errorWorkflowId);
          }
        }

        spinner.text = "Loading credentials and data tables";
        const [credentialSummaries, dataTableSummaries] = await Promise.all([
          client.listCredentialsSummary(),
          client.listDataTablesSummary(),
        ]);

        const response: OrphansOutput = {};

        if (selected.workflows) {
          response.workflows = computeOrphanWorkflows(
            nonArchivedWorkflows,
            referencedWorkflowIds,
            instanceUrl,
          );
        }

        if (selected.credentials) {
          response.credentials = credentialSummaries
            .filter((credential) => !referencedCredentialIds.has(credential.id))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        if (selected.datatables) {
          response.datatables = dataTableSummaries
            .filter((table) => !referencedDataTableIds.has(table.id))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        spinner.succeed("Orphan analysis completed");
        const outputPath = resolveOutputPath(options.output, project, side);
        await writeResultFile(outputPath, response, "NORPHANS");
        console.log(JSON.stringify(response, null, 2));
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("Orphan analysis failed");
        }
        throw error;
      }
    });

  logger.debug("Command orphans registered");
}

async function writeResultFile(
  outputPath: string,
  data: unknown,
  prefix: string,
): Promise<void> {
  await writeJsonFile(outputPath, data);
  logger.success(`[${prefix}] Result JSON written to ${outputPath}`);
}

function resolveOutputPath(
  outputPath: string | undefined,
  project: string,
  side: Side,
): string {
  if (outputPath) {
    return path.resolve(process.cwd(), outputPath);
  }
  return resolveProjectOrphansFilePath(project, side);
}

function parseSide(value: string | undefined): Side {
  if (value === "source" || value === "target") {
    return value;
  }
  throw new ValidationError("Option --side must be one of: source, target");
}

function resolveEntitySelection(options: OrphansCommandOptions): {
  workflows: boolean;
  credentials: boolean;
  datatables: boolean;
} {
  const explicitSelection =
    options.workflows === true ||
    options.credentials === true ||
    options.dataTables === true ||
    options.datatables === true ||
    options.all === true;

  if (!explicitSelection) {
    return {
      workflows: true,
      credentials: true,
      datatables: true,
    };
  }

  if (options.all === true) {
    return {
      workflows: true,
      credentials: true,
      datatables: true,
    };
  }

  return {
    workflows: options.workflows === true,
    credentials: options.credentials === true,
    datatables: options.dataTables === true || options.datatables === true,
  };
}

function computeOrphanWorkflows(
  workflows: WorkflowSummaryItem[],
  referencedWorkflowIds: Set<string>,
  instanceUrl: string,
): Array<{ id: string; name: string; url: string }> {
  return workflows
    .filter((workflow) => !referencedWorkflowIds.has(workflow.id))
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      url: buildWorkflowUrl(instanceUrl, workflow.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractReferenceId(reference: unknown): string | null {
  if (typeof reference === "string" || typeof reference === "number") {
    return String(reference);
  }

  if (!reference || typeof reference !== "object") {
    return null;
  }

  const record = reference as Record<string, unknown>;
  const directValue = record.value;
  if (typeof directValue === "string" || typeof directValue === "number") {
    return String(directValue);
  }

  const directId = record.id;
  if (typeof directId === "string" || typeof directId === "number") {
    return String(directId);
  }

  return null;
}

function buildWorkflowUrl(instanceUrl: string, workflowId: string): string {
  const base = instanceUrl.endsWith("/") ? instanceUrl.slice(0, -1) : instanceUrl;
  return `${base}/workflow/${encodeURIComponent(workflowId)}`;
}
