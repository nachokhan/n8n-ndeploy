import path from "path";
import { Command } from "commander";
import {
  fileExists,
  readJsonFile,
  resolveWorkspaceDeployResultFilePath,
  resolveWorkspaceDeploySummaryFilePath,
  resolveWorkspaceDir,
  resolveWorkspaceMetadataFilePath,
  resolveWorkspacePlanFilePath,
  resolveWorkspacePlanSummaryFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { ValidationError } from "../errors/index.js";
import { logger } from "../utils/logger.js";

interface InfoCommandOptions {
  output?: string;
}

interface WorkspaceInfoOutput {
  workspace: string;
  workspace_path: string;
  metadata: {
    exists: boolean;
    path: string;
    schema_version: number | null;
    name: string | null;
    created_at: string | null;
    updated_at: string | null;
    plan: {
      root_workflow_id_dev: string | null;
      root_workflow_name: string | null;
      updated_at: string | null;
    };
  };
  artifacts: {
    plan: {
      exists: boolean;
      path: string;
      actions: number | null;
      plan_id: string | null;
      generated_at: string | null;
    };
    plan_summary: {
      exists: boolean;
      path: string;
      actions: number | null;
      plan_id: string | null;
      generated_at: string | null;
    };
    deploy_result: {
      exists: boolean;
      path: string;
      run_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      executed: number | null;
      skipped: number | null;
      failed: number | null;
    };
    deploy_summary: {
      exists: boolean;
      path: string;
      run_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      executed: number | null;
      skipped: number | null;
      failed: number | null;
    };
  };
}

export function registerNInfoCommand(program: Command): void {
  program
    .command("info")
    .argument("<workspace>", "Workspace directory")
    .option("-o, --output <file_path>", "Write JSON result to file")
    .description("Show workspace metadata and generated artifact status")
    .action(async (workspace: string, options: InfoCommandOptions) => {
      const workspacePath = resolveWorkspaceDir(workspace);
      const workspaceExists = await fileExists(workspacePath);
      if (!workspaceExists) {
        throw new ValidationError(
          `Workspace "${workspace}" does not exist at ${workspacePath}. Run: ndeploy create <workflow_id_dev> [workspace_root]`,
        );
      }

      const metadataPath = resolveWorkspaceMetadataFilePath(workspace);
      const planPath = resolveWorkspacePlanFilePath(workspace);
      const planSummaryPath = resolveWorkspacePlanSummaryFilePath(workspace);
      const deployResultPath = resolveWorkspaceDeployResultFilePath(workspace);
      const deploySummaryPath = resolveWorkspaceDeploySummaryFilePath(workspace);

      const metadataExists = await fileExists(metadataPath);
      const planExists = await fileExists(planPath);
      const planSummaryExists = await fileExists(planSummaryPath);
      const deployResultExists = await fileExists(deployResultPath);
      const deploySummaryExists = await fileExists(deploySummaryPath);

      const metadata = metadataExists
        ? await readJsonFile<Record<string, unknown>>(metadataPath)
        : null;
      const plan = planExists ? await readJsonFile<Record<string, unknown>>(planPath) : null;
      const planSummary = planSummaryExists
        ? await readJsonFile<Record<string, unknown>>(planSummaryPath)
        : null;
      const deployResult = deployResultExists
        ? await readJsonFile<Record<string, unknown>>(deployResultPath)
        : null;
      const deploySummary = deploySummaryExists
        ? await readJsonFile<Record<string, unknown>>(deploySummaryPath)
        : null;

      const output: WorkspaceInfoOutput = {
        workspace,
        workspace_path: workspacePath,
        metadata: {
          exists: metadataExists,
          path: metadataPath,
          schema_version: getNumber(metadata, "schema_version"),
          name: getString(metadata, "name"),
          created_at: getString(metadata, "created_at"),
          updated_at: getString(metadata, "updated_at"),
          plan: {
            root_workflow_id_dev: getNestedString(metadata, ["plan", "root_workflow_id_dev"]),
            root_workflow_name: getNestedString(metadata, ["plan", "root_workflow_name"]),
            updated_at: getNestedString(metadata, ["plan", "updated_at"]),
          },
        },
        artifacts: {
          plan: {
            exists: planExists,
            path: planPath,
            actions: getArrayLength(plan, "actions"),
            plan_id: getNestedString(plan, ["metadata", "plan_id"]),
            generated_at: getNestedString(plan, ["metadata", "generated_at"]),
          },
          plan_summary: {
            exists: planSummaryExists,
            path: planSummaryPath,
            actions: getNestedNumber(planSummary, ["totals", "actions"]),
            plan_id: getNestedString(planSummary, ["metadata", "plan_id"]),
            generated_at: getNestedString(planSummary, ["metadata", "generated_at"]),
          },
          deploy_result: {
            exists: deployResultExists,
            path: deployResultPath,
            run_id: getNestedString(deployResult, ["metadata", "run_id"]),
            started_at: getNestedString(deployResult, ["metadata", "started_at"]),
            finished_at: getNestedString(deployResult, ["metadata", "finished_at"]),
            executed: getNestedNumber(deployResult, ["totals", "executed"]),
            skipped: getNestedNumber(deployResult, ["totals", "skipped"]),
            failed: getNestedNumber(deployResult, ["totals", "failed"]),
          },
          deploy_summary: {
            exists: deploySummaryExists,
            path: deploySummaryPath,
            run_id: getNestedString(deploySummary, ["metadata", "run_id"]),
            started_at: getNestedString(deploySummary, ["metadata", "started_at"]),
            finished_at: getNestedString(deploySummary, ["metadata", "finished_at"]),
            executed: getNestedNumber(deploySummary, ["totals", "executed"]),
            skipped: getNestedNumber(deploySummary, ["totals", "skipped"]),
            failed: getNestedNumber(deploySummary, ["totals", "failed"]),
          },
        },
      };

      if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        await writeJsonFile(outputPath, output);
        logger.info(`[NINFO] Result JSON written to ${outputPath}`);
      }

      console.log(JSON.stringify(output, null, 2));
    });

  logger.debug("Command info registered");
}

function getArrayLength(data: Record<string, unknown> | null, key: string): number | null {
  if (!data) {
    return null;
  }
  const value = data[key];
  return Array.isArray(value) ? value.length : null;
}

function getNumber(data: Record<string, unknown> | null, key: string): number | null {
  if (!data) {
    return null;
  }
  const value = data[key];
  return typeof value === "number" ? value : null;
}

function getString(data: Record<string, unknown> | null, key: string): string | null {
  if (!data) {
    return null;
  }
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function getNestedString(data: Record<string, unknown> | null, keys: string[]): string | null {
  const value = getNestedValue(data, keys);
  return typeof value === "string" ? value : null;
}

function getNestedNumber(data: Record<string, unknown> | null, keys: string[]): number | null {
  const value = getNestedValue(data, keys);
  return typeof value === "number" ? value : null;
}

function getNestedValue(data: Record<string, unknown> | null, keys: string[]): unknown {
  let cursor: unknown = data;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}
