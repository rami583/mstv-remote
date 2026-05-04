import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const port = Number(process.env.MSTV_DESKTOP_PORT || 3100);
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const nextBin = path.join(projectRoot, "node_modules/next/dist/bin/next");
const electronBin = path.join(projectRoot, "node_modules/.bin/electron");
const envFilePath = path.join(projectRoot, ".env.local");
const requiredKeys = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
const desktopConfigKeys = [
  "GUEST_PUBLIC_BASE_URL",
  "MSTV_DESKTOP_ROOM",
  "MSTV_DESKTOP_URL",
  "MSTV_DESKTOP_PORT"
];
const knownEnvKeys = [...requiredKeys, ...desktopConfigKeys];

function parseEnvFile(contents) {
  const values = {};

  const normalizedContents = contents.replace(
    new RegExp(`([^\\r\\n])(${knownEnvKeys.join("|")}=)`, "g"),
    "$1\n$2"
  );

  for (const line of normalizedContents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf("=");

    if (equalsIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    let value = normalized.slice(equalsIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function loadDevEnvironment() {
  if (!fs.existsSync(envFilePath)) {
    console.log(`[desktop] .env.local not found at ${envFilePath}`);
    return {};
  }

  const values = parseEnvFile(fs.readFileSync(envFilePath, "utf8"));
  const mergedEnv = { ...process.env };

  for (const [key, value] of Object.entries(values)) {
    if (mergedEnv[key] === undefined) {
      mergedEnv[key] = value;
    }
  }

  console.log(`[desktop] loaded .env.local from ${envFilePath}`);
  console.log(`[desktop] parsed env keys: ${Object.keys(values).join(", ") || "none"}`);
  console.log(
    `[desktop] GUEST_PUBLIC_BASE_URL present: ${Boolean(mergedEnv.GUEST_PUBLIC_BASE_URL)}`
  );
  console.log(
    `[desktop] required env present: ${requiredKeys.filter((key) => Boolean(mergedEnv[key])).join(", ") || "none"}`
  );
  console.log(
    `[desktop] required env missing: ${requiredKeys.filter((key) => !mergedEnv[key]).join(", ") || "none"}`
  );

  return mergedEnv;
}

function waitForServer(url, timeoutMs = 45_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(attempt, 300);
      });
    };

    attempt();
  });
}

const desktopEnv = loadDevEnvironment();

const nextProcess = spawn(process.execPath, [nextBin, "dev", "-H", host, "-p", String(port)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...desktopEnv,
    PORT: String(port)
  }
});

let electronProcess;

try {
  await waitForServer(baseUrl);
  electronProcess = spawn(electronBin, [projectRoot], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...desktopEnv,
      MSTV_DESKTOP_URL: baseUrl,
      MSTV_DESKTOP_PORT: String(port)
    }
  });
} catch (error) {
  console.error(error);
  nextProcess.kill();
  process.exit(1);
}

function shutdown() {
  electronProcess?.kill();
  nextProcess.kill();
}

nextProcess.on("exit", (code) => {
  electronProcess?.kill();
  process.exit(code ?? 0);
});

electronProcess?.on("exit", (code) => {
  nextProcess.kill();
  process.exit(code ?? 0);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
