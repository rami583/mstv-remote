const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mstvSetup", {
  getStatus: () => ipcRenderer.invoke("mstv:setup-get-status"),
  save: (config) => ipcRenderer.invoke("mstv:setup-save", config),
  cancel: () => ipcRenderer.invoke("mstv:setup-cancel")
});
