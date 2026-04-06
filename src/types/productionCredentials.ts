export interface ProductionCredentialTemplateField {
  name: string;
  type: string | null;
  required: boolean;
}

export interface ProductionCredentialTemplate {
  source: "dev_schema" | "unavailable";
  required_fields: string[];
  fields: ProductionCredentialTemplateField[];
  data: Record<string, unknown>;
  note: string | null;
}

export interface ProductionCredentialEntry {
  dev_id: string;
  name: string;
  type: string | null;
  created_at: string;
  updated_at: string;
  template: ProductionCredentialTemplate;
}

export interface ProductionCredentialsMetadata {
  schema_version: number;
  project: string;
  root_workflow_id_dev: string;
  root_workflow_name: string | null;
  updated_at: string;
}

export interface ProductionCredentialsFile {
  metadata: ProductionCredentialsMetadata;
  active_credentials: ProductionCredentialEntry[];
  archived_credentials: ProductionCredentialEntry[];
}
