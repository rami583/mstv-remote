const { app, BrowserWindow, Menu, ipcMain, shell, systemPreferences } = require("electron");
const { execFile } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 4317;
const SERVER_HOST = "0.0.0.0";
const REMOTE_CONTACT_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_APP = "Microsoft PowerPoint";
const TARGET_APPS = new Set(["Microsoft PowerPoint", "Keynote", "Preview"]);

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
  lastRemoteContactAt: null,
  selectedTargetApp: DEFAULT_TARGET_APP
};

function getLocalAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((networkInterface) => networkInterface && networkInterface.family === "IPv4" && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address);
}

function configureApplicationMenu() {
  const appName = "MSTV Click";

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appName,
        submenu: [
          { role: "about", label: `À propos de ${appName}` },
          { type: "separator" },
          { role: "hide", label: `Masquer ${appName}` },
          { role: "hideOthers", label: "Masquer les autres" },
          { role: "unhide", label: "Tout afficher" },
          { type: "separator" },
          { role: "quit", label: `Quitter ${appName}` }
        ]
      }
    ])
  );
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

function setSelectedTargetApp(value) {
  const nextTargetApp = TARGET_APPS.has(value) ? value : DEFAULT_TARGET_APP;

  serverState = {
    ...serverState,
    selectedTargetApp: nextTargetApp
  };
  emitState();

  return nextTargetApp;
}

function runAppleScript(script, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: timeoutMs }, (error, stdout) => {
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

function getFallbackKeyCodes(applicationName, direction) {
  if (applicationName === "Microsoft PowerPoint") {
    return direction === "next" ? ["124"] : ["123"];
  }

  if (applicationName === "Preview") {
    return direction === "next" ? ["124"] : ["123"];
  }

  return direction === "next" ? ["124"] : ["123"];
}

function getSlideExecutionDiagnostics(commandState) {
  const steps = commandState?.steps ?? [];

  return {
    targetApp: commandState?.applicationName ?? "none",
    appActivated: steps.some((step) => step.startsWith("app-activated:")),
    appleScriptSucceeded: steps.some((step) => step.startsWith("applescript-ok:")),
    appleScriptFailed: steps.some((step) => step.startsWith("applescript-failed:")),
    keyboardFallbackSent: steps.some((step) => step.startsWith("keyboard-sent:")),
    lastExecutionError: serverState.lastError
  };
}

function emitState() {
  serverState = {
    ...serverState,
    localAddresses: getLocalAddresses()
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("slides:state", {
      ...serverState,
      executionDiagnostics: getSlideExecutionDiagnostics(serverState.lastCommand),
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

async function sendKeynoteCommand(direction) {
  const commandName = direction === "next" ? "show next" : "show previous";

  await runAppleScript(`
    tell application "Keynote"
      if playing then
        ${commandName}
      else
        error "Keynote must be in presentation/play mode."
      end if
    end tell
  `);

  return `keynote-applescript-${direction}`;
}

async function sendSlideCommand(direction) {
  const applicationName = serverState.selectedTargetApp || DEFAULT_TARGET_APP;
  const steps = [`target-app:${applicationName}`];

  try {
    await runAppleScript(`tell application ${JSON.stringify(applicationName)} to activate`, 1200);
    steps.push(`app-activated:${applicationName}`);
  } catch (error) {
    steps.push(`app-activation-failed:${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await delay(150);

  if (applicationName === "Microsoft PowerPoint") {
    try {
      const method = await sendPowerPointCommand(direction);

      steps.push(`applescript-ok:${method}`);
      return {
        applicationName,
        method,
        steps
      };
    } catch (error) {
      steps.push(
        `applescript-failed:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (applicationName === "Keynote") {
    try {
      const method = await sendKeynoteCommand(direction);

      steps.push(`applescript-ok:${method}`);
      return {
        applicationName,
        method,
        steps
      };
    } catch (error) {
      steps.push(
        `applescript-failed:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const keyCodes = getFallbackKeyCodes(applicationName, direction);
  const [keyCode] = keyCodes;

  if (keyCode) {
    await runAppleScript(`tell application "System Events" to key code ${keyCode}`);
    steps.push(`keyboard-sent:key-code-${keyCode}`);
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

function executeSlideCommand(command, receivedAt) {
  void sendSlideCommand(command)
    .then((commandResult) => {
      serverState = {
        ...serverState,
        lastCommand: {
          command,
          receivedAt,
          ok: true,
          accepted: true,
          completedAt: new Date().toISOString(),
          applicationName: commandResult.applicationName,
          method: commandResult.method,
          steps: commandResult.steps
        },
        lastError: null
      };
      emitState();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);

      serverState = {
        ...serverState,
        lastCommand: {
          command,
          receivedAt,
          ok: false,
          accepted: true,
          completedAt: new Date().toISOString(),
          applicationName: null,
          method: null,
          steps: []
        },
        lastError: message
      };
      emitState();
    });
}

function handleSlideCommand(command, response) {
  const receivedAt = new Date().toISOString();

  markRemoteContact();
  serverState = {
    ...serverState,
    lastCommand: {
      command,
      receivedAt,
      ok: null,
      accepted: true,
      completedAt: null,
      applicationName: null,
      method: "pending",
      steps: []
    },
    lastError: null
  };
  emitState();
  writeJson(response, 200, {
    ok: true,
    accepted: true,
    command,
    receivedAt
  });
  executeSlideCommand(command, receivedAt);
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
        app: "MSTV Click",
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
      handleSlideCommand("next", response);
      return;
    }

    if (request.method === "POST" && request.url === "/prev") {
      handleSlideCommand("prev", response);
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
    width: 430,
    height: 360,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreen: false,
    fullscreenable: false,
    center: true,
    title: "MSTV Click",
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

app.name = "MSTV Click";

app.whenReady().then(() => {
  configureApplicationMenu();
  ipcMain.handle("slides:get-state", () => ({
    ...serverState,
    localAddresses: getLocalAddresses(),
    executionDiagnostics: getSlideExecutionDiagnostics(serverState.lastCommand),
    accessibilityTrusted: isAccessibilityTrusted(false),
    connectionState: getConnectionState()
  }));
  ipcMain.handle("slides:start", async (_event, port) => startServer(Number(port) || DEFAULT_PORT));
  ipcMain.handle("slides:stop", async () => stopServer());
  ipcMain.handle("slides:set-target-app", (_event, value) => setSelectedTargetApp(value));
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
