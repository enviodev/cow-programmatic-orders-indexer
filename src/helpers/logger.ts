// Structured logger for handler code, ported from the upstream ponder indexer
// (log(level, msg, fields)). These helpers also run outside a handler, where
// envio's context.log is unavailable.
//
// envio >=3.15 routes console.* through its own logger: a (message, plainObject)
// call becomes a structured line at the matching level (uinfo/uwarn/uerror),
// tagged with the handler, chain and block, and shown on Envio Cloud. So pass
// msg and fields as-is: pre-serialized JSON loses the structure, and warnings
// sent to console.error are reported as errors.

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](msg, { ...fields });
}
