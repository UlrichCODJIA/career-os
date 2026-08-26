import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

await rm(outdir, { force: true, recursive: true });

for (const app of ["api", "web", "worker"] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, "apps", app, "src", "index.ts")],
    outdir: join(outdir, "apps", app),
    target: "bun",
    minify: false,
    sourcemap: "linked",
  });

  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`Failed to build ${app}`);
  }
}

console.log("Built API, web, and worker entry points.");
