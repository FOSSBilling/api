export enum LogLevel {
  ERROR = "error",
  WARN = "warn",
  INFO = "info"
}

function redactSensitiveData(data: unknown): unknown {
  if (typeof data === "string") {
    return data.replace(/Bearer\s+[A-Za-z0-9\-_]+/g, "Bearer [REDACTED]");
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (
        key.toLowerCase().includes("token") ||
        key.toLowerCase().includes("key") ||
        key.toLowerCase().includes("secret") ||
        key.toLowerCase().includes("password")
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitiveData(value);
      }
    }
    return result;
  }

  return data;
}

// console[level] with a `[service] message` prefix and the redacted context
// as a separate trailing argument: Workers observability already attaches
// timestamp and severity metadata to every console line, so the old
// hand-rolled [timestamp] [level] prefixes duplicated it. (Workers Logs
// serializes the arguments into the message text; the split just keeps the
// prefix and payload distinct at the source.)
function log(
  level: LogLevel,
  service: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const prefix = `[${service.toUpperCase()}]`;
  if (context) {
    const payload = redactSensitiveData(context) as Record<string, unknown>;
    console[level](prefix, message, JSON.stringify(payload));
  } else {
    console[level](prefix, message);
  }
}

export function logError(
  service: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log(LogLevel.ERROR, service, message, context);
}

export function logWarn(
  service: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log(LogLevel.WARN, service, message, context);
}

export function logInfo(
  service: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log(LogLevel.INFO, service, message, context);
}
