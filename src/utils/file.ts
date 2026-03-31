import { promises as fs } from "fs";
import path from "path";

const PLAN_FILE_NAME = "plan.json";
const PLAN_SUMMARY_FILE_NAME = "plan_summary.json";
const DEPLOY_RESULT_FILE_NAME = "deploy_result.json";
const DEPLOY_SUMMARY_FILE_NAME = "deploy_summary.json";
const WORKSPACE_METADATA_FILE_NAME = "workspace.json";

export interface WorkspaceMetadata {
  schema_version: number;
  workspace: string;
  name: string;
  plan: {
    root_workflow_id_dev: string | null;
    root_workflow_name: string | null;
    updated_at: string | null;
  };
  created_at: string;
  updated_at: string;
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tempFilePath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tempFilePath, content, "utf8");
  await fs.rename(tempFilePath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function resolveWorkspaceDir(workspace: string): string {
  return path.resolve(process.cwd(), workspace);
}

export async function ensureWorkspaceDir(workspace: string): Promise<string> {
  const workspaceDir = resolveWorkspaceDir(workspace);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

export function resolveWorkspacePlanFilePath(workspace: string): string {
  return path.join(resolveWorkspaceDir(workspace), PLAN_FILE_NAME);
}

export function resolveWorkspacePlanSummaryFilePath(workspace: string): string {
  return path.join(resolveWorkspaceDir(workspace), PLAN_SUMMARY_FILE_NAME);
}

export function resolveWorkspaceDeployResultFilePath(workspace: string): string {
  return path.join(resolveWorkspaceDir(workspace), DEPLOY_RESULT_FILE_NAME);
}

export function resolveWorkspaceDeploySummaryFilePath(workspace: string): string {
  return path.join(resolveWorkspaceDir(workspace), DEPLOY_SUMMARY_FILE_NAME);
}

export function resolveWorkspaceMetadataFilePath(workspace: string): string {
  return path.join(resolveWorkspaceDir(workspace), WORKSPACE_METADATA_FILE_NAME);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function backupWorkspacePlanIfExists(workspace: string): Promise<string | null> {
  const planPath = resolveWorkspacePlanFilePath(workspace);
  try {
    await fs.access(planPath);
  } catch {
    return null;
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(resolveWorkspaceDir(workspace), `plan_backup_${stamp}.json`);
  await fs.rename(planPath, backupPath);
  return backupPath;
}
