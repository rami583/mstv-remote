import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const standaloneDir = path.join(projectRoot, ".next", "standalone");

async function copyIfExists(from, to) {
  try {
    await fs.access(from);
  } catch {
    return;
  }

  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

await copyIfExists(
  path.join(projectRoot, ".next", "static"),
  path.join(standaloneDir, ".next", "static")
);
await copyIfExists(path.join(projectRoot, "public"), path.join(standaloneDir, "public"));
