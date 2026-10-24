/**
 * Structured logger with an allowlist of fields. Request bodies, emails, descriptions,
 * tokens and secrets are never logged: anything not in SAFE_KEYS is dropped.
 */
const SAFE_KEYS = new Set([
  "ref",
  "status",
  "event",
  "eventType",
  "rule",
  "outcome",
  "code",
  "debugId",
  "httpStatus",
  "ms",
  "path",
  "method",
  "count",
  "costUsd",
  "model",
  "reason",
]);

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: "info" | "warn" | "error", msg: string, fields: Fields = {}) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const safe: Fields = {};
  for (const [k, v] of Object.entries(fields)) if (SAFE_KEYS.has(k)) safe[k] = v;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, f?: Fields) => emit("info", msg, f),
  warn: (msg: string, f?: Fields) => emit("warn", msg, f),
  error: (msg: string, f?: Fields) => emit("error", msg, f),
};
