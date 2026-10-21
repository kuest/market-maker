import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vendor = join(root, "vendor/ts-sdk");
if (existsSync(join(vendor, "package.json"))) {
  const result = spawnSync("pnpm", ["build"], { cwd: vendor, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
