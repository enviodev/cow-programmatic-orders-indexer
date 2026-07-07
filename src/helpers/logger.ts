// Structured JSON logger for handler code — one JSON line per call.
// Ported from the upstream ponder indexer; envio's context.log is per-handler,
// while these helpers also run outside handler context.

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ time: Date.now(), level, msg, ...fields });
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
