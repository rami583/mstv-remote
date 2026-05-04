import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const candidates = [
  path.join(projectRoot, "dist-slides", "mac-arm64", "MSTV Slides Receiver.app"),
  path.join(projectRoot, "dist-slides", "mac", "MSTV Slides Receiver.app")
];
const appPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!appPath) {
  console.error("MSTV Slides Receiver.app was not found. Run npm run slides:build first.");
  process.exit(1);
}

const openProcess = spawn("open", ["-n", appPath], {
  stdio: "inherit"
});

openProcess.on("exit", (code) => {
  process.exit(code ?? 0);
});
