export interface NDeployStorage {
  resolveProjectPath(projectPath: string): string;
  resolveProjectPathFromRoot(projectRoot: string, projectName: string): string;
}
