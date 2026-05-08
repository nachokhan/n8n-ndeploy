import { DeployResult, DeploySummary } from "../types/deployResult.js";
import { DeploymentPlan } from "../types/plan.js";
import { ProjectMetadata } from "../utils/file.js";
import { CredentialSnapshotFile, CredentialsManifestFile } from "../types/credentials.js";
import { NDeployLogEvent, NDeployLogger } from "../logging/NDeployLogger.js";
import { NDeployStorage } from "../storage/NDeployStorage.js";

export interface NDeployEndpointConfig {
  url: string;
  apiKey: string;
  credentialExportUrl?: string;
  credentialExportToken?: string;
}

export interface NDeployApiConfig {
  source: NDeployEndpointConfig;
  target: NDeployEndpointConfig;
  storage?: NDeployStorage;
  logger?: NDeployLogger;
  onEvent?: (event: NDeployLogEvent) => void | Promise<void>;
}

export interface CreateProjectInput {
  workflowIdSource: string;
  projectRoot?: string;
  force?: boolean;
  profileName?: string;
}

export interface CreateProjectResult {
  projectPath: string;
  projectName: string;
  metadataPath: string;
  rootWorkflowIdSource: string;
  rootWorkflowName: string;
  profileName: string | null;
}

export interface GeneratePlanInput { projectPath: string; }
export interface GeneratePlanResult {
  plan: DeploymentPlan;
  summary: unknown;
  planPath: string;
  summaryPath: string;
  backupPath: string | null;
  projectMetadata: ProjectMetadata;
}

export interface ApplyPlanInput { projectPath: string; forceUpdate?: boolean; }
export interface ApplyPlanResult {
  result: DeployResult;
  summary: DeploySummary;
  resultPath: string;
  summaryPath: string;
  partial: boolean;
}

export interface PublishWorkflowInput { workflowIdTarget: string; }
export interface GetProjectInfoInput { projectPath: string; outputPath?: string; }

export interface FetchCredentialsInput { projectPath: string; side?: "source" | "target" | "both"; }
export interface FetchCredentialsResult { source?: CredentialSnapshotFile; target?: CredentialSnapshotFile; sourcePath?: string; targetPath?: string; }

export interface CompareCredentialsInput { projectPath: string; strict?: boolean; }
export interface MergeMissingCredentialsInput { projectPath: string; side?: "source" | "target" | "both"; }
export interface ValidateCredentialsInput { projectPath: string; side?: "source" | "target" | "manifest" | "all"; strict?: boolean; outputPath?: string; }

export interface FindOrphansInput { projectPath: string; side: "source" | "target"; workflows?: boolean; credentials?: boolean; datatables?: boolean; all?: boolean; outputPath?: string; }
export interface FindDanglingReferencesInput { projectPath: string; side: "source" | "target"; workflows?: boolean; credentials?: boolean; datatables?: boolean; all?: boolean; outputPath?: string; }

export interface RemoveResourcesInput {
  workflows?: string[] | "all";
  credentials?: string[] | "all";
  datatables?: string[] | "all";
  archivedWorkflows?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  confirmationText?: string;
  outputPath?: string;
}

export type CredentialsComparisonStatus = "identical" | "different" | "missing_in_source" | "missing_in_target" | "type_mismatch";

export interface CredentialsCompareItem {
  source_id: string;
  name: string;
  type: string | null;
  status: CredentialsComparisonStatus;
  differing_fields: Array<{ field: string; source: unknown; target: unknown }>;
}

export interface CredentialsCompareResult {
  summary: {
    total: number;
    identical: number;
    different: number;
    missing_in_source: number;
    missing_in_target: number;
    type_mismatch: number;
  };
  credentials: CredentialsCompareItem[];
}

export interface MergeMissingCredentialsResult {
  manifest: CredentialsManifestFile;
  manifestPath: string;
  added: number;
  skippedExisting: number;
}
