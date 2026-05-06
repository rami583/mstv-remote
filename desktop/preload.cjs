const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mstvDesktop", {
  getProgramDisplays: () => ipcRenderer.invoke("mstv:get-program-displays"),
  toggleProgramWindow: (displayId, roomSlug) => ipcRenderer.invoke("mstv:toggle-program-window", displayId, roomSlug),
  writeClipboardText: (text) => ipcRenderer.invoke("mstv:write-clipboard-text", text),
  sendSlideCommand: (input) => ipcRenderer.invoke("mstv:send-slide-command", input),
  chooseProgramRecordingPath: (input) => ipcRenderer.invoke("mstv:choose-program-recording-path", input),
  saveProgramRecording: (input) => ipcRenderer.invoke("mstv:save-program-recording", input),
  showItemInFolder: (filePath) => ipcRenderer.invoke("mstv:show-item-in-folder", filePath)
});
