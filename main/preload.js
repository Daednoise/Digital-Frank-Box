const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scanApi", {
  getStatus: () => ipcRenderer.invoke("scan:status"),
  startScan: options => ipcRenderer.invoke("scan:start", options),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  updateScan: options => ipcRenderer.invoke("scan:update", options),
  startRecording: label => ipcRenderer.invoke("record:start", label),
  stopRecording: () => ipcRenderer.invoke("record:stop"),
  setContentSize: (width, height) =>
    ipcRenderer.invoke("app:setContentSize", { width, height }),
  onStatus: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("scan:status", listener);
    return () => ipcRenderer.removeListener("scan:status", listener);
  },
  onTune: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("scan:tune", listener);
    return () => ipcRenderer.removeListener("scan:tune", listener);
  },
  onWaveform: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("scan:waveform", listener);
    return () => ipcRenderer.removeListener("scan:waveform", listener);
  },
});
