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

// One structured object per line: Workers Logs serializes object arguments
// as JSON and indexes the top-level fields, so `service` and the redacted
// `context` keys stay filterable in the dashboard instead of being baked
// into an unparseable message string. Timestamp and severity metadata are
// attached by the observability pipeline either way.
function log(
  level: LogLevel,
  service: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const entry: Record<string, unknown> = { service, message };
  if (context) {
    entry.context = redactSensitiveData(context);
  }
  console[level](entry);
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
