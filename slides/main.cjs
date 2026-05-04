const { app, BrowserWindow, ipcMain, shell, systemPreferences } = require("electron");
const { execFile } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 4317;
const SERVER_HOST = "0.0.0.0";
const REMOTE_CONTACT_TIMEOUT_MS = 30_000;

let mainWindow = null;
let server = null;
let contactStateInterval = null;
let serverState = {
  running: false,
  host: SERVER_HOST,
  port: DEFAULT_PORT,
  localAddresses: [],
  lastCommand: null,
  lastError: null,
  lastRemoteContactAt: null
};

function getLocalAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((networkInterface) => networkInterface && networkInterface.family === "IPv4" && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address);
}

function isAccessibilityTrusted(prompt = false) {
  if (process.platform !== "darwin") {
    return true;
  }

  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

function hasRecentRemoteContact() {
  if (!serverState.lastRemoteContactAt) {
    return false;
  }

  const contactAt = Date.parse(serverState.lastRemoteContactAt);

  if (Number.isNaN(contactAt)) {
    return false;
  }

  return Date.now() - contactAt <= REMOTE_CONTACT_TIMEOUT_MS;
}

function getConnectionState() {
  if (!serverState.running) {
    return "unavailable";
  }

  return hasRecentRemoteContact() ? "connected" : "waiting";
}

function markRemoteContact() {
  serverState = {
    ...serverState,
    lastRemoteContactAt: new Date().toISOString()
  };
  emitState();
}

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(String(stdout || "").trim());
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getActiveSlidesAppName() {
  const applicationName = await runAppleScript(`
    tell application "System Events"
      if exists process "Keynote" then return "Keynote"
      if exists process "Microsoft PowerPoint" then return "Microsoft PowerPoint"
    end tell
    return ""
  `);

  if (!applicationName) {
    throw new Error("Keynote or Microsoft PowerPoint must be running.");
  }

  return applicationName;
}

function getFallbackKeyCodes(applicationName, direction) {
  if (applicationName === "Microsoft PowerPoint") {
    return direction === "next" ? ["124", "125", "49"] : ["123", "126"];
  }

  return direction === "next" ? ["124"] : ["123"];
}

function emitState() {
  serverState = {
    ...serverState,
    localAddresses: getLocalAddresses()
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("slides:state", {
      ...serverState,
      accessibilityTrusted: isAccessibilityTrusted(false),
      connectionState: getConnectionState()
    });
  }
}

async function sendPowerPointCommand(direction) {
  const commandName = direction === "next" ? "next" : "previous";

  await runAppleScript(`
    tell application "Microsoft PowerPoint"
      if slide show windows exists then
        ${commandName} slide show view of slide show window 1
      else
        error "PowerPoint must be in slideshow/presentation mode."
      end if
    end tell
  `);

  return `powerpoint-applescript-${commandName}`;
}

async function sendSlideCommand(direction) {
  const applicationName = await getActiveSlidesAppName();
  const steps = [];

  await runAppleScript(`tell application ${JSON.stringify(applicationName)} to activate`);
  steps.push(`activated ${applicationName}`);
  await delay(500);

  if (applicationName === "Microsoft PowerPoint") {
    try {
      const method = await sendPowerPointCommand(direction);

      steps.push(method);
      return {
        applicationName,
        method,
        steps
      };
    } catch (error) {
      steps.push(
        `powerpoint-applescript-failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const keyCodes = getFallbackKeyCodes(applicationName, direction);

  for (const keyCode of keyCodes) {
    await runAppleScript(`tell application "System Events" to key code ${keyCode}`);
    steps.push(`key code ${keyCode} sent`);
    await delay(80);
  }

  return {
    applicationName,
    method: "system-events-keyboard",
    steps
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(body));
}

async function handleSlideCommand(command, response) {
  const receivedAt = new Date().toISOString();

  markRemoteContact();

  try {
    const commandResult = await sendSlideCommand(command);
    serverState = {
      ...serverState,
      lastCommand: {
        command,
        receivedAt,
        ok: true,
        applicationName: commandResult.applicationName,
        method: commandResult.method,
        steps: commandResult.steps
      },
      lastError: null
    };
    emitState();
    writeJson(response, 200, { ok: true, command, receivedAt, ...commandResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    serverState = {
      ...serverState,
      lastCommand: {
        command,
        receivedAt,
        ok: false,
        applicationName: null,
        method: null,
        steps: []
      },
      lastError: message
    };
    emitState();
    writeJson(response, 500, {
      ok: false,
      command,
      error: message,
      accessibilityTrusted: isAccessibilityTrusted(false)
    });
  }
}

function createServer() {
  return http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      markRemoteContact();
      writeJson(response, 200, {
        ok: true,
        app: "MSTV Slides Receiver",
        running: serverState.running,
        connectionState: getConnectionState(),
        host: serverState.host,
        port: serverState.port,
        localAddresses: serverState.localAddresses,
        lastRemoteContactAt: serverState.lastRemoteContactAt,
        accessibilityTrusted: isAccessibilityTrusted(false),
        lastCommand: serverState.lastCommand
      });
      return;
    }

    if (request.method === "POST" && request.url === "/next") {
      void handleSlideCommand("next", response);
      return;
    }

    if (request.method === "POST" && request.url === "/prev") {
      void handleSlideCommand("prev", response);
      return;
    }

    writeJson(response, 404, {
      ok: false,
      error: "Not found. Use GET /health, POST /next, or POST /prev."
    });
  });
}

function startServer(port = DEFAULT_PORT) {
  if (server) {
    return Promise.resolve(serverState);
  }

  return new Promise((resolve, reject) => {
    const nextServer = createServer();

    nextServer.on("error", (error) => {
      serverState = {
        ...serverState,
        running: false,
        lastError: error instanceof Error ? error.message : String(error)
      };
      emitState();
      reject(error);
    });

    nextServer.listen(port, SERVER_HOST, () => {
      server = nextServer;
      serverState = {
        ...serverState,
        running: true,
        host: SERVER_HOST,
        port,
        localAddresses: getLocalAddresses(),
        lastError: null,
        lastRemoteContactAt: null
      };
      emitState();
      resolve(serverState);
    });
  });
}

function stopServer() {
  if (!server) {
    serverState = {
      ...serverState,
      running: false,
      lastRemoteContactAt: null
    };
    emitState();
    return Promise.resolve(serverState);
  }

  return new Promise((resolve) => {
    server.close(() => {
      server = null;
      serverState = {
        ...serverState,
        running: false,
        lastRemoteContactAt: null
      };
      emitState();
      resolve(serverState);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 240,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreen: false,
    fullscreenable: false,
    center: true,
    title: "MSTV Slides Receiver",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    emitState();
  });
}

app.whenReady().then(() => {
  ipcMain.handle("slides:get-state", () => ({
    ...serverState,
    localAddresses: getLocalAddresses(),
    accessibilityTrusted: isAccessibilityTrusted(false),
    connectionState: getConnectionState()
  }));
  ipcMain.handle("slides:start", async (_event, port) => startServer(Number(port) || DEFAULT_PORT));
  ipcMain.handle("slides:stop", async () => stopServer());
  ipcMain.handle("slides:request-accessibility", () => isAccessibilityTrusted(true));
  ipcMain.handle("slides:open-accessibility-settings", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  );

  createWindow();
  contactStateInterval = setInterval(emitState, 1000);
  void startServer(DEFAULT_PORT).catch(() => undefined);
});

app.on("before-quit", () => {
  if (contactStateInterval) {
    clearInterval(contactStateInterval);
    contactStateInterval = null;
  }
  void stopServer();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
