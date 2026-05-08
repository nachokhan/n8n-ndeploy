export type NDeployLogLevel = "debug" | "info" | "warn" | "error" | "success";

export interface NDeployLogEvent {
  level: NDeployLogLevel;
  phase?: string;
  step?: string;
  message: string;
  data?: unknown;
  timestamp: string;
}

export interface NDeployLogger {
  log(event: NDeployLogEvent): void | Promise<void>;
  debug?(event: Omit<NDeployLogEvent, "level">): void | Promise<void>;
  info?(event: Omit<NDeployLogEvent, "level">): void | Promise<void>;
  warn?(event: Omit<NDeployLogEvent, "level">): void | Promise<void>;
  error?(event: Omit<NDeployLogEvent, "level">): void | Promise<void>;
  success?(event: Omit<NDeployLogEvent, "level">): void | Promise<void>;
}
