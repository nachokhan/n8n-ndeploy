import { promises as fs } from "fs";
import path from "path";

const PLAN_FILE_NAME = "plan.json";
const PLAN_SUMMARY_FILE_NAME = "plan_summary.json";
const PRODUCTION_CREDENTIALS_FILE_NAME = "production_credentials.json";
const DEPLOY_RESULT_FILE_NAME = "deploy_result.json";
const DEPLOY_SUMMARY_FILE_NAME = "deploy_summary.json";
const REPORTS_DIR_NAME = "reports";
const PROJECT_METADATA_FILE_NAME = "project.json";

export interface ProjectMetadata {
  schema_version: number;
  project: string;
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

export function resolveProjectDir(project: string): string {
  return path.resolve(process.cwd(), project);
}

export async function ensureProjectDir(project: string): Promise<string> {
  const projectDir = resolveProjectDir(project);
  await fs.mkdir(projectDir, { recursive: true });
  return projectDir;
}

export function resolveProjectPlanFilePath(project: string): string {
  return path.join(resolveProjectDir(project), PLAN_FILE_NAME);
}

export function resolveProjectReportsDir(project: string): string {
  return path.join(resolveProjectDir(project), REPORTS_DIR_NAME);
}

export function resolveProjectPlanSummaryFilePath(project: string): string {
  return path.join(resolveProjectReportsDir(project), PLAN_SUMMARY_FILE_NAME);
}

export function resolveProjectProductionCredentialsFilePath(project: string): string {
  return path.join(resolveProjectDir(project), PRODUCTION_CREDENTIALS_FILE_NAME);
}

export function resolveProjectDeployResultFilePath(project: string): string {
  return path.join(resolveProjectReportsDir(project), DEPLOY_RESULT_FILE_NAME);
}

export function resolveProjectDeploySummaryFilePath(project: string): string {
  return path.join(resolveProjectReportsDir(project), DEPLOY_SUMMARY_FILE_NAME);
}

export function resolveProjectOrphansFilePath(project: string, side: "source" | "target"): string {
  return path.join(resolveProjectReportsDir(project), `orphans_${side}.json`);
}

export function resolveProjectDanglingFilePath(project: string, side: "source" | "target"): string {
  return path.join(resolveProjectReportsDir(project), `dangling_${side}.json`);
}

export function resolveProjectMetadataFilePath(project: string): string {
  return path.join(resolveProjectDir(project), PROJECT_METADATA_FILE_NAME);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function backupProjectPlanIfExists(project: string): Promise<string | null> {
  const planPath = resolveProjectPlanFilePath(project);
  try {
    await fs.access(planPath);
  } catch {
    return null;
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(resolveProjectDir(project), `plan_backup_${stamp}.json`);
  await fs.rename(planPath, backupPath);
  return backupPath;
}
