import type { TriageResult } from "./schema.js";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderOutcome =
  | { ok: true; result: TriageResult; usage: ProviderUsage; model: string }
  | { ok: false; reason: string; usage: ProviderUsage; model: string };

/** Any model vendor can sit behind this. It returns a validated result or a reason; it never throws. */
export interface TriageProvider {
  readonly model: string;
  triage(system: string, user: string): Promise<ProviderOutcome>;
  /** USD for the given usage. */
  cost(usage: ProviderUsage): number;
}
