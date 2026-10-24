import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PAYPAL_ENV: z.enum(["sandbox"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(10),
  PAYPAL_CLIENT_SECRET: z.string().min(10),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-haiku-5-5"),
  AI_DAILY_CAP_USD: z.coerce.number().nonnegative().default(0.5),
  AI_TOTAL_CAP_USD: z.coerce.number().nonnegative().default(4),
  DATABASE_URL: z.string().optional(),
  REVIEWER_PASSCODE: z.string().min(6),
  SESSION_SECRET: z.string().min(32),
  HASH_SALT: z.string().min(16),
  // Public-demo safety: anyone with the published passcode can approve sandbox payouts.
  DAILY_PAYOUT_CAP_CENTS: z.coerce.number().int().positive().default(50_000),
  PER_GRANT_CAP_CENTS: z.coerce.number().int().positive().default(40_000),
  DEMO_NIGHTLY_RESET: z.enum(["0", "1"]).default("0"),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parses env vars. On failure, reports only the names of bad variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid or missing environment variables: ${names.join(", ")}`);
  }
  return parsed.data;
}
