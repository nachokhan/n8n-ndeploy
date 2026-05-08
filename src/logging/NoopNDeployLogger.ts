import { NDeployLogEvent, NDeployLogger } from "./NDeployLogger.js";

export class NoopNDeployLogger implements NDeployLogger {
  async log(_event: NDeployLogEvent): Promise<void> {
    return;
  }
}
