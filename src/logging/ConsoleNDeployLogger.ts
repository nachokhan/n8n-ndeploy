import { NDeployLogEvent, NDeployLogger } from "./NDeployLogger.js";

export class ConsoleNDeployLogger implements NDeployLogger {
  log(event: NDeployLogEvent): void {
    const line = `[${event.timestamp}] [${event.level.toUpperCase()}] ${event.message}`;
    if (event.level === "error") {
      console.error(line);
      return;
    }
    if (event.level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }
}
