const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mstvSlides", {
  getState: () => ipcRenderer.invoke("slides:get-state"),
  start: (port) => ipcRenderer.invoke("slides:start", port),
  stop: () => ipcRenderer.invoke("slides:stop"),
  requestAccessibility: () => ipcRenderer.invoke("slides:request-accessibility"),
  openAccessibilitySettings: () => ipcRenderer.invoke("slides:open-accessibility-settings"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);

    ipcRenderer.on("slides:state", listener);

    return () => {
      ipcRenderer.off("slides:state", listener);
    };
  }
});
