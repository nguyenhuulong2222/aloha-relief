// Bundles the server and the browser modules, and copies static assets into dist/.
import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/web/js", { recursive: true });

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
await cp("src/db/schema.sql", "dist/schema.sql");

await build({
  entryPoints: ["web/js/*.ts"],
  outdir: "dist/web/js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
});
await cp("web", "dist/web", {
  recursive: true,
  filter: (src) => !src.endsWith(".ts"),
});
await mkdir("dist/web/fonts", { recursive: true });
for (const f of [
  "latin-400-normal",
  "latin-700-normal",
  "latin-ext-400-normal",
  "latin-ext-700-normal",
]) {
  await cp(
    `node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-${f}.woff2`,
    `dist/web/fonts/atkinson-${f}.woff2`,
  );
}
console.log("built dist/");
