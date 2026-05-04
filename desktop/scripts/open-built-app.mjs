import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const candidates = [
  path.join(projectRoot, "dist", "mac-arm64", "MSTV Visio.app"),
  path.join(projectRoot, "dist", "mac", "MSTV Visio.app")
];
const appPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!appPath) {
  console.error("MSTV Visio.app was not found. Run npm run desktop:build first.");
  process.exit(1);
}

const openProcess = spawn("open", ["-n", appPath], {
  stdio: "inherit"
});

openProcess.on("exit", (code) => {
  process.exit(code ?? 0);
});
