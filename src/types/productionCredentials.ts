export type ProductionCredentialStatus = "EXISTS_IN_PROD" | "MISSING_IN_PROD";
export type ProductionCredentialAction = "KEEP" | "CREATE";

export interface ProductionCredentialItem {
  name: string;
  type: string | null;
  dev_id: string;
  prod_id: string | null;
  status: ProductionCredentialStatus;
  required_action: ProductionCredentialAction;
}

export interface ProductionCredentialsMetadata {
  generated_at: string;
  plan_id: string;
  root_workflow_id: string;
  root_workflow_name: string | null;
  source_instance: string;
  target_instance: string;
}

export interface ProductionCredentialsSummary {
  total: number;
  exists_in_prod: number;
  missing_in_prod: number;
}

export interface ProductionCredentialsFile {
  metadata: ProductionCredentialsMetadata;
  summary: ProductionCredentialsSummary;
  credentials: ProductionCredentialItem[];
}
