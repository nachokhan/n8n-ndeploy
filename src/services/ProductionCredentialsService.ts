import { DeploymentPlan, PlanActionItem } from "../types/plan.js";
import {
  ProductionCredentialItem,
  ProductionCredentialsFile,
} from "../types/productionCredentials.js";

export class ProductionCredentialsService {
  build(plan: DeploymentPlan): ProductionCredentialsFile {
    const actionByDevId = new Map<string, PlanActionItem>();
    for (const action of plan.actions) {
      actionByDevId.set(action.dev_id, action);
    }

    const rootWorkflow = actionByDevId.get(plan.metadata.root_workflow_id);
    const credentials = plan.actions
      .filter((action) => action.type === "CREDENTIAL")
      .map((action) => {
        const payload = action.payload as { type?: string } | undefined;
        const existsInProd = action.action === "MAP_EXISTING";
        const item: ProductionCredentialItem = {
          name: action.name,
          type: payload?.type ?? null,
          dev_id: action.dev_id,
          prod_id: action.prod_id,
          status: existsInProd ? "EXISTS_IN_PROD" : "MISSING_IN_PROD",
          required_action: existsInProd ? "KEEP" : "CREATE",
        };
        return item;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const existsInProdCount = credentials.filter((item) => item.status === "EXISTS_IN_PROD").length;

    return {
      metadata: {
        generated_at: plan.metadata.generated_at,
        plan_id: plan.metadata.plan_id,
        root_workflow_id: plan.metadata.root_workflow_id,
        root_workflow_name: rootWorkflow?.name ?? null,
        source_instance: plan.metadata.source_instance,
        target_instance: plan.metadata.target_instance,
      },
      summary: {
        total: credentials.length,
        exists_in_prod: existsInProdCount,
        missing_in_prod: credentials.length - existsInProdCount,
      },
      credentials,
    };
  }
}
