const { app, BrowserWindow, dialog, screen, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_ROOM = process.env.MSTV_DESKTOP_ROOM || "studio";
const DEFAULT_PORT = Number(process.env.MSTV_DESKTOP_PORT || process.env.PORT || 3100);
const SERVER_HOST = "127.0.0.1";
const REQUIRED_ENV_KEYS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];

let nextServerProcess = null;
let controlWindow = null;
let programWindow = null;
let logFilePath = null;

function log(message, details) {
  const line = `[${new Date().toISOString()}] ${message}${
    details === undefined ? "" : ` ${JSON.stringify(details)}`
  }\n`;

  console.log(line.trimEnd());

  try {
    if (!logFilePath) {
      logFilePath = path.join(app.getPath("userData"), "desktop.log");
    }

    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line);
  } catch {
    // Logging should never prevent the operator UI from opening.
  }
}

function getBaseUrl() {
  return process.env.MSTV_DESKTOP_URL || `http://${SERVER_HOST}:${DEFAULT_PORT}`;
}

function buildRouteUrl(route) {
  const room = encodeURIComponent(DEFAULT_ROOM);
  return `${getBaseUrl()}/${route}/${room}`;
}

function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
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

function findAncestorEnvFiles(startPath) {
  const files = [];
  let currentPath = startPath;

  while (currentPath && currentPath !== path.dirname(currentPath)) {
    files.push(path.join(currentPath, ".env.local"));
    currentPath = path.dirname(currentPath);
  }

  return files;
}

function getDesktopEnvCandidates() {
  const explicitEnvFile = process.env.MSTV_DESKTOP_ENV_FILE;
  const candidates = [];

  if (explicitEnvFile) {
    candidates.push(explicitEnvFile);
  }

  if (app.isPackaged) {
    candidates.push(
      path.join(app.getPath("userData"), ".env.local"),
      path.join(app.getPath("home"), ".mstv-remote", ".env.local"),
      ...findAncestorEnvFiles(process.resourcesPath)
    );
  } else {
    candidates.push(path.join(process.cwd(), ".env.local"));
  }

  return [...new Set(candidates)];
}

function loadDesktopEnvironment() {
  const candidates = getDesktopEnvCandidates();
  const loadedFiles = [];
  const missingFiles = [];

  for (const envFilePath of candidates) {
    if (!envFilePath) {
      continue;
    }

    if (!fs.existsSync(envFilePath)) {
      missingFiles.push(envFilePath);
      continue;
    }

    const values = parseEnvFile(fs.readFileSync(envFilePath, "utf8"));
    const loadedKeys = [];

    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loadedKeys.push(key);
      }
    }

    loadedFiles.push({
      path: envFilePath,
      keys: loadedKeys
    });
  }

  log("Desktop env file lookup", {
    found: loadedFiles.map((file) => ({
      path: file.path,
      loadedKeys: file.keys
    })),
    missing: missingFiles
  });

  log("Desktop required env status", {
    present: REQUIRED_ENV_KEYS.filter((key) => Boolean(process.env[key])),
    missing: REQUIRED_ENV_KEYS.filter((key) => !process.env[key])
  });
}

function waitForServer(url, timeoutMs = 30_000) {
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

        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

function startBundledNextServer() {
  if (!app.isPackaged || process.env.MSTV_DESKTOP_URL) {
    log("Using external Next server", { url: getBaseUrl() });
    return;
  }

  const serverPath = path.join(process.resourcesPath, "next-standalone", "server.js");
  log("Starting bundled Next server", { serverPath, port: DEFAULT_PORT });

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: SERVER_HOST,
      PORT: String(DEFAULT_PORT)
    },
    stdio: "pipe"
  });

  nextServerProcess.stdout?.on("data", (data) => {
    log("Next server stdout", { data: String(data).trim() });
  });

  nextServerProcess.stderr?.on("data", (data) => {
    log("Next server stderr", { data: String(data).trim() });
  });

  nextServerProcess.on("error", (error) => {
    log("Next server process error", { message: error.message });
  });

  nextServerProcess.on("exit", (code, signal) => {
    log("Next server exited", { code, signal });
  });

  nextServerProcess.unref();
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "camera", "microphone"].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ["media", "camera", "microphone"].includes(permission)
  );
}

function describeDisplay(display) {
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    internal: display.internal
  };
}

function logDisplays() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().map(describeDisplay);
  log("Detected displays", {
    primaryDisplayId: primaryDisplay.id,
    displays
  });
}

function centeredBounds(display, desiredWidth, desiredHeight, offset = { x: 0, y: 0 }) {
  const { x, y, width, height } = display.workArea;
  const boundedWidth = Math.min(desiredWidth, width);
  const boundedHeight = Math.min(desiredHeight, height);
  const centeredX = x + Math.round((width - boundedWidth) / 2) + offset.x;
  const centeredY = y + Math.round((height - boundedHeight) / 2) + offset.y;
  const maxX = x + width - boundedWidth;
  const maxY = y + height - boundedHeight;

  return {
    x: Math.max(x, Math.min(centeredX, maxX)),
    y: Math.max(y, Math.min(centeredY, maxY)),
    width: boundedWidth,
    height: boundedHeight
  };
}

function attachLoadFailureHandling(window, label, url) {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log(`${label} failed to load`, {
      errorCode,
      errorDescription,
      url: validatedURL || url
    });

    window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>MSTV Remote</title>
            <style>
              body {
                align-items: center;
                background: #050505;
                color: #fff;
                display: flex;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                height: 100vh;
                justify-content: center;
                margin: 0;
              }
              main {
                max-width: 680px;
                padding: 48px;
              }
              h1 {
                font-size: 28px;
                margin: 0 0 16px;
              }
              p {
                color: #d6d6d6;
                font-size: 16px;
                line-height: 1.5;
              }
              code {
                color: #fff;
                overflow-wrap: anywhere;
              }
            </style>
          </head>
          <body>
            <main>
              <h1>Impossible d'ouvrir ${label}</h1>
              <p>La fenêtre native est visible, mais la page n'a pas pu se charger.</p>
              <p><code>${url}</code></p>
              <p>${errorDescription}</p>
            </main>
          </body>
        </html>
      `)}`
    );
  });
}

async function loadWindow(window, label, url) {
  attachLoadFailureHandling(window, label, url);
  log(`${label} loading URL`, { url });

  try {
    await window.loadURL(url);
  } catch (error) {
    log(`${label} loadURL rejected`, {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function createControlWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = centeredBounds(primaryDisplay, 1400, 900);

  controlWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 720,
    title: "MSTV Remote",
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  log("Control window bounds", bounds);
  controlWindow.setMenuBarVisibility(false);
  controlWindow.once("ready-to-show", () => {
    controlWindow?.show();
    controlWindow?.focus();
    controlWindow?.moveTop();
  });

  await loadWindow(controlWindow, "Control", buildRouteUrl("control"));

  controlWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function createProgramWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const externalDisplay = screen
    .getAllDisplays()
    .find((display) => display.id !== primaryDisplay.id);
  const targetDisplay = externalDisplay || primaryDisplay;
  const bounds = externalDisplay
    ? targetDisplay.bounds
    : centeredBounds(primaryDisplay, 1280, 720, { x: 56, y: 56 });

  programWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    fullscreen: Boolean(externalDisplay),
    autoHideMenuBar: true,
    title: "MSTV Remote Program",
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  log("Program window bounds", {
    ...bounds,
    fullscreen: Boolean(externalDisplay),
    displayId: targetDisplay.id
  });
  programWindow.setMenuBarVisibility(false);
  programWindow.once("ready-to-show", () => {
    programWindow?.show();
  });

  await loadWindow(programWindow, "Program", buildRouteUrl("program"));
}

async function createWindows() {
  loadDesktopEnvironment();
  logDisplays();
  startBundledNextServer();
  log("Waiting for Next server", { url: getBaseUrl() });
  await waitForServer(getBaseUrl());
  log("Next server is reachable", { url: getBaseUrl() });
  await createControlWindow();
  await createProgramWindow();
  controlWindow?.show();
  controlWindow?.focus();
  controlWindow?.moveTop();
}

function showStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  log("Desktop startup failed", { message });

  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = centeredBounds(primaryDisplay, 900, 520);
  const errorWindow = new BrowserWindow({
    ...bounds,
    title: "MSTV Remote",
    backgroundColor: "#050505",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  errorWindow.setMenuBarVisibility(false);
  errorWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>MSTV Remote</title>
          <style>
            body {
              align-items: center;
              background: #050505;
              color: #fff;
              display: flex;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              height: 100vh;
              justify-content: center;
              margin: 0;
            }
            main {
              max-width: 680px;
              padding: 48px;
            }
            h1 {
              font-size: 28px;
              margin: 0 0 16px;
            }
            p {
              color: #d6d6d6;
              font-size: 16px;
              line-height: 1.5;
            }
            code {
              background: rgba(255,255,255,.1);
              border-radius: 6px;
              display: inline-block;
              padding: 4px 6px;
            }
          </style>
        </head>
        <body>
          <main>
            <h1>MSTV Remote n'a pas pu démarrer</h1>
            <p>La fenêtre native s'ouvre correctement, mais le serveur local de l'application n'est pas disponible.</p>
            <p><code>${message}</code></p>
            <p>Journal: <code>${logFilePath || ""}</code></p>
          </main>
        </body>
      </html>
    `)}`
  );

  dialog.showErrorBox("MSTV Remote", message);
}

app.name = "MSTV Remote";
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(async () => {
  configurePermissions();
  try {
    await createWindows();
  } catch (error) {
    showStartupError(error);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindows().catch(showStartupError);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  nextServerProcess?.kill();
});
