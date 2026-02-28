import { z } from "zod";

export const N8nCredentialRefSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

export const N8nNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  parameters: z.record(z.any()).optional(),
  credentials: z.record(N8nCredentialRefSchema).optional(),
}).passthrough();

export const N8nWorkflowSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
  nodes: z.array(N8nNodeSchema),
}).passthrough();

export const N8nCredentialSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
  type: z.string(),
  data: z.unknown().optional(),
});

export const N8nDataTableColumnSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  nullable: z.boolean().optional(),
});

export const N8nDataTableSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  name: z.string(),
  columns: z.array(N8nDataTableColumnSchema).default([]),
});

export const N8nDataTableRowsSchema = z.array(z.record(z.any()));

export type N8nNode = z.infer<typeof N8nNodeSchema>;
export type N8nWorkflow = z.infer<typeof N8nWorkflowSchema>;
export type N8nCredential = z.infer<typeof N8nCredentialSchema>;
export type N8nDataTable = z.infer<typeof N8nDataTableSchema>;

export interface DependencySnapshot {
  credentialIds: Set<string>;
  dataTableIds: Set<string>;
  subWorkflowIds: Set<string>;
}
