/**
 * Claude provider. Structured outputs via output_config.format + messages.parse/zodOutputFormat.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs  (model: claude-haiku-5-5)
 * Pricing (prompts <= 100K tokens): $0.10 / MTok input, $0.50 / MTok output (thinking counts as output).
 * https://platform.claude.com/docs/en/about-claude/models/overview
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ProviderOutcome, ProviderUsage, TriageProvider } from "./provider.js";
import { TriageSchema } from "./schema.js";

const PRICE_IN_PER_TOKEN = 0.1 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 0.5 / 1_000_000;

export function createAnthropicProvider(opts: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): TriageProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 20_000,
    maxRetries: 1,
  });
  const zero: ProviderUsage = { inputTokens: 0, outputTokens: 0 };

  return {
    model: opts.model,
    cost: (u) => u.inputTokens * PRICE_IN_PER_TOKEN + u.outputTokens * PRICE_OUT_PER_TOKEN,
    async triage(system, user): Promise<ProviderOutcome> {
      try {
        const res = await client.messages.parse({
          model: opts.model,
          max_tokens: 4000, // room for adaptive thinking plus ~400 tokens of JSON
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low", format: zodOutputFormat(TriageSchema) },
        });
        const usage = {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        };
        if (res.stop_reason === "refusal")
          return { ok: false, reason: "refusal", usage, model: opts.model };
        if (res.stop_reason === "max_tokens")
          return { ok: false, reason: "max_tokens", usage, model: opts.model };
        if (!res.parsed_output)
          return { ok: false, reason: "schema_mismatch", usage, model: opts.model };
        // Re-validate: never trust a helper's parse alone for something a reviewer relies on.
        const checked = TriageSchema.safeParse(res.parsed_output);
        if (!checked.success)
          return { ok: false, reason: "schema_mismatch", usage, model: opts.model };
        return { ok: true, result: checked.data, usage, model: opts.model };
      } catch (err) {
        const reason =
          err instanceof Anthropic.APIConnectionTimeoutError
            ? "timeout"
            : err instanceof Anthropic.RateLimitError
              ? "rate_limited"
              : err instanceof Anthropic.APIError
                ? `api_error_${err.status ?? "unknown"}`
                : "parse_error";
        return { ok: false, reason, usage: zero, model: opts.model };
      }
    },
  };
}
