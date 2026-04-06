import path from "path";
import ora from "ora";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { ValidationError } from "../errors/index.js";
import { loadEnv } from "../utils/env.js";
import {
  ProjectMetadata,
  ensureProjectDir,
  fileExists,
  readJsonFile,
  resolveProjectMetadataFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { logger } from "../utils/logger.js";

interface CreateCommandOptions {
  force?: boolean;
}

export function registerNCreateCommand(program: Command): void {
  program
    .command("create")
    .argument("<workflow_id_dev>", "Workflow ID in DEV")
    .argument(
      "[project_root]",
      "Base directory where project folder will be created",
      ".",
    )
    .option("--force", "Re-initialize project.json when it already exists")
    .description("Create project from DEV workflow and initialize project.json")
    .action(
      async (
        workflowIdDev: string,
        projectRoot: string,
        options: CreateCommandOptions,
      ) => {
      const spinner = ora("Preparing project creation").start();
      try {
        const env = loadEnv();
        const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
        const workflow = await devClient.getWorkflowById(workflowIdDev);
        const projectName = normalizeProjectName(workflow.name);
        const projectDir = path.resolve(process.cwd(), projectRoot, projectName);
        const project = path.relative(process.cwd(), projectDir) || ".";

        await ensureProjectDir(projectDir);
        const metadataPath = resolveProjectMetadataFilePath(project);
        const alreadyInitialized = await fileExists(metadataPath);

        if (alreadyInitialized && options.force !== true) {
          throw new ValidationError(
            `Project "${project}" already initialized. Use --force to re-initialize.`,
          );
        }

        const now = new Date().toISOString();
        const existingMetadata = alreadyInitialized
          ? await tryReadProjectMetadata(metadataPath)
          : null;
        const metadata: ProjectMetadata = {
          schema_version: 1,
          project,
          name: projectName,
          plan: {
            root_workflow_id_dev: workflow.id,
            root_workflow_name: workflow.name,
            updated_at: now,
          },
          created_at: existingMetadata?.created_at ?? now,
          updated_at: now,
        };

        await writeJsonFile(metadataPath, metadata);

        if (alreadyInitialized) {
          spinner.succeed("Project re-initialized");
          logger.warn(`[NCREATE] Project re-initialized: ${projectDir}`);
        } else {
          spinner.succeed("Project created");
          logger.success(`[NCREATE] Project created: ${projectDir}`);
        }
        logger.info(`[NCREATE] root_workflow_id=${workflow.id}`);
        logger.info(`[NCREATE] root_workflow_name=${workflow.name}`);
        logger.success(`[NCREATE] Metadata file: ${metadataPath}`);
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("Project creation failed");
        }
        throw error;
      }
    });
}

async function tryReadProjectMetadata(metadataPath: string): Promise<ProjectMetadata | null> {
  try {
    const metadata = await readJsonFile<ProjectMetadata>(metadataPath);
    return metadata;
  } catch {
    return null;
  }
}

function normalizeProjectName(workflowName: string): string {
  const sanitized = workflowName
    .trim()
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  if (!sanitized) {
    throw new ValidationError("Workflow name cannot be converted into a valid folder name");
  }
  return sanitized;
}
