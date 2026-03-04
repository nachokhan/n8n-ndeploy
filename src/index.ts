#!/usr/bin/env node
import { Command } from "commander";
import { registerNPlanCommand } from "./cli/nplan.js";
import { registerNDeployCommand } from "./cli/ndeploy.js";
import { registerNPublishCommand } from "./cli/npublish.js";
import { registerNRemoveCommand } from "./cli/nremove.js";
import { registerNOrphansCommand } from "./cli/norphans.js";
import { ApiError, DependencyError, ValidationError } from "./errors/index.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("ndeploy")
    .description("Deterministic and idempotent n8n DEV->PROD deployment CLI")
    .version("1.2.0");

  registerNPlanCommand(program);
  registerNDeployCommand(program);
  registerNPublishCommand(program);
  registerNRemoveCommand(program);
  registerNOrphansCommand(program);

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
    process.exitCode = 1;
  }
}

function handleError(error: unknown): void {
  if (error instanceof ValidationError) {
    logger.error(`ValidationError: ${error.message}`);
    if (error.details) {
      logger.error(JSON.stringify(error.details, null, 2));
    }
    return;
  }

  if (error instanceof DependencyError) {
    logger.error(`DependencyError: ${error.message}`);
    if (error.context) {
      logger.error(JSON.stringify(error.context, null, 2));
    }
    return;
  }

  if (error instanceof ApiError) {
    logger.error(`ApiError: ${error.message}`);
    if (error.status) {
      logger.error(`Status: ${error.status}`);
    }
    if (error.context) {
      logger.error(JSON.stringify(error.context, null, 2));
    }
    return;
  }

  const fallback = error as Error;
  logger.error(`Unexpected error: ${fallback.message}`);
}

void main();
