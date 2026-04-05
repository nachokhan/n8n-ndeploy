import { config } from "dotenv";
import { z } from "zod";
import { ValidationError } from "../errors/index.js";

config();

const EnvSchema = z.object({
  N8N_DEV_URL: z.string().url(),
  N8N_DEV_API_KEY: z.string().min(1),
  N8N_PROD_URL: z.string().url(),
  N8N_PROD_API_KEY: z.string().min(1),
  N8N_DEV_CREDENTIAL_EXPORT_URL: z.string().url().optional(),
  N8N_DEV_CREDENTIAL_EXPORT_TOKEN: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ValidationError("Invalid .env configuration", parsed.error.flatten());
  }
  return parsed.data;
}
