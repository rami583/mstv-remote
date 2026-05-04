const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mstvDesktop", {
  getProgramDisplays: () => ipcRenderer.invoke("mstv:get-program-displays"),
  toggleProgramWindow: (displayId) => ipcRenderer.invoke("mstv:toggle-program-window", displayId),
  sendSlideCommand: (input) => ipcRenderer.invoke("mstv:send-slide-command", input)
});
