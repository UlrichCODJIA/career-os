import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const examplePath = join(root, ".env.example");
const targetPath = join(root, ".env");
const key = "CAREER_OS_LOCAL_API_TOKEN";
const existing = (await Bun.file(targetPath).exists())
  ? await Bun.file(targetPath).text()
  : await Bun.file(examplePath).text();

const current = new RegExp(`^${key}=(.+)$`, "m").exec(existing)?.[1]?.trim();
if (current) {
  console.log("Local API credential already exists in .env.");
  process.exit(0);
}

const token = randomBytes(48).toString("base64url");
const next = new RegExp(`^${key}=.*$`, "m").test(existing)
  ? existing.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${token}`)
  : `${existing.trimEnd()}\n${key}=${token}\n`;

await Bun.write(targetPath, next);
try {
  await chmod(targetPath, 0o600);
} catch {
  // Windows ACLs and some mounted filesystems do not implement POSIX modes.
}
console.log("Generated a local-only API credential in the ignored .env file.");
