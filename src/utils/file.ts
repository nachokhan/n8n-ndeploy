import { promises as fs } from "fs";
import path from "path";

const PLAN_FILE_NAME = "plan.json";

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
