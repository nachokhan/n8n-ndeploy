import { NDeployApi } from "../api/NDeployApi.js";
import { ProjectMetadata } from "../utils/file.js";
import { resolveRuntimeConfig } from "../utils/runtime.js";

export async function buildApiFromRuntime(options?: {
  profile?: string;
  projectMetadata?: ProjectMetadata | null;
}): Promise<{ api: NDeployApi; profileName: string | null }> {
  const runtime = await resolveRuntimeConfig({
    profile: options?.profile,
    projectMetadata: options?.projectMetadata ?? undefined,
  });

  return {
    api: new NDeployApi({
      source: runtime.source,
      target: runtime.target,
    }),
    profileName: runtime.profileName,
  };
}
