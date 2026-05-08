import path from "node:path";
import { N8nClient } from "../services/N8nClient.js";
import { PlanService } from "../services/PlanService.js";
import { PlanSummaryService } from "../services/PlanSummaryService.js";
import { DeployService } from "../services/DeployService.js";
import { DeploySummaryService } from "../services/DeploySummaryService.js";
import { TransformService } from "../services/TransformService.js";
import { ValidationError } from "../errors/index.js";
import {
  backupProjectPlanIfExists,
  ensureProjectDir,
  fileExists,
  ProjectMetadata,
  readJsonFile,
  resolveProjectCredentialsManifestFilePath,
  resolveProjectCredentialsSourceFilePath,
  resolveProjectCredentialsTargetFilePath,
  resolveProjectDanglingFilePath,
  resolveProjectDeployResultFilePath,
  resolveProjectDeploySummaryFilePath,
  resolveProjectMetadataFilePath,
  resolveProjectOrphansFilePath,
  resolveProjectPlanFilePath,
  resolveProjectPlanSummaryFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { NoopNDeployLogger } from "../logging/NoopNDeployLogger.js";
import { FileSystemNDeployStorage } from "../storage/FileSystemNDeployStorage.js";
import { NDeployLogLevel } from "../logging/NDeployLogger.js";
import {
  ApplyPlanInput,
  ApplyPlanResult,
  CompareCredentialsInput,
  CreateProjectInput,
  CreateProjectResult,
  CredentialsCompareItem,
  CredentialsCompareResult,
  FetchCredentialsInput,
  FetchCredentialsResult,
  FindDanglingReferencesInput,
  FindOrphansInput,
  GeneratePlanInput,
  GeneratePlanResult,
  GetProjectInfoInput,
  MergeMissingCredentialsInput,
  MergeMissingCredentialsResult,
  NDeployApiConfig,
  PublishWorkflowInput,
  RemoveResourcesInput,
  ValidateCredentialsInput,
} from "./types.js";
import { CredentialSnapshotEntry, CredentialSnapshotFile, CredentialsManifestFile } from "../types/credentials.js";

export class NDeployApi {
  private readonly sourceClient: N8nClient;
  private readonly targetClient: N8nClient;
  private readonly storage;
  private readonly logger;
  private readonly onEvent;

  constructor(private readonly config: NDeployApiConfig) {
    this.sourceClient = new N8nClient(config.source.url, config.source.apiKey);
    this.targetClient = new N8nClient(config.target.url, config.target.apiKey);
    this.storage = config.storage ?? new FileSystemNDeployStorage();
    this.logger = config.logger ?? new NoopNDeployLogger();
    this.onEvent = config.onEvent;
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const workflow = await this.sourceClient.getWorkflowById(input.workflowIdSource);
    const projectName = normalizeProjectName(workflow.name);
    const projectPath = this.storage.resolveProjectPathFromRoot(input.projectRoot ?? ".", projectName);
    await ensureProjectDir(projectPath);
    const metadataPath = resolveProjectMetadataFilePath(projectPath);
    const already = await fileExists(metadataPath);
    if (already && input.force !== true) {
      throw new ValidationError(`Project \"${projectPath}\" already initialized. Use force=true.`);
    }

    const now = new Date().toISOString();
    const existingMetadata = already ? await tryRead<ProjectMetadata>(metadataPath) : null;
    const metadata: ProjectMetadata = {
      schema_version: 1,
      project: projectPath,
      name: projectName,
      plan: {
        root_workflow_id_source: workflow.id,
        root_workflow_name: workflow.name,
        updated_at: now,
      },
      deploy: {
        profile: input.profileName ?? existingMetadata?.deploy?.profile ?? null,
        updated_at: input.profileName ? now : (existingMetadata?.deploy?.updated_at ?? null),
      },
      created_at: existingMetadata?.created_at ?? now,
      updated_at: now,
    };
    await writeJsonFile(metadataPath, metadata);
    await this.emit("success", "Project created", { projectPath, rootWorkflowIdSource: workflow.id });

    return {
      projectPath,
      projectName,
      metadataPath,
      rootWorkflowIdSource: workflow.id,
      rootWorkflowName: workflow.name,
      profileName: metadata.deploy?.profile ?? null,
    };
  }

  async initProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    return this.createProject(input);
  }

  async generatePlan(input: GeneratePlanInput): Promise<GeneratePlanResult> {
    const metadata = await this.readRequiredProjectMetadata(input.projectPath);
    const workflowIdSource = metadata.plan.root_workflow_id_source;
    if (!workflowIdSource) {
      throw new ValidationError("Project has no root workflow configured.");
    }
    const service = new PlanService(this.sourceClient, this.targetClient, this.config.source.url, this.config.target.url);
    const summaryService = new PlanSummaryService();
    const plan = await service.buildPlan(workflowIdSource);
    const summary = summaryService.buildSummary(plan);
    const backupPath = await backupProjectPlanIfExists(input.projectPath);
    const planPath = resolveProjectPlanFilePath(input.projectPath);
    const summaryPath = resolveProjectPlanSummaryFilePath(input.projectPath);
    await writeJsonFile(planPath, plan);
    await writeJsonFile(summaryPath, summary);

    const rootAction = plan.actions.find((a) => a.type === "WORKFLOW" && a.source_id === workflowIdSource);
    if (rootAction && rootAction.name !== metadata.plan.root_workflow_name) {
      const now = new Date().toISOString();
      metadata.plan.root_workflow_name = rootAction.name;
      metadata.plan.updated_at = now;
      metadata.updated_at = now;
      await writeJsonFile(resolveProjectMetadataFilePath(input.projectPath), metadata);
    }

    return { plan, summary, planPath, summaryPath, backupPath, projectMetadata: metadata };
  }

  async applyPlan(input: ApplyPlanInput): Promise<ApplyPlanResult> {
    const service = new DeployService(this.sourceClient, this.targetClient, new TransformService(), {
      forceUpdate: input.forceUpdate === true,
    });
    const summaryService = new DeploySummaryService();
    let partial = false;
    try {
      const rawPlan = await readJsonFile<unknown>(resolveProjectPlanFilePath(input.projectPath));
      const plan = await service.validatePlan(rawPlan);
      const manifest = await this.readCredentialsManifestForApply(input.projectPath, plan.actions);
      const result = await service.executePlanWithResult(plan, input.projectPath, manifest);
      const summary = summaryService.buildSummary(result);
      const resultPath = resolveProjectDeployResultFilePath(input.projectPath);
      const summaryPath = resolveProjectDeploySummaryFilePath(input.projectPath);
      await writeJsonFile(resultPath, result);
      await writeJsonFile(summaryPath, summary);
      return { result, summary, resultPath, summaryPath, partial };
    } catch (error) {
      const runResult = service.getLastDeployResult();
      if (runResult) {
        partial = true;
        const summary = summaryService.buildSummary(runResult);
        const resultPath = resolveProjectDeployResultFilePath(input.projectPath);
        const summaryPath = resolveProjectDeploySummaryFilePath(input.projectPath);
        await writeJsonFile(resultPath, runResult);
        await writeJsonFile(summaryPath, summary);
        return { result: runResult, summary, resultPath, summaryPath, partial };
      }
      throw error;
    }
  }

  async publishWorkflow(input: PublishWorkflowInput): Promise<{ workflowIdTarget: string; published: boolean }> {
    await this.targetClient.activateWorkflow(input.workflowIdTarget);
    return { workflowIdTarget: input.workflowIdTarget, published: true };
  }

  async getProjectInfo(input: GetProjectInfoInput): Promise<unknown> {
    const project = input.projectPath;
    const metadataPath = resolveProjectMetadataFilePath(project);
    const planPath = resolveProjectPlanFilePath(project);
    const planSummaryPath = resolveProjectPlanSummaryFilePath(project);
    const credentialsSourcePath = resolveProjectCredentialsSourceFilePath(project);
    const credentialsTargetPath = resolveProjectCredentialsTargetFilePath(project);
    const credentialsManifestPath = resolveProjectCredentialsManifestFilePath(project);
    const deployResultPath = resolveProjectDeployResultFilePath(project);
    const deploySummaryPath = resolveProjectDeploySummaryFilePath(project);

    const [
      metadataExists,
      planExists,
      planSummaryExists,
      credentialsSourceExists,
      credentialsTargetExists,
      credentialsManifestExists,
      deployResultExists,
      deploySummaryExists,
    ] = await Promise.all([
      fileExists(metadataPath), fileExists(planPath), fileExists(planSummaryPath),
      fileExists(credentialsSourcePath), fileExists(credentialsTargetPath), fileExists(credentialsManifestPath),
      fileExists(deployResultPath), fileExists(deploySummaryPath),
    ]);

    const output = {
      project,
      project_path: path.resolve(project),
      artifacts: {
        plan: { exists: planExists, path: planPath },
        plan_summary: { exists: planSummaryExists, path: planSummaryPath },
        credentials_source: { exists: credentialsSourceExists, path: credentialsSourcePath },
        credentials_target: { exists: credentialsTargetExists, path: credentialsTargetPath },
        credentials_manifest: { exists: credentialsManifestExists, path: credentialsManifestPath },
        deploy_result: { exists: deployResultExists, path: deployResultPath },
        deploy_summary: { exists: deploySummaryExists, path: deploySummaryPath },
      },
      metadata: {
        exists: metadataExists,
        path: metadataPath,
        data: metadataExists ? await readJsonFile<unknown>(metadataPath) : null,
      },
    };

    if (input.outputPath) {
      await writeJsonFile(path.resolve(input.outputPath), output);
    }

    return output;
  }

  async fetchCredentials(input: FetchCredentialsInput): Promise<FetchCredentialsResult> {
    const projectMetadata = await this.readRequiredProjectMetadata(input.projectPath);
    const rootWorkflowId = projectMetadata.plan.root_workflow_id_source;
    if (!rootWorkflowId) throw new ValidationError("Project has no root workflow configured.");

    const deps = await this.discoverCredentialDependencies(rootWorkflowId);
    const side = input.side ?? "both";
    const result: FetchCredentialsResult = {};

    if (side === "source" || side === "both") {
      const source = await this.buildSnapshot("source", deps, projectMetadata, input.projectPath);
      const sourcePath = resolveProjectCredentialsSourceFilePath(input.projectPath);
      await writeJsonFile(sourcePath, source);
      result.source = source;
      result.sourcePath = sourcePath;
    }

    if (side === "target" || side === "both") {
      const target = await this.buildSnapshot("target", deps, projectMetadata, input.projectPath);
      const targetPath = resolveProjectCredentialsTargetFilePath(input.projectPath);
      await writeJsonFile(targetPath, target);
      result.target = target;
      result.targetPath = targetPath;
    }

    return result;
  }

  async compareCredentials(input: CompareCredentialsInput): Promise<CredentialsCompareResult> {
    const source = await this.readSnapshotForSide(input.projectPath, "source");
    const target = await this.readSnapshotForSide(input.projectPath, "target");
    const sourceById = new Map(source.credentials.map((i) => [i.source_id, i]));
    const targetById = new Map(target.credentials.map((i) => [i.source_id, i]));
    const allIds = [...new Set([...sourceById.keys(), ...targetById.keys()])].sort();

    const credentials: CredentialsCompareItem[] = allIds.map((id) => {
      const s = sourceById.get(id) ?? null;
      const t = targetById.get(id) ?? null;
      return this.buildCompareItem(id, s, t);
    });

    const summary = {
      total: credentials.length,
      identical: credentials.filter((i) => i.status === "identical").length,
      different: credentials.filter((i) => i.status === "different").length,
      missing_in_source: credentials.filter((i) => i.status === "missing_in_source").length,
      missing_in_target: credentials.filter((i) => i.status === "missing_in_target").length,
      type_mismatch: credentials.filter((i) => i.status === "type_mismatch").length,
    };

    if (input.strict && (summary.different > 0 || summary.missing_in_source > 0 || summary.missing_in_target > 0 || summary.type_mismatch > 0)) {
      throw new ValidationError("Credential comparison found differences between source and target.");
    }

    return { summary, credentials };
  }

  async mergeMissingCredentials(input: MergeMissingCredentialsInput): Promise<MergeMissingCredentialsResult> {
    const mergeSide = input.side ?? "both";
    const sourceSnapshot = mergeSide === "target" ? null : await this.readSnapshotForSide(input.projectPath, "source");
    const targetSnapshot = mergeSide === "source" ? null : await this.readSnapshotForSide(input.projectPath, "target");
    const manifestPath = resolveProjectCredentialsManifestFilePath(input.projectPath);
    const existing = (await fileExists(manifestPath)) ? await readJsonFile<CredentialsManifestFile>(manifestPath) : null;
    const projectMetadata = await this.readRequiredProjectMetadata(input.projectPath);

    const bySourceId = new Map((existing?.credentials ?? []).map((c) => [c.source_id, c]));
    let added = 0;
    let skippedExisting = 0;
    for (const item of this.buildSnapshotMergeOrder(mergeSide, sourceSnapshot, targetSnapshot)) {
      if (bySourceId.has(item.source_id)) {
        skippedExisting += 1;
        continue;
      }
      const now = new Date().toISOString();
      bySourceId.set(item.source_id, {
        source_id: item.source_id,
        name: item.name,
        type: item.type,
        created_at: now,
        updated_at: now,
        seeded_from: mergeSide,
        template: item.template,
      });
      added += 1;
    }

    const manifest: CredentialsManifestFile = {
      metadata: {
        schema_version: 1,
        project: input.projectPath,
        root_workflow_id_source: projectMetadata.plan.root_workflow_id_source ?? "",
        root_workflow_name: projectMetadata.plan.root_workflow_name ?? null,
        updated_at: new Date().toISOString(),
      },
      credentials: [...bySourceId.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
    await writeJsonFile(manifestPath, manifest);
    return { manifest, manifestPath, added, skippedExisting };
  }

  async validateCredentials(input: ValidateCredentialsInput): Promise<unknown> {
    const side = input.side ?? "manifest";
    const outputs: Record<string, unknown> = {};

    if (side === "source" || side === "all") {
      const snapshot = await this.readSnapshotForSide(input.projectPath, "source");
      outputs.source = this.validateSnapshot(snapshot);
    }
    if (side === "target" || side === "all") {
      const snapshot = await this.readSnapshotForSide(input.projectPath, "target");
      outputs.target = this.validateSnapshot(snapshot);
    }
    if (side === "manifest" || side === "all") {
      const manifest = await this.readManifest(input.projectPath);
      outputs.manifest = this.validateManifest(manifest);
    }

    if (input.outputPath) {
      await writeJsonFile(path.resolve(input.outputPath), outputs);
    }

    if (input.strict === true) {
      const hasMissing = JSON.stringify(outputs).includes('"missing"');
      if (hasMissing) {
        throw new ValidationError("Credential validation failed in strict mode.");
      }
    }

    return outputs;
  }

  async findOrphans(input: FindOrphansInput): Promise<unknown> {
    const selected = this.resolveEntitySelection(input);
    const client = input.side === "source" ? this.sourceClient : this.targetClient;
    const instanceUrl = input.side === "source" ? this.config.source.url : this.config.target.url;
    const workflowSummaries = await client.listWorkflowsSummary();
    const nonArchived = workflowSummaries.filter((w) => !w.archived);
    const details = await Promise.all(nonArchived.map((w) => client.getWorkflowById(w.id)));

    const referencedWorkflowIds = new Set<string>();
    const referencedCredentialIds = new Set<string>();
    const referencedDataTableIds = new Set<string>();

    for (const workflow of details) {
      for (const node of workflow.nodes) {
        if (node.credentials) {
          for (const credential of Object.values(node.credentials)) {
            const id = this.extractReferenceId((credential as { id?: unknown })?.id);
            if (id) referencedCredentialIds.add(id);
          }
        }
        if (node.type === "n8n-nodes-base.executeWorkflow") {
          const id = this.extractReferenceId(node.parameters?.workflowId);
          if (id && id !== workflow.id) referencedWorkflowIds.add(id);
        }
        if (node.type === "n8n-nodes-base.dataTable") {
          const id = this.extractReferenceId(node.parameters?.dataTableId ?? node.parameters?.tableId);
          if (id) referencedDataTableIds.add(id);
        }
      }
    }

    const [credentials, dataTables] = await Promise.all([client.listCredentialsSummary(), client.listDataTablesSummary()]);
    const response: Record<string, unknown> = {};
    if (selected.workflows) {
      response.workflows = nonArchived.filter((w) => !referencedWorkflowIds.has(w.id)).map((w) => ({
        id: w.id,
        name: w.name,
        url: `${instanceUrl.replace(/\/$/, "")}/workflow/${encodeURIComponent(w.id)}`,
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (selected.credentials) {
      response.credentials = credentials.filter((c) => !referencedCredentialIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (selected.datatables) {
      response.datatables = dataTables.filter((d) => !referencedDataTableIds.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
    }

    const outputPath = input.outputPath ? path.resolve(input.outputPath) : resolveProjectOrphansFilePath(input.projectPath, input.side);
    await writeJsonFile(outputPath, response);
    return response;
  }

  async findDanglingReferences(input: FindDanglingReferencesInput): Promise<unknown> {
    const selected = this.resolveEntitySelection(input);
    const client = input.side === "source" ? this.sourceClient : this.targetClient;
    const instanceUrl = input.side === "source" ? this.config.source.url : this.config.target.url;

    const [workflows, credentials, tables] = await Promise.all([
      client.listWorkflowsSummary(),
      client.listCredentialsSummary(),
      client.listDataTablesSummary(),
    ]);

    const nonArchived = workflows.filter((w) => !w.archived);
    const existingWorkflowIds = new Set(nonArchived.map((w) => w.id));
    const existingCredentialIds = new Set(credentials.map((c) => c.id));
    const existingDataTableIds = new Set(tables.map((t) => t.id));
    const details = await Promise.all(nonArchived.map((w) => client.getWorkflowById(w.id)));

    const out = [] as Array<Record<string, unknown>>;
    let total = 0;

    for (const workflow of details) {
      const missingWorkflows: unknown[] = [];
      const missingCredentials: unknown[] = [];
      const missingTables: unknown[] = [];
      for (const node of workflow.nodes) {
        if (selected.workflows && node.type === "n8n-nodes-base.executeWorkflow") {
          const id = this.extractReferenceId(node.parameters?.workflowId);
          if (id && !existingWorkflowIds.has(id)) missingWorkflows.push({ node_name: node.name, node_type: node.type, field: "parameters.workflowId", missing_id: id });
        }
        if (selected.credentials && node.credentials) {
          for (const [key, value] of Object.entries(node.credentials)) {
            const id = this.extractReferenceId((value as { id?: unknown })?.id);
            if (id && !existingCredentialIds.has(id)) missingCredentials.push({ node_name: node.name, node_type: node.type, field: `credentials.${key}.id`, missing_id: id });
          }
        }
        if (selected.datatables && node.type === "n8n-nodes-base.dataTable") {
          const id = this.extractReferenceId(node.parameters?.dataTableId ?? node.parameters?.tableId);
          if (id && !existingDataTableIds.has(id)) missingTables.push({ node_name: node.name, node_type: node.type, field: "parameters.dataTableId", missing_id: id });
        }
      }

      const count = missingWorkflows.length + missingCredentials.length + missingTables.length;
      if (count === 0) continue;
      total += count;
      out.push({
        workflow: {
          id: workflow.id,
          name: workflow.name,
          url: `${instanceUrl.replace(/\/$/, "")}/workflow/${encodeURIComponent(workflow.id)}`,
        },
        dangling_references: {
          ...(selected.workflows ? { workflows: missingWorkflows } : {}),
          ...(selected.credentials ? { credentials: missingCredentials } : {}),
          ...(selected.datatables ? { datatables: missingTables } : {}),
        },
      });
    }

    out.sort((a, b) => String((a.workflow as { name: string }).name).localeCompare(String((b.workflow as { name: string }).name)));

    const response = {
      summary: {
        side: input.side,
        instance: instanceUrl,
        scanned_workflows: nonArchived.length,
        workflows_with_issues: out.length,
        dangling_references_total: total,
      },
      workflows: out,
    };

    const outputPath = input.outputPath ? path.resolve(input.outputPath) : resolveProjectDanglingFilePath(input.projectPath, input.side);
    await writeJsonFile(outputPath, response);
    return response;
  }

  async removeResources(input: RemoveResourcesInput): Promise<unknown> {
    const confirmed = input.confirm === true || input.confirmationText === "yes";
    if (!confirmed) {
      throw new ValidationError("Explicit confirmation required: pass confirm=true or confirmationText='yes'.");
    }

    const workflowsSelection = this.toSelection(input.workflows);
    const credentialsSelection = this.toSelection(input.credentials);
    const datatablesSelection = this.toSelection(input.datatables);

    const workflowIds = await this.resolveIds("workflows", workflowsSelection);
    const credentialIds = await this.resolveIds("credentials", credentialsSelection);
    const dataTableIds = await this.resolveIds("data-tables", datatablesSelection);

    const response = {
      side: "target",
      instance: this.config.target.url,
      dry_run: input.dryRun === true,
      selected: {
        workflows: workflowIds,
        credentials: credentialIds,
        datatables: dataTableIds,
      },
      removed: {
        workflows: [] as string[],
        credentials: [] as string[],
        datatables: [] as string[],
      },
    };

    if (input.dryRun !== true) {
      for (const id of workflowIds) {
        await this.targetClient.deleteWorkflow(id);
        response.removed.workflows.push(id);
      }
      for (const id of credentialIds) {
        await this.targetClient.deleteCredential(id);
        response.removed.credentials.push(id);
      }
      for (const id of dataTableIds) {
        await this.targetClient.deleteDataTable(id);
        response.removed.datatables.push(id);
      }
    }

    if (input.outputPath) {
      await writeJsonFile(path.resolve(input.outputPath), response);
    }

    return response;
  }

  private async emit(level: NDeployLogLevel, message: string, data?: unknown): Promise<void> {
    const event = { level, message, data, timestamp: new Date().toISOString() };
    await this.logger.log(event);
    if (this.onEvent) {
      await this.onEvent(event);
    }
  }

  private async readRequiredProjectMetadata(projectPath: string): Promise<ProjectMetadata> {
    const metadataPath = resolveProjectMetadataFilePath(projectPath);
    if (!(await fileExists(metadataPath))) {
      throw new ValidationError(`Project metadata not found at ${metadataPath}`);
    }
    const metadata = await readJsonFile<ProjectMetadata>(metadataPath);
    if (!metadata.plan) {
      throw new ValidationError(`Invalid project metadata at ${metadataPath}`);
    }
    return metadata;
  }

  private async readCredentialsManifestForApply(
    projectPath: string,
    actions: Array<{ type: string; action: string }>,
  ) {
    const requiresCredentialCreation = actions.some((action) => action.type === "CREDENTIAL" && action.action === "CREATE");
    if (!requiresCredentialCreation) return null;
    const manifestPath = resolveProjectCredentialsManifestFilePath(projectPath);
    if (!(await fileExists(manifestPath))) {
      throw new ValidationError(`Missing ${manifestPath}.`);
    }
    const manifest = await readJsonFile<Partial<CredentialsManifestFile>>(manifestPath);
    if (!manifest.metadata || !Array.isArray(manifest.credentials)) {
      throw new ValidationError(`Invalid credentials manifest format in ${manifestPath}.`);
    }
    return new Map(manifest.credentials.map((c) => [c.source_id, c]));
  }

  private async discoverCredentialDependencies(rootWorkflowId: string): Promise<Array<{ source_id: string; name: string; type: string }>> {
    const visited = new Set<string>();
    const map = new Map<string, { source_id: string; name: string; type: string }>();
    const walk = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      const wf = await this.sourceClient.getWorkflowById(id);
      for (const node of wf.nodes) {
        if (node.credentials) {
          for (const c of Object.values(node.credentials)) {
            const cid = this.extractReferenceId((c as { id?: unknown })?.id);
            if (!cid || map.has(cid)) continue;
            const full = await this.sourceClient.getCredentialById(cid);
            map.set(cid, { source_id: full.id, name: full.name, type: full.type });
          }
        }
        if (node.type === "n8n-nodes-base.executeWorkflow") {
          const sid = this.extractReferenceId(node.parameters?.workflowId);
          if (sid && sid !== id) await walk(sid);
        }
      }
    };
    await walk(rootWorkflowId);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async buildSnapshot(
    side: "source" | "target",
    deps: Array<{ source_id: string; name: string; type: string }>,
    projectMetadata: ProjectMetadata,
    projectPath: string,
  ): Promise<CredentialSnapshotFile> {
    const entries: CredentialSnapshotEntry[] = [];
    for (const d of deps) {
      const matched = side === "source"
        ? { id: d.source_id, name: d.name, type: d.type, matched_by: "id" as const, resolution: "resolved" as const }
        : await this.resolveTargetCredential(d);
      const template = await this.buildCredentialTemplate(d, matched.id, side);
      entries.push({
        source_id: d.source_id,
        snapshot_id: matched.id,
        name: d.name,
        snapshot_name: matched.name,
        type: d.type,
        snapshot_type: matched.type,
        matched_by: matched.matched_by,
        resolution: matched.resolution,
        template,
      });
    }

    return {
      metadata: {
        schema_version: 1,
        project: projectPath,
        side,
        root_workflow_id_source: projectMetadata.plan.root_workflow_id_source ?? "",
        root_workflow_name: projectMetadata.plan.root_workflow_name ?? null,
        generated_at: new Date().toISOString(),
      },
      credentials: entries,
    };
  }

  private async resolveTargetCredential(d: { source_id: string; name: string; type: string }) {
    const found = await this.targetClient.findCredentialByName(d.name);
    if (!found) return { id: null, name: null, type: null, matched_by: "unmatched" as const, resolution: "missing" as const };
    return { id: found.id, name: found.name, type: found.type, matched_by: "name" as const, resolution: "resolved" as const };
  }

  private async buildCredentialTemplate(
    d: { source_id: string; type: string },
    snapshotId: string | null,
    side: "source" | "target",
  ) {
    const requiredFields = await this.sourceClient.getCredentialTemplate(d.type)
      .then((t) => t.requiredFields)
      .catch(() => []);
    const fillData = snapshotId
      ? await (side === "source" ? this.sourceClient.getCredentialDataForFill(snapshotId) : this.targetClient.getCredentialDataForFill(snapshotId))
      : null;
    return {
      source: "schema" as const,
      required_fields: requiredFields,
      fields: requiredFields.map((f) => ({ name: f, type: null, required: true })),
      data: fillData ?? {},
      note: fillData ? null : `No fill data available from ${side} side.`,
    };
  }

  private async readSnapshotForSide(projectPath: string, side: "source" | "target"): Promise<CredentialSnapshotFile> {
    const filePath = side === "source" ? resolveProjectCredentialsSourceFilePath(projectPath) : resolveProjectCredentialsTargetFilePath(projectPath);
    if (!(await fileExists(filePath))) {
      throw new ValidationError(`Missing ${filePath}. Run credentials fetch first.`);
    }
    const file = await readJsonFile<CredentialSnapshotFile>(filePath);
    if (!file.metadata || !Array.isArray(file.credentials)) {
      throw new ValidationError(`Invalid credentials snapshot format in ${filePath}.`);
    }
    return file;
  }

  private async readManifest(projectPath: string): Promise<CredentialsManifestFile> {
    const manifestPath = resolveProjectCredentialsManifestFilePath(projectPath);
    if (!(await fileExists(manifestPath))) {
      throw new ValidationError(`Missing ${manifestPath}. Run credentials merge-missing first.`);
    }
    const file = await readJsonFile<CredentialsManifestFile>(manifestPath);
    if (!file.metadata || !Array.isArray(file.credentials)) {
      throw new ValidationError(`Invalid credentials manifest format in ${manifestPath}.`);
    }
    return file;
  }

  private buildCompareItem(sourceId: string, source: CredentialSnapshotEntry | null, target: CredentialSnapshotEntry | null): CredentialsCompareItem {
    const name = source?.name ?? target?.name ?? sourceId;
    const type = source?.type ?? target?.type ?? null;
    if (!source) return { source_id: sourceId, name, type, status: "missing_in_source", differing_fields: [] };
    if (!target || target.matched_by === "unmatched") return { source_id: sourceId, name, type, status: "missing_in_target", differing_fields: [] };
    if (source.type && target.snapshot_type && source.type !== target.snapshot_type) return { source_id: sourceId, name, type, status: "type_mismatch", differing_fields: [] };
    const differing_fields = this.computeDifferingFields(source.template.data, target.template.data);
    return { source_id: sourceId, name, type, status: differing_fields.length === 0 ? "identical" : "different", differing_fields };
  }

  private computeDifferingFields(source: Record<string, unknown>, target: Record<string, unknown>) {
    const keys = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
    return keys
      .filter((key) => JSON.stringify(source[key]) !== JSON.stringify(target[key]))
      .map((key) => ({ field: key, source: source[key] ?? null, target: target[key] ?? null }));
  }

  private buildSnapshotMergeOrder(
    mergeSide: "source" | "target" | "both",
    sourceSnapshot: CredentialSnapshotFile | null,
    targetSnapshot: CredentialSnapshotFile | null,
  ): CredentialSnapshotEntry[] {
    if (mergeSide === "source") return [...(sourceSnapshot?.credentials ?? [])];
    if (mergeSide === "target") return [...(targetSnapshot?.credentials ?? [])];

    const sourceById = new Map((sourceSnapshot?.credentials ?? []).map((i) => [i.source_id, i]));
    const targetById = new Map((targetSnapshot?.credentials ?? []).map((i) => [i.source_id, i]));
    const ids = [...new Set([...(targetSnapshot?.credentials ?? []).map((i) => i.source_id), ...(sourceSnapshot?.credentials ?? []).map((i) => i.source_id)])].sort();
    return ids.map((id) => targetById.get(id) ?? sourceById.get(id)).filter((i): i is CredentialSnapshotEntry => Boolean(i));
  }

  private validateSnapshot(snapshot: CredentialSnapshotFile) {
    return {
      file: `${snapshot.metadata.side}`,
      summary: { credentials: snapshot.credentials.length },
      credentials: snapshot.credentials.map((credential) => ({
        source_id: credential.source_id,
        name: credential.name,
        type: credential.type,
        missing: credential.template.required_fields.filter((f) => this.isMissing(credential.template.data[f])),
      })),
    };
  }

  private validateManifest(manifest: CredentialsManifestFile) {
    return {
      file: "manifest",
      summary: { credentials: manifest.credentials.length },
      credentials: manifest.credentials.map((credential) => ({
        source_id: credential.source_id,
        name: credential.name,
        type: credential.type,
        missing: credential.template.required_fields.filter((f) => this.isMissing(credential.template.data[f])),
      })),
    };
  }

  private isMissing(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" && value.trim().length === 0) return true;
    return false;
  }

  private resolveEntitySelection(input: { workflows?: boolean; credentials?: boolean; datatables?: boolean; all?: boolean }) {
    const explicit = input.workflows || input.credentials || input.datatables || input.all;
    if (!explicit || input.all) return { workflows: true, credentials: true, datatables: true };
    return { workflows: input.workflows === true, credentials: input.credentials === true, datatables: input.datatables === true };
  }

  private extractReferenceId(reference: unknown): string | null {
    if (typeof reference === "string" || typeof reference === "number") return String(reference);
    if (!reference || typeof reference !== "object") return null;
    const record = reference as Record<string, unknown>;
    if (typeof record.value === "string" || typeof record.value === "number") return String(record.value);
    if (typeof record.id === "string" || typeof record.id === "number") return String(record.id);
    return null;
  }

  private toSelection(input?: string[] | "all") {
    if (!input) return null;
    if (input === "all") return { mode: "all" as const };
    const ids = [...new Set(input.map((id) => id.trim()).filter(Boolean))];
    return { mode: "ids" as const, ids };
  }

  private async resolveIds(
    target: "workflows" | "credentials" | "data-tables",
    selection: { mode: "all" } | { mode: "ids"; ids: string[] } | null,
  ): Promise<string[]> {
    if (!selection) return [];
    if (selection.mode === "ids") return selection.ids;
    if (target === "workflows") return this.targetClient.listWorkflowIds();
    if (target === "credentials") return this.targetClient.listCredentialIds();
    return this.targetClient.listDataTableIds();
  }
}

async function tryRead<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
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
