import ora from "ora";
import path from "path";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { loadEnv } from "../utils/env.js";
import {
  fileExists,
  resolveWorkspaceDanglingFilePath,
  resolveWorkspaceDir,
  writeJsonFile,
} from "../utils/file.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../errors/index.js";

type Side = "source" | "target";

interface DanglingCommandOptions {
  side?: string;
  workflows?: boolean;
  credentials?: boolean;
  dataTables?: boolean;
  datatables?: boolean;
  all?: boolean;
  output?: string;
}

interface EntitySelection {
  workflows: boolean;
  credentials: boolean;
  datatables: boolean;
}

interface DanglingReferenceItem {
  node_name: string;
  node_type: string;
  field: string;
  missing_id: string;
}

interface WorkflowDanglingRefs {
  workflow: {
    id: string;
    name: string;
    url: string;
  };
  dangling_references: {
    workflows?: DanglingReferenceItem[];
    credentials?: DanglingReferenceItem[];
    datatables?: DanglingReferenceItem[];
  };
}

interface DanglingOutput {
  summary: {
    side: Side;
    instance: string;
    scanned_workflows: number;
    workflows_with_issues: number;
    dangling_references_total: number;
  };
  workflows: WorkflowDanglingRefs[];
}

export function registerNDanglingRefsCommand(program: Command): void {
  program
    .command("dangling-refs")
    .alias("dangling")
    .argument("<workspace>", "Workspace directory")
    .description("List workflows containing references to entities that no longer exist")
    .requiredOption("--side <source|target>", "Choose which configured instance to analyze")
    .option("--workflows", "Check workflow references")
    .option("--credentials", "Check credential references")
    .option("--data-tables", "Check data table references")
    .option("--datatables", "Alias of --data-tables")
    .option("--all", "Check all reference types")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .action(async (workspace: string, options: DanglingCommandOptions) => {
      const spinner = ora("Preparing dangling reference analysis").start();
      try {
        const workspaceDir = resolveWorkspaceDir(workspace);
        const workspaceExists = await fileExists(workspaceDir);
        if (!workspaceExists) {
          throw new ValidationError(`Workspace "${workspace}" does not exist at ${workspaceDir}`);
        }

        const env = loadEnv();
        const side = parseSide(options.side);
        const selected = resolveEntitySelection(options);

        const client =
          side === "source"
            ? new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY)
            : new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);

        const instanceUrl = side === "source" ? env.N8N_DEV_URL : env.N8N_PROD_URL;
        logger.info(`[NDANGLING] workspace=${workspace} side=${side} instance=${instanceUrl}`);

        spinner.text = "Loading entity inventories";
        const [workflowSummaries, credentialSummaries, dataTableSummaries] = await Promise.all([
          client.listWorkflowsSummary(),
          client.listCredentialsSummary(),
          client.listDataTablesSummary(),
        ]);

        const nonArchivedWorkflows = workflowSummaries.filter((workflow) => !workflow.archived);
        const existingWorkflowIds = new Set(nonArchivedWorkflows.map((workflow) => workflow.id));
        const existingCredentialIds = new Set(credentialSummaries.map((credential) => credential.id));
        const existingDataTableIds = new Set(dataTableSummaries.map((table) => table.id));

        spinner.text = "Analyzing workflow references";
        const workflowDetails = await Promise.all(
          nonArchivedWorkflows.map((workflow) => client.getWorkflowById(workflow.id)),
        );

        const result: WorkflowDanglingRefs[] = [];
        let totalDangling = 0;

        for (const workflow of workflowDetails) {
          const missingWorkflows: DanglingReferenceItem[] = [];
          const missingCredentials: DanglingReferenceItem[] = [];
          const missingDataTables: DanglingReferenceItem[] = [];

          for (const node of workflow.nodes) {
            if (selected.workflows && node.type === "n8n-nodes-base.executeWorkflow") {
              const subWorkflowId = extractReferenceId(node.parameters?.workflowId);
              if (subWorkflowId && !existingWorkflowIds.has(subWorkflowId)) {
                missingWorkflows.push({
                  node_name: node.name,
                  node_type: node.type,
                  field: "parameters.workflowId",
                  missing_id: subWorkflowId,
                });
              }
            }

            if (selected.credentials && node.credentials) {
              for (const [credentialKey, credentialValue] of Object.entries(node.credentials)) {
                const credentialId = extractReferenceId(credentialValue?.id);
                if (credentialId && !existingCredentialIds.has(credentialId)) {
                  missingCredentials.push({
                    node_name: node.name,
                    node_type: node.type,
                    field: `credentials.${credentialKey}.id`,
                    missing_id: credentialId,
                  });
                }
              }
            }

            if (selected.datatables && node.type === "n8n-nodes-base.dataTable") {
              const dataTableId = extractReferenceId(
                node.parameters?.dataTableId ?? node.parameters?.tableId,
              );
              if (dataTableId && !existingDataTableIds.has(dataTableId)) {
                const fieldName = node.parameters?.dataTableId !== undefined
                  ? "parameters.dataTableId"
                  : "parameters.tableId";
                missingDataTables.push({
                  node_name: node.name,
                  node_type: node.type,
                  field: fieldName,
                  missing_id: dataTableId,
                });
              }
            }
          }

          if (selected.workflows) {
            const settingsRecord =
              workflow.settings &&
              typeof workflow.settings === "object" &&
              !Array.isArray(workflow.settings)
                ? (workflow.settings as Record<string, unknown>)
                : null;
            const errorWorkflowId = extractReferenceId(settingsRecord?.errorWorkflow);
            if (errorWorkflowId && !existingWorkflowIds.has(errorWorkflowId)) {
              missingWorkflows.push({
                node_name: "[workflow-settings]",
                node_type: "workflow.settings",
                field: "settings.errorWorkflow",
                missing_id: errorWorkflowId,
              });
            }
          }

          const workflowIssueCount =
            missingWorkflows.length + missingCredentials.length + missingDataTables.length;
          if (workflowIssueCount === 0) {
            continue;
          }

          totalDangling += workflowIssueCount;

          const danglingReferences: WorkflowDanglingRefs["dangling_references"] = {};
          if (selected.workflows) {
            danglingReferences.workflows = missingWorkflows;
          }
          if (selected.credentials) {
            danglingReferences.credentials = missingCredentials;
          }
          if (selected.datatables) {
            danglingReferences.datatables = missingDataTables;
          }

          result.push({
            workflow: {
              id: workflow.id,
              name: workflow.name,
              url: buildWorkflowUrl(instanceUrl, workflow.id),
            },
            dangling_references: danglingReferences,
          });
        }

        result.sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));

        const response: DanglingOutput = {
          summary: {
            side,
            instance: instanceUrl,
            scanned_workflows: nonArchivedWorkflows.length,
            workflows_with_issues: result.length,
            dangling_references_total: totalDangling,
          },
          workflows: result,
        };

        spinner.succeed("Dangling reference analysis completed");
        const outputPath = resolveOutputPath(options.output, workspace, side);
        await writeResultFile(outputPath, response, "NDANGLING");
        console.log(JSON.stringify(response, null, 2));
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("Dangling reference analysis failed");
        }
        throw error;
      }
    });

  logger.debug("Command dangling-refs registered");
}

async function writeResultFile(
  outputPath: string,
  data: unknown,
  prefix: string,
): Promise<void> {
  await writeJsonFile(outputPath, data);
  logger.info(`[${prefix}] Result JSON written to ${outputPath}`);
}

function resolveOutputPath(
  outputPath: string | undefined,
  workspace: string,
  side: Side,
): string {
  if (outputPath) {
    return path.resolve(process.cwd(), outputPath);
  }
  return resolveWorkspaceDanglingFilePath(workspace, side);
}

function parseSide(value: string | undefined): Side {
  if (value === "source" || value === "target") {
    return value;
  }
  throw new ValidationError("Option --side must be one of: source, target");
}

function resolveEntitySelection(options: DanglingCommandOptions): EntitySelection {
  const explicitSelection =
    options.workflows === true ||
    options.credentials === true ||
    options.dataTables === true ||
    options.datatables === true ||
    options.all === true;

  if (!explicitSelection || options.all === true) {
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
