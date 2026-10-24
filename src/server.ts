import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createAnthropicProvider } from "./ai/anthropic.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectPglite, connectPostgres } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { runNightlyIfDue } from "./demo.js";
import { reconcilePayouts } from "./grants/payout-guard.js";
import { log } from "./http/log.js";
import { availableBalanceCents } from "./paypal/balances.js";
import { createPayPalClient } from "./paypal/client.js";

const PAGES: Record<string, string> = {
  "/": "/index.html",
  "/donate": "/donate.html",
  "/request": "/request.html",
  "/review": "/review.html",
  "/ledger": "/ledger.html",
  "/status": "/status.html",
};

async function main() {
  const config = loadConfig();
  const db = config.DATABASE_URL
    ? await connectPostgres(config.DATABASE_URL)
    : await connectPglite(".pglite");
  await migrate(db);

  const pp = createPayPalClient({
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
  const provider = config.ANTHROPIC_API_KEY
    ? createAnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL })
    : null;

  const app = createApp({ db, pp, provider, config });
  const webRoot = new URL("./web", import.meta.url).pathname;
  app.use("/*", serveStatic({ root: webRoot, rewriteRequestPath: (p) => PAGES[p] ?? p }));
  app.notFound((c) => c.text("Not found", 404));

  // Backstop for missed or late webhooks.
  setInterval(() => {
    reconcilePayouts(db, pp).catch(() => log.warn("payout.reconcile_failed"));
  }, 60_000).unref();

  if (config.DEMO_NIGHTLY_RESET === "1") {
    // Public demo: once per Hawaii day, restore seeded data and check the sandbox balance.
    const nightly = () =>
      runNightlyIfDue({
        db,
        balanceCents: () => availableBalanceCents(pp),
        warn: (msg, f) => log.warn(msg, f),
      })
        .then((did) => did && log.info("demo.reset"))
        .catch(() => log.error("demo.reset_failed"));
    setTimeout(nightly, 5_000).unref();
    setInterval(nightly, 10 * 60_000).unref();
  }

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info("server.started", {
      path: `:${info.port}`,
      model: provider?.model ?? "none",
      status: config.DATABASE_URL ? "postgres" : "pglite",
    });
  });
}

main().catch((err: Error) => {
  // Config errors list variable names only, never values.
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
