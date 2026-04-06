import path from "path";
import axios from "axios";
import { Command } from "commander";
import { N8nClient } from "../services/N8nClient.js";
import { ValidationError } from "../errors/index.js";
import { AppEnv, loadEnv } from "../utils/env.js";
import {
  ProjectMetadata,
  fileExists,
  readJsonFile,
  resolveProjectDir,
  resolveProjectMetadataFilePath,
  resolveProjectProductionCredentialsFilePath,
  writeJsonFile,
} from "../utils/file.js";
import { logger } from "../utils/logger.js";
import {
  ProductionCredentialEntry,
  ProductionCredentialsFile,
} from "../types/productionCredentials.js";

interface CredentialsUpdateOptions {
  fill?: boolean;
  side?: string;
}

interface CredentialFillCandidate {
  id: string;
  name: string;
  type: string | null;
}

type Side = "source" | "target";

interface FillLookupCandidate {
  result_id: string;
  request_id: string;
  name: string;
  type: string | null;
}

interface CredentialsValidateOptions {
  output?: string;
  strict?: boolean;
}

interface CredentialValidationItem {
  dev_id: string;
  name: string;
  type: string | null;
  missing_required_fields: string[];
}

interface CredentialsValidationResult {
  project: string;
  project_path: string;
  production_credentials_file: string;
  updated_at: string | null;
  totals: {
    active_credentials: number;
    ready: number;
    missing_required_fields: number;
  };
  credentials: CredentialValidationItem[];
}

export function registerNCredentialsCommand(program: Command): void {
  const credentials = new Command("credentials");
  credentials.description("Credential-related commands");

  credentials
    .command("update")
    .argument("<project>", "Project directory")
    .option("--fill", "Prefill new credentials with as much DEV API data as available")
    .option("--side <source|target>", "Choose which configured instance to use as fill source", "source")
    .description("Create or update production_credentials.json from DEV root workflow dependencies")
    .action(async (project: string, options: CredentialsUpdateOptions) => {
      const env = loadEnv();
      const fillSide = parseSide(options.side);
      const projectPath = resolveProjectDir(project);
      const projectExists = await fileExists(projectPath);
      if (!projectExists) {
        throw new ValidationError(
          `Project "${project}" does not exist at ${projectPath}. Run: ndeploy create <workflow_id_dev> [project_root]`,
        );
      }

      const metadataPath = resolveProjectMetadataFilePath(project);
      const metadataExists = await fileExists(metadataPath);
      if (!metadataExists) {
        throw new ValidationError(
          `Project "${project}" is not initialized. Missing ${metadataPath}.`,
        );
      }
      const projectMetadata = await readJsonFile<ProjectMetadata>(metadataPath);
      const rootWorkflowId = projectMetadata.plan?.root_workflow_id_dev;
      if (!rootWorkflowId) {
        throw new ValidationError(
          `Project "${project}" has no root workflow configured. Run: ndeploy create <workflow_id_dev> [project_root]`,
        );
      }

      const devClient = new N8nClient(env.N8N_DEV_URL, env.N8N_DEV_API_KEY);
      const prodClient = new N8nClient(env.N8N_PROD_URL, env.N8N_PROD_API_KEY);
      const discovery = await discoverCredentialDependencies(devClient, rootWorkflowId);
      const credentialIds = [...discovery.credentialIds].sort((a, b) => a.localeCompare(b));
      const devCredentialById = new Map<
        string,
        { id: string; name: string; type: string | null }
      >();
      for (const credentialId of credentialIds) {
        const credential = await devClient.getCredentialById(credentialId);
        devCredentialById.set(credentialId, {
          id: credential.id,
          name: credential.name,
          type: credential.type,
        });
      }

      const credentialsPath = resolveProjectProductionCredentialsFilePath(project);
      const fileExistsAlready = await fileExists(credentialsPath);
      const existingFile = fileExistsAlready
        ? await readExistingCredentialsFile(credentialsPath)
        : null;
      const now = new Date().toISOString();

      const activeByDevId = new Map<string, ProductionCredentialEntry>();
      const archivedByDevId = new Map<string, ProductionCredentialEntry>();
      if (existingFile) {
        for (const entry of existingFile.active_credentials) {
          activeByDevId.set(entry.dev_id, entry);
        }
        for (const entry of existingFile.archived_credentials) {
          archivedByDevId.set(entry.dev_id, entry);
        }
      }

      const newCredentials: CredentialFillCandidate[] = [];
      const existingCredentials: CredentialFillCandidate[] = [];
      for (const credentialId of credentialIds) {
        const credential = devCredentialById.get(credentialId);
        if (!credential) {
          continue;
        }
        if (activeByDevId.has(credentialId) || archivedByDevId.has(credentialId)) {
          existingCredentials.push({
            id: credential.id,
            name: credential.name,
            type: credential.type,
          });
        } else {
          newCredentials.push({
            id: credential.id,
            name: credential.name,
            type: credential.type,
          });
        }
      }

      const fillDataByCredentialId = await resolveFillDataForCredentials(
        devClient,
        prodClient,
        env,
        fillSide === "target" ? [...existingCredentials, ...newCredentials] : newCredentials,
        options.fill === true,
        fillSide,
      );

      const nextActive: ProductionCredentialEntry[] = [];
      for (const credentialId of credentialIds) {
        const credential = devCredentialById.get(credentialId);
        if (!credential) {
          continue;
        }
        const existingActive = activeByDevId.get(credentialId);
        if (existingActive) {
          const refreshed =
            options.fill === true && fillSide === "target"
              ? applyFillDataToTemplate(
                  existingActive.template,
                  fillDataByCredentialId.get(credential.id) ?? null,
                  fillSide,
                )
              : null;
          nextActive.push({
            ...existingActive,
            name: credential.name,
            updated_at: refreshed ? now : existingActive.updated_at,
            template: refreshed ?? existingActive.template,
          });
          continue;
        }

        const existingArchived = archivedByDevId.get(credentialId);
        if (existingArchived) {
          const refreshed =
            options.fill === true && fillSide === "target"
              ? applyFillDataToTemplate(
                  existingArchived.template,
                  fillDataByCredentialId.get(credential.id) ?? null,
                  fillSide,
                )
              : null;
          nextActive.push({
            ...existingArchived,
            name: credential.name,
            updated_at: refreshed ? now : existingArchived.updated_at,
            template: refreshed ?? existingArchived.template,
          });
          archivedByDevId.delete(credentialId);
          continue;
        }

        const template = await buildTemplateForNewCredential(
          devClient,
          credential.type,
          options.fill === true,
          fillDataByCredentialId.get(credential.id) ?? null,
          fillSide,
        );
        nextActive.push({
          dev_id: credential.id,
          name: credential.name,
          type: credential.type,
          created_at: now,
          updated_at: now,
          template,
        });
      }

      const nextArchivedByDevId = new Map<string, ProductionCredentialEntry>();
      if (existingFile) {
        for (const archivedEntry of archivedByDevId.values()) {
          nextArchivedByDevId.set(archivedEntry.dev_id, archivedEntry);
        }
        for (const oldActive of existingFile.active_credentials) {
          const stillActive = nextActive.some((entry) => entry.dev_id === oldActive.dev_id);
          if (!stillActive) {
            nextArchivedByDevId.set(oldActive.dev_id, {
              ...oldActive,
              updated_at: now,
            });
          }
        }
      }

      nextActive.sort((a, b) => a.name.localeCompare(b.name));
      const nextArchived = [...nextArchivedByDevId.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      const nextFile: ProductionCredentialsFile = {
        metadata: {
          schema_version: 2,
          project,
          root_workflow_id_dev: rootWorkflowId,
          root_workflow_name: discovery.rootWorkflowName ?? projectMetadata.plan.root_workflow_name,
          updated_at: now,
        },
        active_credentials: nextActive,
        archived_credentials: nextArchived,
      };

      await writeJsonFile(credentialsPath, nextFile);
      logger.success(`[NCREDENTIALS] Updated file: ${credentialsPath}`);
      logger.success(
        `[NCREDENTIALS] active=${nextFile.active_credentials.length} archived=${nextFile.archived_credentials.length} fill_new=${options.fill === true} fill_side=${fillSide}`,
      );
    });

  credentials
    .command("validate")
    .argument("<project>", "Project directory")
    .option("-o, --output <file_path>", "Write JSON report to file")
    .option("--strict", "Exit with error if missing required fields are found")
    .description("Validate required fields for active credentials in production_credentials.json")
    .action(async (project: string, options: CredentialsValidateOptions) => {
      const projectPath = resolveProjectDir(project);
      const projectExists = await fileExists(projectPath);
      if (!projectExists) {
        throw new ValidationError(
          `Project "${project}" does not exist at ${projectPath}. Run: ndeploy create <workflow_id_dev> [project_root]`,
        );
      }

      const credentialsFilePath = resolveProjectProductionCredentialsFilePath(project);
      const credentialsFileExists = await fileExists(credentialsFilePath);
      if (!credentialsFileExists) {
        throw new ValidationError(
          `Missing ${credentialsFilePath}. Run: ndeploy credentials update <project>`,
        );
      }

      const file = await readExistingCredentialsFile(credentialsFilePath);
      const validationItems = file.active_credentials.map((credential) => {
        const required = credential.template.required_fields ?? [];
        const data = credential.template.data ?? {};
        const missingRequired = required.filter((fieldName) =>
          isMissingValue((data as Record<string, unknown>)[fieldName]),
        );
        return {
          dev_id: credential.dev_id,
          name: credential.name,
          type: credential.type,
          missing_required_fields: missingRequired,
        };
      });

      const missingRequiredTotal = validationItems.reduce(
        (total, item) => total + item.missing_required_fields.length,
        0,
      );
      const readyCount = validationItems.filter((item) => item.missing_required_fields.length === 0).length;

      const result: CredentialsValidationResult = {
        project,
        project_path: projectPath,
        production_credentials_file: credentialsFilePath,
        updated_at: file.metadata?.updated_at ?? null,
        totals: {
          active_credentials: validationItems.length,
          ready: readyCount,
          missing_required_fields: missingRequiredTotal,
        },
        credentials: validationItems,
      };

      if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        await writeJsonFile(outputPath, result);
        logger.success(`[NCREDENTIALS] Validation report written to ${outputPath}`);
      }

      console.log(JSON.stringify(result, null, 2));

      if (missingRequiredTotal > 0) {
        logger.warn(
          `[NCREDENTIALS] Missing required fields: ${missingRequiredTotal} across ${validationItems.length} active credential(s)`,
        );
        if (options.strict) {
          throw new ValidationError(
            `Credential validation failed: ${missingRequiredTotal} required field(s) missing.`,
          );
        }
      } else {
        logger.success("[NCREDENTIALS] All required credential fields are complete");
      }
    });

  program.addCommand(credentials);
  logger.debug("Command credentials registered");
}

async function discoverCredentialDependencies(
  devClient: N8nClient,
  rootWorkflowId: string,
): Promise<{ rootWorkflowName: string | null; credentialIds: Set<string> }> {
  const visitedWorkflowIds = new Set<string>();
  const credentialIds = new Set<string>();
  let rootWorkflowName: string | null = null;

  async function discover(workflowId: string): Promise<void> {
    if (visitedWorkflowIds.has(workflowId)) {
      return;
    }
    visitedWorkflowIds.add(workflowId);

    const workflow = await devClient.getWorkflowById(workflowId);
    if (workflowId === rootWorkflowId) {
      rootWorkflowName = workflow.name;
    }

    for (const node of workflow.nodes) {
      if (node.credentials) {
        for (const credential of Object.values(node.credentials)) {
          const credentialId = extractReferenceId(credential?.id);
          if (credentialId) {
            credentialIds.add(credentialId);
          }
        }
      }

      if (node.type === "n8n-nodes-base.executeWorkflow") {
        const subWorkflowId = extractReferenceId(node.parameters?.workflowId);
        if (subWorkflowId) {
          await discover(subWorkflowId);
        }
      }
    }
  }

  await discover(rootWorkflowId);
  return { rootWorkflowName, credentialIds };
}

async function buildTemplateForNewCredential(
  devClient: N8nClient,
  credentialType: string | null,
  fillRequested: boolean,
  fillData: Record<string, unknown> | null,
  fillSide: Side,
): Promise<ProductionCredentialEntry["template"]> {
  if (!credentialType) {
    return {
      source: "unavailable",
      required_fields: [],
      fields: [],
      data: {},
      note: "Credential type missing in DEV.",
    };
  }

  try {
    const template = await devClient.getCredentialTemplate(credentialType);
    const data = buildTemplateData(template.fields, template.requiredFields);
    if (fillRequested && fillData) {
      for (const [key, value] of Object.entries(fillData)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          data[key] = value;
        }
      }
    }

    return {
      source: "dev_schema",
      required_fields: template.requiredFields,
      fields: template.fields,
      data,
      note: fillRequested
        ? fillData
          ? `Filled with data available from ${fillSide === "source" ? "DEV" : "PROD"} API/export endpoint.`
          : `No fill data available from ${fillSide === "source" ? "DEV" : "PROD"}. Fields were created from DEV schema.`
        : "Fields created from DEV schema with empty values.",
    };
  } catch {
    return {
      source: "unavailable",
      required_fields: [],
      fields: [],
      data: {},
      note: "Could not load credential schema from DEV.",
    };
  }
}

async function resolveFillDataForCredentials(
  devClient: N8nClient,
  prodClient: N8nClient,
  env: AppEnv,
  credentials: CredentialFillCandidate[],
  fillRequested: boolean,
  fillSide: Side,
): Promise<Map<string, Record<string, unknown>>> {
  if (!fillRequested || credentials.length === 0) {
    return new Map<string, Record<string, unknown>>();
  }

  if (fillSide === "source") {
    const candidates = credentials.map((credential) => ({
      result_id: credential.id,
      request_id: credential.id,
      name: credential.name,
      type: credential.type,
    }));
    return resolveFillDataViaSide(devClient, env, candidates, fillSide);
  }

  const targetCandidates = await buildTargetFillCandidates(prodClient, credentials);
  if (targetCandidates.length === 0) {
    logger.info("[NCREDENTIALS] Fill side=target resolved=0 unresolved=all lookup=name_match_not_found");
    return new Map<string, Record<string, unknown>>();
  }

  return resolveFillDataViaSide(prodClient, env, targetCandidates, fillSide);
}

async function buildTargetFillCandidates(
  prodClient: N8nClient,
  newCredentials: CredentialFillCandidate[],
): Promise<FillLookupCandidate[]> {
  const result: FillLookupCandidate[] = [];

  for (const credential of newCredentials) {
    const found = await prodClient.findCredentialByName(credential.name);
    if (!found) {
      continue;
    }
    if (credential.type && found.type !== "unknown" && found.type !== credential.type) {
      continue;
    }
    result.push({
      result_id: credential.id,
      request_id: found.id,
      name: credential.name,
      type: credential.type,
    });
  }

  return result;
}

async function resolveFillDataViaSide(
  client: N8nClient,
  env: AppEnv,
  candidates: FillLookupCandidate[],
  side: Side,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();

  for (const candidate of candidates) {
    const apiData = await client.getCredentialDataForFill(candidate.request_id);
    if (apiData) {
      result.set(candidate.result_id, apiData);
    }
  }

  const unresolved = candidates.filter((candidate) => !result.has(candidate.result_id));
  if (unresolved.length === 0) {
    logger.info(
      `[NCREDENTIALS] Fill side=${side} source=api resolved=${result.size} unresolved=0`,
    );
    return result;
  }

  const endpoint = resolveCredentialExportEndpoint(env, side);
  if (!endpoint.url || !endpoint.token) {
    logger.info(
      `[NCREDENTIALS] Fill side=${side} source=api resolved=${result.size} unresolved=${unresolved.length} endpoint_fallback=disabled`,
    );
    return result;
  }

  const endpointMap = await fetchFillDataFromExportEndpoint(endpoint.url, endpoint.token, unresolved);
  for (const [credentialId, data] of endpointMap.entries()) {
    if (!result.has(credentialId)) {
      result.set(credentialId, data);
    }
  }

  const stillUnresolved = candidates.filter((candidate) => !result.has(candidate.result_id)).length;
  logger.info(
    `[NCREDENTIALS] Fill side=${side} source=api+endpoint resolved=${result.size} unresolved=${stillUnresolved}`,
  );
  return result;
}

function resolveCredentialExportEndpoint(
  env: AppEnv,
  side: Side,
): { url?: string; token?: string } {
  if (side === "source") {
    return {
      url: env.N8N_DEV_CREDENTIAL_EXPORT_URL,
      token: env.N8N_DEV_CREDENTIAL_EXPORT_TOKEN,
    };
  }

  return {
    url: env.N8N_PROD_CREDENTIAL_EXPORT_URL,
    token: env.N8N_PROD_CREDENTIAL_EXPORT_TOKEN,
  };
}

function applyFillDataToTemplate(
  template: ProductionCredentialEntry["template"],
  fillData: Record<string, unknown> | null,
  fillSide: Side,
): ProductionCredentialEntry["template"] | null {
  if (!fillData) {
    return null;
  }

  const nextData = { ...(template.data ?? {}) };
  for (const [key, value] of Object.entries(fillData)) {
    if (Object.prototype.hasOwnProperty.call(nextData, key)) {
      nextData[key] = value;
    }
  }

  return {
    ...template,
    data: nextData,
    note: `Filled with data available from ${fillSide === "source" ? "DEV" : "PROD"} API/export endpoint.`,
  };
}

async function fetchFillDataFromExportEndpoint(
  endpointUrl: string,
  endpointToken: string,
  credentials: FillLookupCandidate[],
): Promise<Map<string, Record<string, unknown>>> {
  try {
    const response = await axios.post(
      endpointUrl,
      {
        credentials: credentials.map((credential) => ({
          dev_id: credential.request_id,
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
    const rawMap = parseExportEndpointResponse(response.data);
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
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    logger.warn(
      `[NCREDENTIALS] Credential export endpoint unavailable status=${status ?? "unknown"}`,
    );
    return new Map<string, Record<string, unknown>>();
  }
}

function parseExportEndpointResponse(
  payload: unknown,
): Map<string, Record<string, unknown>> {
  const items = extractCredentialItems(payload);
  const result = new Map<string, Record<string, unknown>>();

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const idValue = record.dev_id ?? record.id;
    if (typeof idValue !== "string" && typeof idValue !== "number") {
      continue;
    }
    const credentialId = String(idValue);
    const data = extractCredentialData(record);
    if (data) {
      result.set(credentialId, data);
    }
  }

  return result;
}

function extractCredentialItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;
  const directCandidates = ["credentials", "items", "results", "data"];
  for (const key of directCandidates) {
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

function extractCredentialData(record: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [record.data, record.credential_data, record.values];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function buildTemplateData(
  fields: Array<{ name: string }>,
  requiredFields: string[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    data[field.name] = null;
  }
  for (const requiredField of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(data, requiredField)) {
      data[requiredField] = null;
    }
  }
  return data;
}

async function readExistingCredentialsFile(filePath: string): Promise<ProductionCredentialsFile> {
  const file = await readJsonFile<Partial<ProductionCredentialsFile>>(filePath);
  if (!Array.isArray(file.active_credentials) || !Array.isArray(file.archived_credentials)) {
    throw new ValidationError(
      `Invalid credentials file format in ${filePath}. Expected fields: active_credentials, archived_credentials.`,
    );
  }
  if (!file.metadata || typeof file.metadata !== "object") {
    throw new ValidationError(`Invalid credentials file format in ${filePath}. Missing metadata.`);
  }
  return file as ProductionCredentialsFile;
}

function extractReferenceId(reference: unknown): string | null {
  if (typeof reference === "string" || typeof reference === "number") {
    return String(reference);
  }
  if (!reference || typeof reference !== "object") {
    return null;
  }
  const record = reference as Record<string, unknown>;
  const directValue = record.value;
  if (typeof directValue === "string" || typeof directValue === "number") {
    return String(directValue);
  }
  const directId = record.id;
  if (typeof directId === "string" || typeof directId === "number") {
    return String(directId);
  }
  return null;
}

function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  return false;
}

function parseSide(value: string | undefined): Side {
  if (!value) {
    return "source";
  }
  if (value === "source" || value === "target") {
    return value;
  }
  throw new ValidationError("Option --side must be one of: source, target");
}
