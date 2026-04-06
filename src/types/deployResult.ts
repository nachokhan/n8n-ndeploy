import { PlanAction, PlanActionType, WorkflowObservability } from "./plan.js";

export type DeployActionStatus = "executed" | "skipped" | "failed";
export type WorkflowPublishStatus = "auto_published" | "skipped_root" | "not_applicable";

export interface DeployResultErrorItem {
  order: number;
  type: PlanActionType;
  name: string;
  message: string;
  status_code: number | null;
}

export interface DeployActionResultItem {
  order: number;
  type: PlanActionType;
  action: PlanAction;
  name: string;
  status: DeployActionStatus;
  prod_id: string | null;
  duration_ms: number;
  dependencies: string[];
  observability: WorkflowObservability | null;
  publish_status: WorkflowPublishStatus;
  error: {
    message: string;
    status_code: number | null;
  } | null;
}

export interface DeployResult {
  metadata: {
    run_id: string;
    plan_id: string;
    project: string;
    started_at: string;
    finished_at: string;
    force_update: boolean;
  };
  totals: {
    total: number;
    executed: number;
    skipped: number;
    failed: number;
    by_type: {
      CREDENTIAL: number;
      DATATABLE: number;
      WORKFLOW: number;
    };
    by_action: {
      CREATE: number;
      UPDATE: number;
      MAP_EXISTING: number;
    };
  };
  credentials: DeployActionResultItem[];
  datatables: DeployActionResultItem[];
  workflows: DeployActionResultItem[];
  errors: DeployResultErrorItem[];
}

export interface DeploySummaryActionItem {
  order: number;
  name: string;
  action: PlanAction;
  status: DeployActionStatus;
  publish_status: WorkflowPublishStatus;
}

export interface DeploySummary {
  metadata: DeployResult["metadata"];
  totals: DeployResult["totals"];
  credentials: DeploySummaryActionItem[];
  datatables: DeploySummaryActionItem[];
  workflows: DeploySummaryActionItem[];
  errors: DeployResultErrorItem[];
}
