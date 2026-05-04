const { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell, systemPreferences } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_ROOM = "studio";
const DEFAULT_PORT = 3100;
const SERVER_HOST = "127.0.0.1";
const REQUIRED_ENV_KEYS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
const CONTROL_TILE_WIDTH = 507;
const CONTROL_TILE_GAP = 16;
const CONTROL_PAGE_HORIZONTAL_PADDING = 64;
const CONTROL_WINDOW_WIDTH = CONTROL_TILE_WIDTH * 3 + CONTROL_TILE_GAP * 2 + CONTROL_PAGE_HORIZONTAL_PADDING;
const SLIDE_RECEIVER_TIMEOUT_MS = 10_000;

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
  return process.env.MSTV_DESKTOP_URL || `http://${SERVER_HOST}:${getDesktopPort()}`;
}

function getDesktopPort() {
  return Number(process.env.MSTV_DESKTOP_PORT || process.env.PORT || DEFAULT_PORT);
}

function getDesktopRoom() {
  return process.env.MSTV_DESKTOP_ROOM || DEFAULT_ROOM;
}

function sanitizeRoomSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || DEFAULT_ROOM;
}

function buildRouteUrl(route, roomSlug) {
  const room = encodeURIComponent(sanitizeRoomSlug(roomSlug || getDesktopRoom()));
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
  log("Desktop runtime config", {
    roomSlug: getDesktopRoom(),
    publicGuestBaseUrl: process.env.GUEST_PUBLIC_BASE_URL || null,
    desktopUrl: process.env.MSTV_DESKTOP_URL || null,
    port: getDesktopPort()
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
  const port = getDesktopPort();
  log("Starting bundled Next server", { serverPath, port });

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: SERVER_HOST,
      PORT: String(port)
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
  if (process.platform === "darwin") {
    for (const mediaType of ["camera", "microphone"]) {
      try {
        const status = systemPreferences.getMediaAccessStatus(mediaType);
        log("macOS media permission status", {
          mediaType,
          status,
          requestTiming:
            status === "not-determined" ? "requested when a studio input opens" : "already decided"
        });
      } catch (error) {
        log("macOS media permission check failed", {
          mediaType,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log("Electron permission request", { permission });
    callback(["media", "camera", "microphone"].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ["media", "camera", "microphone"].includes(permission);
    log("Electron permission check", { permission, allowed });
    return allowed;
  });
}

function describeDisplay(display) {
  return {
    id: display.id,
    label: display.label || null,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    internal: display.internal
  };
}

function buildDisplayOptions() {
  const primaryDisplay = screen.getPrimaryDisplay();

  return screen.getAllDisplays().map((display, index) => {
    const isPrimary = display.id === primaryDisplay.id;
    const readableLabel =
      display.label ||
      (isPrimary
        ? "Primary display"
        : display.internal
          ? `Internal display ${index + 1}`
          : `External display ${index + 1}`);

    return {
      id: display.id,
      label: `${readableLabel}${isPrimary ? " (Primary)" : ""}`,
      isPrimary,
      bounds: display.bounds,
      workArea: display.workArea,
      internal: display.internal
    };
  });
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
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    log(`${label} renderer console`, {
      level,
      message,
      line,
      sourceId
    });
  });

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

  window.webContents.once("did-finish-load", () => {
    log(`${label} finished loading`, { url });
  });

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
  const fixedWidth = Math.min(CONTROL_WINDOW_WIDTH, primaryDisplay.workArea.width);
  const bounds = centeredBounds(primaryDisplay, fixedWidth, 900);

  controlWindow = new BrowserWindow({
    ...bounds,
    minWidth: fixedWidth,
    maxWidth: fixedWidth,
    minHeight: 720,
    title: "MSTV Remote",
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
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

async function createProgramWindow(displayId, roomSlug) {
  if (programWindow && !programWindow.isDestroyed()) {
    log("Program window already open; focusing existing window");
    programWindow.show();
    programWindow.focus();
    return programWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  const targetDisplay =
    displays.find((display) => String(display.id) === String(displayId)) || primaryDisplay;
  const bounds = targetDisplay.bounds;

  programWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    fullscreen: true,
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
    fullscreen: true,
    frame: false,
    displayId: targetDisplay.id
  });
  programWindow.setMenuBarVisibility(false);
  programWindow.on("closed", () => {
    log("Program window closed");
    programWindow = null;
  });
  programWindow.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();

    if ((input.meta || input.control) && key === "f") {
      event.preventDefault();
      programWindow?.setFullScreen(!programWindow.isFullScreen());
    }

    if (key === "escape") {
      event.preventDefault();
      closeProgramWindow();
    }
  });
  programWindow.once("ready-to-show", () => {
    programWindow?.show();
  });

  await loadWindow(programWindow, "Program", buildRouteUrl("program", roomSlug));
  programWindow.setBounds(bounds);
  programWindow.setFullScreen(true);
  programWindow.show();

  return programWindow;
}

function closeProgramWindow() {
  if (!programWindow || programWindow.isDestroyed()) {
    programWindow = null;
    return false;
  }

  programWindow.close();
  programWindow = null;
  return true;
}

function getProgramWindowState() {
  return {
    isOpen: Boolean(programWindow && !programWindow.isDestroyed())
  };
}

function buildSlideReceiverUrl(input) {
  const rawHost = String(input?.host || "").trim();
  const rawPort = String(input?.port || "4317").trim() || "4317";
  const action = input?.command === "PREV_SLIDE" ? "prev" : "next";

  if (!rawHost) {
    throw new Error("Slide receiver host is not configured.");
  }

  const base = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  const url = new URL(base);

  if (!url.port && rawPort) {
    url.port = rawPort;
  }

  url.pathname = `/${action}`;
  url.search = "";
  url.hash = "";

  return url;
}

function parseJsonIfPossible(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function postSlideReceiverCommand(input) {
  const url = buildSlideReceiverUrl(input);
  const urlString = url.toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, SLIDE_RECEIVER_TIMEOUT_MS);

  log("Sending slide receiver command", {
    url: urlString,
    method: "POST",
    command: input?.command,
    timeoutMs: SLIDE_RECEIVER_TIMEOUT_MS
  });

  try {
    const response = await fetch(urlString, {
      method: "POST",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const responseBody = await response.text();
    const jsonBody = parseJsonIfPossible(responseBody);

    log("Slide receiver response", {
      url: urlString,
      method: "POST",
      statusCode: response.status,
      ok: response.ok,
      body: responseBody
    });

    if (!response.ok) {
      throw new Error(`Slide receiver responded with HTTP ${response.status}: ${responseBody}`);
    }

    if (!jsonBody || jsonBody.ok !== true || (jsonBody.accepted !== true && jsonBody.accepted !== undefined)) {
      throw new Error(`Slide receiver returned an invalid response: ${responseBody || "empty body"}`);
    }

    return {
      ok: true,
      statusCode: response.status,
      url: urlString,
      body: jsonBody
    };
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    const message = isAbortError
      ? `Slide receiver did not respond within ${SLIDE_RECEIVER_TIMEOUT_MS}ms.`
      : error instanceof Error
        ? error.message
        : String(error);

    log("Slide receiver request error", {
      url: urlString,
      method: "POST",
      command: input?.command,
      message
    });

    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

function configureDesktopIpc() {
  ipcMain.handle("mstv:get-program-displays", () => ({
    displays: buildDisplayOptions(),
    programWindow: getProgramWindowState()
  }));

  ipcMain.handle("mstv:toggle-program-window", async (_event, displayId, roomSlug) => {
    if (programWindow && !programWindow.isDestroyed()) {
      closeProgramWindow();
      return {
        displays: buildDisplayOptions(),
        programWindow: getProgramWindowState()
      };
    }

    await createProgramWindow(displayId, roomSlug);

    return {
      displays: buildDisplayOptions(),
      programWindow: getProgramWindowState()
    };
  });

  ipcMain.handle("mstv:write-clipboard-text", (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });

  ipcMain.handle("mstv:send-slide-command", async (_event, input) => {
    try {
      return await postSlideReceiverCommand(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      log("Slide receiver command failed", {
        command: input?.command,
        message
      });

      throw error;
    }
  });
}

async function createWindows() {
  loadDesktopEnvironment();
  logDisplays();
  startBundledNextServer();
  log("Waiting for Next server", { url: getBaseUrl() });
  await waitForServer(getBaseUrl());
  log("Next server is reachable", { url: getBaseUrl() });
  await createControlWindow();
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
  configureDesktopIpc();
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
