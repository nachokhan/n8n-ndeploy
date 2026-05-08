import path from "node:path";
import { NDeployStorage } from "./NDeployStorage.js";

export interface FileSystemNDeployStorageConfig {
  basePath?: string;
}

export class FileSystemNDeployStorage implements NDeployStorage {
  private readonly basePath: string;

  constructor(config: FileSystemNDeployStorageConfig = {}) {
    this.basePath = path.resolve(config.basePath ?? process.cwd());
  }

  resolveProjectPath(projectPath: string): string {
    return path.resolve(this.basePath, projectPath);
  }

  resolveProjectPathFromRoot(projectRoot: string, projectName: string): string {
    return path.resolve(this.basePath, projectRoot, projectName);
  }
}
