/**
 * Creates (or updates) the Render free web service from Keychain secrets without printing them.
 * Render API: https://api-docs.render.com/reference/create-service  (POST /v1/services)
 *             env vars: PUT /v1/services/{id}/env-vars (replaces the full list)
 * Usage: RENDER_API_KEY=... RENDER_OWNER_ID=... npx tsx scripts/deploy-render.ts   (values via env, see scripts/render.sh)
 */
const API = "https://api.render.com/v1";
const key = process.env.RENDER_API_KEY;
if (!key) throw new Error("RENDER_API_KEY missing");

async function render<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Render ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  return (text ? JSON.parse(text) : {}) as T;
}

const NAME = "aloha-relief";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
};

const owners = await render<Array<{ owner: { id: string; name: string } }>>("/owners?limit=20");
const ownerId = process.env.RENDER_OWNER_ID || owners[0]?.owner.id;
if (!ownerId) throw new Error("No Render workspace found");

const services = await render<
  Array<{ service: { id: string; name: string; serviceDetails?: { url?: string } } }>
>(`/services?name=${NAME}&limit=20`);
let service = services.find((s) => s.service.name === NAME)?.service;

const envVars = [
  { key: "NODE_ENV", value: "production" },
  { key: "PAYPAL_ENV", value: "sandbox" },
  { key: "AI_MODEL", value: "claude-haiku-5-5" },
  { key: "DEMO_NIGHTLY_RESET", value: "1" },
  { key: "PAYPAL_CLIENT_ID", value: env("PAYPAL_CLIENT_ID") },
  { key: "PAYPAL_CLIENT_SECRET", value: env("PAYPAL_CLIENT_SECRET") },
  { key: "ANTHROPIC_API_KEY", value: env("ANTHROPIC_API_KEY") },
  { key: "DATABASE_URL", value: env("DATABASE_URL") },
  { key: "REVIEWER_PASSCODE", value: env("REVIEWER_PASSCODE") },
  { key: "SESSION_SECRET", value: env("SESSION_SECRET") },
  { key: "HASH_SALT", value: env("HASH_SALT") },
  ...(process.env.PAYPAL_WEBHOOK_ID
    ? [{ key: "PAYPAL_WEBHOOK_ID", value: process.env.PAYPAL_WEBHOOK_ID }]
    : []),
  ...(process.env.PUBLIC_BASE_URL
    ? [{ key: "PUBLIC_BASE_URL", value: process.env.PUBLIC_BASE_URL }]
    : []),
];

if (!service) {
  const created = await render<{ service: { id: string; serviceDetails?: { url?: string } } }>(
    "/services",
    {
      method: "POST",
      body: JSON.stringify({
        type: "web_service",
        name: NAME,
        ownerId,
        repo: "https://github.com/nguyenhuulong2222/aloha-relief",
        branch: "main",
        autoDeployTrigger: "commit",
        envVars,
        serviceDetails: {
          runtime: "node",
          plan: "free",
          region: "oregon",
          healthCheckPath: "/health",
          numInstances: 1,
          envSpecificDetails: {
            buildCommand: "npm ci --include=dev && npm run build",
            startCommand: "node --enable-source-maps dist/server.js",
          },
        },
      }),
    },
  );
  service = { id: created.service.id, name: NAME, serviceDetails: created.service.serviceDetails };
  console.log(`created service ${service.id}`);
} else {
  await render(`/services/${service.id}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(envVars),
  });
  await render(`/services/${service.id}/deploys`, { method: "POST", body: JSON.stringify({}) });
  console.log(`updated env vars and triggered deploy for ${service.id}`);
}
console.log(`url ${service.serviceDetails?.url ?? "(pending)"}`);
