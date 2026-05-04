import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const electronBin = path.join(projectRoot, "node_modules/.bin/electron");
const mainPath = path.join(projectRoot, "slides/main.cjs");

const electronProcess = spawn(electronBin, [mainPath], {
  cwd: projectRoot,
  stdio: "inherit"
});

electronProcess.on("exit", (code) => {
  process.exit(code ?? 0);
});
