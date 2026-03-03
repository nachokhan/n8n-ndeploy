import axios, { AxiosError, AxiosInstance } from "axios";
import { ApiError } from "../errors/index.js";
import {
  N8nCredential,
  N8nCredentialSchema,
  N8nDataTable,
  N8nDataTableRowsSchema,
  N8nDataTableSchema,
  N8nWorkflow,
  N8nWorkflowSchema,
} from "../types/n8n.js";
import { z } from "zod";
import { logger } from "../utils/logger.js";

interface ListResponse<T> {
  data?: T[];
}

interface CredentialListItem {
  id: string;
  name: string;
  type?: string;
}

interface CredentialPlaceholderDataInfo {
  data: Record<string, unknown>;
  requiredFields: string[];
  propertyTypes: Record<string, string>;
}

const WorkflowSummarySchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
});

const CredentialListItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
  type: z.string().optional(),
});

const DataTableSummarySchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
});

function normalizeAxiosError(error: unknown, context: Record<string, unknown>): ApiError {
  const axiosErr = error as AxiosError;
  const status = axiosErr.response?.status;
  const responseData = axiosErr.response?.data;
  const message = axiosErr.message || "Unknown API error";
  return new ApiError(message, status, { ...context, responseData });
}

export class N8nClient {
  private readonly api: AxiosInstance;
  private credentialCache: CredentialListItem[] | null = null;
  private readonly allowedWorkflowSettingsKeys = new Set([
    "saveExecutionProgress",
    "saveManualExecutions",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "executionTimeout",
    "errorWorkflow",
    "timezone",
    "executionOrder",
    "callerPolicy",
    "callerIds",
    "timeSavedPerExecution",
    "availableInMCP",
  ]);

  constructor(baseURL: string, apiKey: string) {
    this.api = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        "X-N8N-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  async getWorkflowById(id: string): Promise<N8nWorkflow> {
    try {
      const response = await this.api.get(`/api/v1/workflows/${id}`);
      return N8nWorkflowSchema.parse(response.data);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "workflow", id });
    }
  }

  async findWorkflowByName(name: string): Promise<N8nWorkflow | null> {
    try {
      const response = await this.api.get<ListResponse<unknown>>(`/api/v1/workflows`);
      const list = response.data?.data ?? [];
      const parsed = z.array(WorkflowSummarySchema).parse(list);
      const found = parsed.find((wf) => wf.name === name);
      if (!found) {
        return null;
      }
      return this.getWorkflowById(found.id);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "workflow", name, op: "findByName" });
    }
  }

  async createWorkflow(payload: unknown): Promise<N8nWorkflow> {
    try {
      const sanitized = this.sanitizeWorkflowForWrite(payload);
      logger.debug(
        `[N8N_CLIENT] create workflow payload keys=${Object.keys(sanitized).join(",")}`,
      );
      const response = await this.api.post(`/api/v1/workflows`, sanitized);
      return N8nWorkflowSchema.parse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw normalizeAxiosError(error, { entity: "workflow", op: "create" });
    }
  }

  async updateWorkflow(id: string, payload: unknown): Promise<N8nWorkflow> {
    try {
      const sanitized = this.sanitizeWorkflowForWrite(payload);
      logger.debug(
        `[N8N_CLIENT] update workflow id=${id} payload keys=${Object.keys(sanitized).join(",")}`,
      );
      const response = await this.api.put(`/api/v1/workflows/${id}`, sanitized);
      return N8nWorkflowSchema.parse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw normalizeAxiosError(error, { entity: "workflow", op: "update", id });
    }
  }

  normalizeWorkflowForWrite(payload: unknown): Record<string, unknown> {
    return this.sanitizeWorkflowForWrite(payload);
  }

  async activateWorkflow(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/workflows/${id}/activate`);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "workflow", op: "activate", id });
    }
  }

  async deactivateWorkflow(id: string): Promise<void> {
    try {
      await this.api.post(`/api/v1/workflows/${id}/deactivate`);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "workflow", op: "deactivate", id });
    }
  }

  async getCredentialById(id: string): Promise<N8nCredential> {
    try {
      const list = await this.listCredentials();
      const found = list.find((credential) => credential.id === id);
      if (!found) {
        throw new ApiError("Credential not found in credential list", 404, { entity: "credential", id });
      }
      if (!found.type) {
        throw new ApiError("Credential type missing in API list response", 422, {
          entity: "credential",
          id,
          name: found.name,
        });
      }
      return N8nCredentialSchema.parse({
        id: found.id,
        name: found.name,
        type: found.type,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw normalizeAxiosError(error, { entity: "credential", id });
    }
  }

  async findCredentialByName(name: string): Promise<N8nCredential | null> {
    try {
      const list = await this.listCredentials();
      const found = list.find((credential) => credential.name === name);
      if (!found) {
        return null;
      }
      return N8nCredentialSchema.parse({
        id: found.id,
        name: found.name,
        // n8n API returns type in list payload; if missing we still allow mapping by name/id.
        type: found.type ?? "unknown",
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw normalizeAxiosError(error, { entity: "credential", name, op: "findByName" });
    }
  }

  async createCredentialPlaceholder(payload: {
    name: string;
    type: string;
    data?: Record<string, unknown>;
  }): Promise<N8nCredential> {
    const placeholder = await this.resolveCredentialPlaceholderData(payload.type, payload.data);
    logger.debug(
      `[N8N_CLIENT] create credential placeholder type="${payload.type}" required_fields=${placeholder.requiredFields.join(",") || "none"}`,
    );

    const maxCreateAttempts = 4;
    const mutableData: Record<string, unknown> = { ...placeholder.data };

    for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
      try {
        logger.debug(
          `[N8N_CLIENT] create credential attempt=${attempt}/${maxCreateAttempts} type="${payload.type}" data_keys=${Object.keys(mutableData).join(",") || "none"}`,
        );
        const response = await this.api.post(`/api/v1/credentials`, {
          name: payload.name,
          type: payload.type,
          data: mutableData,
        });
        return N8nCredentialSchema.parse(response.data);
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : normalizeAxiosError(error, {
                entity: "credential",
                op: "create",
                credentialType: payload.type,
                attempt,
              });

        const missingFields = this.extractMissingRequiredFields(apiError);
        const newFields = missingFields.filter((field) => mutableData[field] === undefined);
        if (apiError.status === 400 && newFields.length > 0 && attempt < maxCreateAttempts) {
          for (const field of newFields) {
            mutableData[field] = this.buildDummyValue(field, placeholder.propertyTypes);
          }
          logger.warn(
            `[N8N_CLIENT] create credential retry type="${payload.type}" added_missing_fields=${newFields.join(",")} next_attempt=${attempt + 1}/${maxCreateAttempts}`,
          );
          continue;
        }

        throw apiError;
      }
    }

    throw new ApiError("Unable to create credential placeholder after retries", 400, {
      entity: "credential",
      op: "create",
      credentialType: payload.type,
    });
  }

  async getDataTableById(id: string): Promise<N8nDataTable> {
    try {
      const response = await this.api.get(`/api/v1/data-tables/${id}`);
      return N8nDataTableSchema.parse(response.data);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "data-table", id });
    }
  }

  async findDataTableByName(name: string): Promise<N8nDataTable | null> {
    try {
      const response = await this.api.get<ListResponse<unknown>>(`/api/v1/data-tables`);
      const list = response.data?.data ?? [];
      const parsed = z.array(DataTableSummarySchema).parse(list);
      const found = parsed.find((table) => table.name === name);
      return found ? this.getDataTableById(found.id) : null;
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "data-table", name, op: "findByName" });
    }
  }

  async getDataTableRows(id: string): Promise<Array<Record<string, unknown>>> {
    try {
      const response = await this.api.get(`/api/v1/data-tables/${id}/rows`);
      return N8nDataTableRowsSchema.parse(response.data?.data ?? response.data);
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "data-table-rows", id });
    }
  }

  async createDataTable(payload: {
    name: string;
    columns: Array<Record<string, unknown>>;
    rows?: Array<Record<string, unknown>>;
  }): Promise<N8nDataTable> {
    try {
      logger.debug(
        `[N8N_CLIENT] create data table name="${payload.name}" columns=${payload.columns.length} rows=${payload.rows?.length ?? 0}`,
      );
      const response = await this.api.post(`/api/v1/data-tables`, {
        name: payload.name,
        columns: payload.columns,
      });
      const table = N8nDataTableSchema.parse(response.data);
      if (payload.rows && payload.rows.length > 0) {
        const sanitizedRows = this.sanitizeDataTableRows(payload.rows, payload.columns);
        await this.insertDataTableRows(table.id, sanitizedRows);
      }
      return table;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw normalizeAxiosError(error, { entity: "data-table", op: "create" });
    }
  }

  private async listCredentials(): Promise<CredentialListItem[]> {
    if (this.credentialCache) {
      logger.debug(`[N8N_CLIENT] credentials cache hit count=${this.credentialCache.length}`);
      return this.credentialCache;
    }
    try {
      logger.debug("[N8N_CLIENT] Fetching credentials list from /api/v1/credentials");
      const response = await this.api.get<ListResponse<unknown> | unknown[]>(`/api/v1/credentials`);
      const raw = this.extractList(response.data);
      const parsed = z.array(CredentialListItemSchema).parse(raw);
      this.credentialCache = parsed;
      logger.debug(`[N8N_CLIENT] credentials fetched count=${parsed.length}`);
      return parsed;
    } catch (error) {
      throw normalizeAxiosError(error, { entity: "credential", op: "list" });
    }
  }

  private extractList(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }
    const maybeWrapped = payload as ListResponse<unknown>;
    if (Array.isArray(maybeWrapped?.data)) {
      return maybeWrapped.data;
    }
    return [];
  }

  private async resolveCredentialPlaceholderData(
    credentialType: string,
    providedData?: Record<string, unknown>,
  ): Promise<CredentialPlaceholderDataInfo> {
    if (providedData && Object.keys(providedData).length > 0) {
      return {
        data: providedData,
        requiredFields: Object.keys(providedData),
        propertyTypes: {},
      };
    }

    const schema = await this.getCredentialSchema(credentialType);
    const parsed = this.parseCredentialSchema(schema);
    const data: Record<string, unknown> = {};
    for (const field of parsed.requiredFields) {
      data[field] = this.buildDummyValue(field, parsed.propertyTypes);
    }

    return {
      data,
      requiredFields: parsed.requiredFields,
      propertyTypes: parsed.propertyTypes,
    };
  }

  private async getCredentialSchema(credentialType: string): Promise<unknown> {
    try {
      logger.debug(`[N8N_CLIENT] Fetching credential schema for type="${credentialType}"`);
      const response = await this.api.get(
        `/api/v1/credentials/schema/${encodeURIComponent(credentialType)}`,
      );
      return response.data;
    } catch (error) {
      throw normalizeAxiosError(error, {
        entity: "credential-schema",
        op: "get",
        credentialType,
      });
    }
  }

  private parseCredentialSchema(schemaPayload: unknown): {
    requiredFields: string[];
    propertyTypes: Record<string, string>;
  } {
    const root = this.asRecord(schemaPayload);
    if (!root) {
      return { requiredFields: [], propertyTypes: {} };
    }

    const candidates: Array<Record<string, unknown>> = [root];
    for (const key of ["data", "schema", "dataSchema", "credentialSchema"]) {
      const nested = this.asRecord(root[key]);
      if (nested) {
        candidates.push(nested);
      }
    }

    let requiredFields: string[] = [];
    for (const candidate of candidates) {
      const required = this.asStringArray(candidate.required);
      if (required.length > 0) {
        requiredFields = required;
        break;
      }
    }

    const propertyTypes = this.collectPropertyTypes(candidates);
    if (requiredFields.length === 0) {
      requiredFields = this.collectRequiredFromPropertyArray(candidates);
    }
    if (requiredFields.length === 0) {
      requiredFields = this.collectRequiredFromPropertyObject(candidates);
    }

    return {
      requiredFields,
      propertyTypes,
    };
  }

  private collectPropertyTypes(candidates: Array<Record<string, unknown>>): Record<string, string> {
    const propertyTypes: Record<string, string> = {};

    for (const candidate of candidates) {
      const propertiesObject = this.asRecord(candidate.properties);
      if (propertiesObject) {
        for (const [fieldName, fieldSchema] of Object.entries(propertiesObject)) {
          const schema = this.asRecord(fieldSchema);
          const fieldType = schema?.type;
          if (typeof fieldType === "string" && !propertyTypes[fieldName]) {
            propertyTypes[fieldName] = fieldType;
          }
        }
      }

      const propertiesArray = Array.isArray(candidate.properties) ? candidate.properties : [];
      for (const item of propertiesArray) {
        const property = this.asRecord(item);
        const fieldName = property?.name;
        const fieldType = property?.type;
        if (
          typeof fieldName === "string" &&
          typeof fieldType === "string" &&
          !propertyTypes[fieldName]
        ) {
          propertyTypes[fieldName] = fieldType;
        }
      }
    }

    return propertyTypes;
  }

  private collectRequiredFromPropertyArray(candidates: Array<Record<string, unknown>>): string[] {
    const required = new Set<string>();

    for (const candidate of candidates) {
      const propertiesArray = Array.isArray(candidate.properties) ? candidate.properties : [];
      for (const item of propertiesArray) {
        const property = this.asRecord(item);
        const fieldName = property?.name;
        const isRequired = property?.required;
        if (typeof fieldName === "string" && isRequired === true) {
          required.add(fieldName);
        }
      }
    }

    return [...required];
  }

  private collectRequiredFromPropertyObject(candidates: Array<Record<string, unknown>>): string[] {
    const required = new Set<string>();

    for (const candidate of candidates) {
      const propertiesObject = this.asRecord(candidate.properties);
      if (!propertiesObject) {
        continue;
      }
      for (const [fieldName, fieldSchema] of Object.entries(propertiesObject)) {
        const schema = this.asRecord(fieldSchema);
        if (schema?.required === true) {
          required.add(fieldName);
        }
      }
    }

    return [...required];
  }

  private buildDummyValue(fieldName: string, propertyTypes: Record<string, string>): unknown {
    const fieldType = propertyTypes[fieldName];
    if (fieldType === "number" || fieldType === "integer") {
      return 0;
    }
    if (fieldType === "boolean") {
      return false;
    }
    if (fieldType === "array") {
      return [];
    }
    if (fieldType === "object") {
      return {};
    }
    return "dummy_value";
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string");
  }

  private extractMissingRequiredFields(apiError: ApiError): string[] {
    const responseData = apiError.context?.responseData;
    let rawMessage = "";
    if (typeof responseData === "string") {
      rawMessage = responseData;
    } else if (responseData && typeof responseData === "object") {
      const message = (responseData as Record<string, unknown>).message;
      if (typeof message === "string") {
        rawMessage = message;
      }
    }

    if (!rawMessage) {
      rawMessage = apiError.message;
    }

    const matches = rawMessage.matchAll(/requires property ["']([^"']+)["']/g);
    const fields = new Set<string>();
    for (const match of matches) {
      const field = match[1];
      if (field) {
        fields.add(field);
      }
    }
    return [...fields];
  }

  private sanitizeWorkflowForWrite(payload: unknown): Record<string, unknown> {
    const source = this.asRecord(payload) ?? {};
    const name = source.name;
    const nodes = source.nodes;
    const connections = source.connections;
    const settings = source.settings;
    const staticData = source.staticData;

    if (typeof name !== "string" || !Array.isArray(nodes) || !this.asRecord(connections)) {
      throw new ApiError("Workflow payload missing required write fields", 422, {
        entity: "workflow",
        op: "sanitize",
        hasName: typeof name === "string",
        hasNodes: Array.isArray(nodes),
        hasConnections: !!this.asRecord(connections),
      });
    }

    const sanitizedSettings = this.sanitizeWorkflowSettings(settings);
    const sanitized: Record<string, unknown> = {
      name,
      nodes,
      connections,
      settings: sanitizedSettings,
    };

    if (staticData !== undefined) {
      sanitized.staticData = staticData;
    }

    return sanitized;
  }

  private sanitizeWorkflowSettings(settings: unknown): Record<string, unknown> {
    const source = this.asRecord(settings) ?? {};
    const sanitized: Record<string, unknown> = {};
    const removedKeys: string[] = [];

    for (const [key, value] of Object.entries(source)) {
      if (this.allowedWorkflowSettingsKeys.has(key)) {
        sanitized[key] = value;
      } else {
        removedKeys.push(key);
      }
    }

    if (removedKeys.length > 0) {
      logger.warn(
        `[N8N_CLIENT] workflow settings dropped unsupported keys=${removedKeys.join(",")}`,
      );
    }

    return sanitized;
  }

  private sanitizeDataTableRows(
    rows: Array<Record<string, unknown>>,
    columns: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const columnNames = columns
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string");

    if (columnNames.length === 0) {
      return rows;
    }

    return rows.map((row) => {
      const cleanRow: Record<string, unknown> = {};
      for (const key of columnNames) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          cleanRow[key] = row[key];
        }
      }
      return cleanRow;
    });
  }

  private async insertDataTableRows(
    dataTableId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    try {
      logger.debug(
        `[N8N_CLIENT] insert data table rows endpoint=/rows table_id=${dataTableId} count=${rows.length}`,
      );
      await this.api.post(`/api/v1/data-tables/${dataTableId}/rows`, {
        data: rows,
        returnType: "count",
      });
      return;
    } catch (error) {
      const firstError = normalizeAxiosError(error, {
        entity: "data-table-rows",
        op: "insert",
        strategy: "rows",
        dataTableId,
      });
      if (firstError.status !== 404 && firstError.status !== 405) {
        throw firstError;
      }
      logger.warn(
        `[N8N_CLIENT] rows insert fallback endpoint=/rows/batch table_id=${dataTableId} status=${firstError.status}`,
      );
    }

    try {
      await this.api.post(`/api/v1/data-tables/${dataTableId}/rows/batch`, { rows });
    } catch (error) {
      throw normalizeAxiosError(error, {
        entity: "data-table-rows",
        op: "insert",
        strategy: "rows-batch",
        dataTableId,
      });
    }
  }
}
