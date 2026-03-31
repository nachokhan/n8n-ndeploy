import path from "path";
import ora from "ora";
import { Command } from "commander";
import { ValidationError } from "../errors/index.js";
import {
  WorkspaceMetadata,
  ensureWorkspaceDir,
  fileExists,
  readJsonFile,
  resolveWorkspaceDir,
  resolveWorkspaceMetadataFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { logger } from "../utils/logger.js";

interface CreateCommandOptions {
  force?: boolean;
}

export function registerNCreateCommand(program: Command): void {
  program
    .command("create")
    .argument("<workspace>", "Workspace directory")
    .option("--force", "Re-initialize workspace.json when it already exists")
    .description("Create a workspace and initialize workspace.json")
    .action(async (workspace: string, options: CreateCommandOptions) => {
      const spinner = ora("Preparing workspace creation").start();
      try {
        await ensureWorkspaceDir(workspace);
        const workspaceDir = resolveWorkspaceDir(workspace);
        const metadataPath = resolveWorkspaceMetadataFilePath(workspace);
        const alreadyInitialized = await fileExists(metadataPath);

        if (alreadyInitialized && options.force !== true) {
          throw new ValidationError(
            `Workspace "${workspace}" already initialized. Use --force to re-initialize.`,
          );
        }

        const now = new Date().toISOString();
        const existingMetadata = alreadyInitialized
          ? await tryReadWorkspaceMetadata(metadataPath)
          : null;
        const metadata: WorkspaceMetadata = {
          schema_version: 1,
          workspace,
          name: path.basename(workspaceDir),
          plan: {
            root_workflow_id_dev: existingMetadata?.plan?.root_workflow_id_dev ?? null,
            root_workflow_name: existingMetadata?.plan?.root_workflow_name ?? null,
            updated_at: existingMetadata?.plan?.updated_at ?? null,
          },
          created_at: existingMetadata?.created_at ?? now,
          updated_at: now,
        };

        await writeJsonFile(metadataPath, metadata);

        if (alreadyInitialized) {
          spinner.succeed("Workspace re-initialized");
          logger.warn(`[NCREATE] Workspace re-initialized: ${workspaceDir}`);
        } else {
          spinner.succeed("Workspace created");
          logger.success(`[NCREATE] Workspace created: ${workspaceDir}`);
        }
        logger.info(`[NCREATE] Metadata file: ${metadataPath}`);
      } catch (error) {
        if (spinner.isSpinning) {
          spinner.fail("Workspace creation failed");
        }
        throw error;
      }
    });
}

async function tryReadWorkspaceMetadata(metadataPath: string): Promise<WorkspaceMetadata | null> {
  try {
    const metadata = await readJsonFile<WorkspaceMetadata>(metadataPath);
    return metadata;
  } catch {
    return null;
  }
}
