import path from "node:path";
import axios from "axios";
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
  NDeployEndpointConfig,
  PublishWorkflowInput,
  RemoveResourcesInput,
  ValidateCredentialsInput,
} from "./types.js";
import { CredentialSnapshotEntry, CredentialSnapshotFile, CredentialsManifestEntry, CredentialsManifestFile } from "../types/credentials.js";

interface FillLookupCandidate {
  result_id: string;
  request_id: string;
  name: string;
  type: string | null;
}

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

    const metadata = metadataExists
      ? await readJsonFile<Record<string, unknown>>(metadataPath)
      : null;
    const plan = planExists ? await readJsonFile<Record<string, unknown>>(planPath) : null;
    const planSummary = planSummaryExists
      ? await readJsonFile<Record<string, unknown>>(planSummaryPath)
      : null;
    const credentialsSource = credentialsSourceExists
      ? await readJsonFile<Record<string, unknown>>(credentialsSourcePath)
      : null;
    const credentialsTarget = credentialsTargetExists
      ? await readJsonFile<Record<string, unknown>>(credentialsTargetPath)
      : null;
    const credentialsManifest = credentialsManifestExists
      ? await readJsonFile<Record<string, unknown>>(credentialsManifestPath)
      : null;
    const deployResult = deployResultExists
      ? await readJsonFile<Record<string, unknown>>(deployResultPath)
      : null;
    const deploySummary = deploySummaryExists
      ? await readJsonFile<Record<string, unknown>>(deploySummaryPath)
      : null;

    const output = {
      project,
      project_path: path.resolve(project),
      metadata: {
        exists: metadataExists,
        path: metadataPath,
        schema_version: getNumber(metadata, "schema_version"),
        name: getString(metadata, "name"),
        created_at: getString(metadata, "created_at"),
        updated_at: getString(metadata, "updated_at"),
        plan: {
          root_workflow_id_source: getNestedString(metadata, ["plan", "root_workflow_id_source"]),
          root_workflow_name: getNestedString(metadata, ["plan", "root_workflow_name"]),
          updated_at: getNestedString(metadata, ["plan", "updated_at"]),
        },
        deploy: {
          profile: getNestedString(metadata, ["deploy", "profile"]),
          updated_at: getNestedString(metadata, ["deploy", "updated_at"]),
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
        credentials_source: {
          exists: credentialsSourceExists,
          path: credentialsSourcePath,
          schema_version: getNestedNumber(credentialsSource, ["metadata", "schema_version"]),
          credentials: getArrayLength(credentialsSource, "credentials"),
          generated_at: getNestedString(credentialsSource, ["metadata", "generated_at"]),
        },
        credentials_target: {
          exists: credentialsTargetExists,
          path: credentialsTargetPath,
          schema_version: getNestedNumber(credentialsTarget, ["metadata", "schema_version"]),
          credentials: getArrayLength(credentialsTarget, "credentials"),
          generated_at: getNestedString(credentialsTarget, ["metadata", "generated_at"]),
        },
        credentials_manifest: {
          exists: credentialsManifestExists,
          path: credentialsManifestPath,
          schema_version: getNestedNumber(credentialsManifest, ["metadata", "schema_version"]),
          credentials: getArrayLength(credentialsManifest, "credentials"),
          root_workflow_id_source: getNestedString(credentialsManifest, ["metadata", "root_workflow_id_source"]),
          updated_at: getNestedString(credentialsManifest, ["metadata", "updated_at"]),
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
      const existing = bySourceId.get(item.source_id);
      if (existing) {
        if (!this.templateHasData(existing.template.data) && this.templateHasData(item.template.data)) {
          bySourceId.set(item.source_id, {
            ...existing,
            updated_at: new Date().toISOString(),
            seeded_from: this.resolveSeededFrom(mergeSide, item),
            template: {
              ...item.template,
              fields: [...item.template.fields],
              required_fields: [...item.template.required_fields],
              data: { ...item.template.data },
            },
          });
        }
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
        seeded_from: this.resolveSeededFrom(mergeSide, item),
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
    actions: Array<{ type: string; action: string; source_id: string; name: string }>,
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

    const bySourceId = new Map(manifest.credentials.map((c) => [c.source_id, c]));
    const sourceSnapshot = await this.readSnapshotForSideIfExists(projectPath, "source");
    const sourceById = new Map((sourceSnapshot?.credentials ?? []).map((credential) => [credential.source_id, credential]));

    for (const action of actions.filter((item) => item.type === "CREDENTIAL" && item.action === "CREATE")) {
      const manifestEntry = bySourceId.get(action.source_id);
      if (!manifestEntry) {
        continue;
      }

      if (this.templateHasData(manifestEntry.template.data)) {
        continue;
      }

      const sourceEntry = sourceById.get(action.source_id);
      if (!sourceEntry || !this.templateHasData(sourceEntry.template.data)) {
        continue;
      }

      bySourceId.set(action.source_id, {
        ...manifestEntry,
        updated_at: new Date().toISOString(),
        seeded_from: "source",
        template: {
          ...sourceEntry.template,
          fields: [...sourceEntry.template.fields],
          required_fields: [...sourceEntry.template.required_fields],
          data: { ...sourceEntry.template.data },
        },
      });
      await this.emit("info", "Credential CREATE manifest entry filled from source snapshot", {
        source_id: action.source_id,
        name: action.name,
      });
    }

    return bySourceId;
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
    const matchedBySourceId = new Map<
      string,
      { id: string | null; name: string | null; type: string | null; matched_by: "id" | "name" | "unmatched"; resolution: "resolved" | "missing" }
    >();
    const fillCandidates: FillLookupCandidate[] = [];

    for (const d of deps) {
      const matched = side === "source"
        ? { id: d.source_id, name: d.name, type: d.type, matched_by: "id" as const, resolution: "resolved" as const }
        : await this.resolveTargetCredential(d);
      matchedBySourceId.set(d.source_id, matched);
      if (matched.id) {
        fillCandidates.push({
          result_id: d.source_id,
          request_id: matched.id,
          name: matched.name ?? d.name,
          type: matched.type ?? d.type,
        });
      }
    }

    const fillDataBySourceId = await this.resolveFillDataViaSide(
      side === "source" ? this.sourceClient : this.targetClient,
      side === "source" ? this.config.source : this.config.target,
      fillCandidates,
      side,
    );

    for (const d of deps) {
      const matched = matchedBySourceId.get(d.source_id);
      if (!matched) {
        throw new ValidationError("Credential match missing after snapshot resolution", {
          source_id: d.source_id,
          side,
        });
      }
      const template = await this.buildCredentialTemplate(
        d,
        fillDataBySourceId.get(d.source_id) ?? null,
        side,
      );
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
    fillData: Record<string, unknown> | null,
    side: "source" | "target",
  ) {
    const requiredFields = await this.sourceClient.getCredentialTemplate(d.type)
      .then((t) => t.requiredFields)
      .catch(() => []);
    return {
      source: "schema" as const,
      required_fields: requiredFields,
      fields: requiredFields.map((f) => ({ name: f, type: null, required: true })),
      data: fillData ?? {},
      note: fillData && this.templateHasData(fillData)
        ? `Filled with data available from the ${side} API/export endpoint.`
        : `No fill data available from ${side} side.`,
    };
  }

  private async resolveFillDataViaSide(
    client: N8nClient,
    endpointConfig: NDeployEndpointConfig,
    candidates: FillLookupCandidate[],
    side: "source" | "target",
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();

    for (const candidate of candidates) {
      const apiData = await client.getCredentialDataForFill(candidate.request_id);
      if (apiData && this.templateHasData(apiData)) {
        result.set(candidate.result_id, apiData);
      }
    }

    const unresolved = candidates.filter((candidate) => !result.has(candidate.result_id));
    if (unresolved.length === 0) {
      await this.emit("info", "Credential fill resolved from API", {
        side,
        resolved: result.size,
        unresolved: 0,
      });
      return result;
    }

    if (!endpointConfig.credentialExportUrl || !endpointConfig.credentialExportToken) {
      await this.emit("info", "Credential export endpoint fallback disabled", {
        side,
        resolved: result.size,
        unresolved: unresolved.length,
      });
      return result;
    }

    const endpointMap = await this.fetchFillDataFromExportEndpoint(
      endpointConfig.credentialExportUrl,
      endpointConfig.credentialExportToken,
      unresolved,
    );
    for (const [credentialId, data] of endpointMap.entries()) {
      if (!result.has(credentialId)) {
        result.set(credentialId, data);
      }
    }

    await this.emit("info", "Credential fill resolved from API/export endpoint", {
      side,
      resolved: result.size,
      unresolved: candidates.filter((candidate) => !result.has(candidate.result_id)).length,
    });
    return result;
  }

  private async fetchFillDataFromExportEndpoint(
    endpointUrl: string,
    endpointToken: string,
    credentials: FillLookupCandidate[],
  ): Promise<Map<string, Record<string, unknown>>> {
    try {
      const response = await axios.post(
        endpointUrl,
        {
          credentials: credentials.map((credential) => ({
            source_id: credential.request_id,
            id: credential.request_id,
            name: credential.name,
            type: credential.type,
          })),
        },
        {
          timeout: 20000,
          headers: {
            Authorization: `Bearer ${endpointToken}`,
            "X-NDEPLOY-TOKEN": endpointToken,
            "Content-Type": "application/json",
          },
        },
      );
      const rawMap = this.parseExportEndpointResponse(response.data);
      const result = new Map<string, Record<string, unknown>>();
      const resultIdByRequestId = new Map(
        credentials.map((credential) => [credential.request_id, credential.result_id] as const),
      );
      for (const [requestId, data] of rawMap.entries()) {
        const resultId = resultIdByRequestId.get(requestId);
        if (resultId) {
          result.set(resultId, data);
        }
      }
      return result;
    } catch (error) {
      await this.emit("warn", "Credential export endpoint unavailable", {
        status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
      });
      return new Map<string, Record<string, unknown>>();
    }
  }

  private parseExportEndpointResponse(payload: unknown): Map<string, Record<string, unknown>> {
    const items = this.extractCredentialItems(payload);
    const result = new Map<string, Record<string, unknown>>();

    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const idValue = record.source_id ?? record.dev_id ?? record.id;
      if (typeof idValue !== "string" && typeof idValue !== "number") {
        continue;
      }
      const credentialId = String(idValue);
      const data = this.extractCredentialData(record);
      if (data && this.templateHasData(data)) {
        result.set(credentialId, data);
      }
    }

    return result;
  }

  private extractCredentialItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const root = payload as Record<string, unknown>;
    for (const key of ["credentials", "items", "results", "data"]) {
      const value = root[key];
      if (Array.isArray(value)) {
        return value;
      }
    }

    const nestedData = root.data;
    if (nestedData && typeof nestedData === "object" && !Array.isArray(nestedData)) {
      const nested = nestedData as Record<string, unknown>;
      for (const key of ["credentials", "items", "results"]) {
        const value = nested[key];
        if (Array.isArray(value)) {
          return value;
        }
      }
    }

    return [];
  }

  private extractCredentialData(record: Record<string, unknown>): Record<string, unknown> | null {
    for (const candidate of [record.data, record.credential_data, record.values]) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>;
      }
    }
    return null;
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

  private async readSnapshotForSideIfExists(projectPath: string, side: "source" | "target"): Promise<CredentialSnapshotFile | null> {
    const filePath = side === "source" ? resolveProjectCredentialsSourceFilePath(projectPath) : resolveProjectCredentialsTargetFilePath(projectPath);
    if (!(await fileExists(filePath))) {
      return null;
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
    return ids
      .map((id) => {
        const target = targetById.get(id);
        const source = sourceById.get(id);
        if (target && target.matched_by !== "unmatched" && this.templateHasData(target.template.data)) {
          return target;
        }
        return source ?? target;
      })
      .filter((i): i is CredentialSnapshotEntry => Boolean(i));
  }

  private resolveSeededFrom(
    mergeSide: "source" | "target" | "both",
    snapshot: CredentialSnapshotEntry,
  ): CredentialsManifestEntry["seeded_from"] {
    if (mergeSide === "source") return "source";
    if (mergeSide === "target") return "target";
    return snapshot.matched_by === "name" ? "target" : "source";
  }

  private templateHasData(data: Record<string, unknown>): boolean {
    return Object.keys(data).some((key) => !this.isMissing(data[key]));
  }

  private validateSnapshot(snapshot: CredentialSnapshotFile) {
    return {
      file: `${snapshot.metadata.side}`,
      summary: { credentials: snapshot.credentials.length },
      credentials: snapshot.credentials.map((credential) => ({
        source_id: credential.source_id,
        name: credential.name,
        type: credential.type,
        missing: this.getCredentialRequiredDataFields(credential.type).filter((f) => this.isMissing(credential.template.data[f])),
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
        missing: this.getCredentialRequiredDataFields(credential.type, credential.template.required_fields).filter((f) => this.isMissing(credential.template.data[f])),
      })),
    };
  }

  private getCredentialRequiredDataFields(type: string | null, schemaRequiredFields: string[] = []): string[] {
    const byType = type === "httpHeaderAuth" ? ["name", "value"] : [];
    return [...new Set([...schemaRequiredFields, ...byType])];
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

function getArrayLength(data: Record<string, unknown> | null, key: string): number | null {
  if (!data) return null;
  const value = data[key];
  return Array.isArray(value) ? value.length : null;
}

function getString(data: Record<string, unknown> | null, key: string): string | null {
  if (!data) return null;
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function getNumber(data: Record<string, unknown> | null, key: string): number | null {
  if (!data) return null;
  const value = data[key];
  return typeof value === "number" ? value : null;
}

function getNestedString(
  data: Record<string, unknown> | null,
  pathParts: string[],
): string | null {
  const value = getNestedValue(data, pathParts);
  return typeof value === "string" ? value : null;
}

function getNestedNumber(
  data: Record<string, unknown> | null,
  pathParts: string[],
): number | null {
  const value = getNestedValue(data, pathParts);
  return typeof value === "number" ? value : null;
}

function getNestedValue(
  data: Record<string, unknown> | null,
  pathParts: string[],
): unknown {
  let current: unknown = data;
  for (const key of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
