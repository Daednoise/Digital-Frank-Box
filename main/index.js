const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { createScanEngine } = require("./scanEngine");

const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

function resolveWindowIcon() {
  const filename = process.platform === "win32" ? "icon.ico" : "icon.png";
  return path.join(__dirname, "..", "build", filename);
}

function configurePlaywrightBrowsers() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "playwright-browsers");
    if (fs.existsSync(bundled)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
    }
  }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    title: "Digital Frank Box",
    autoHideMenuBar: true,
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    const indexPath = path.join(__dirname, "..", "renderer", "dist", "index.html");
    win.loadFile(indexPath);
  } else {
    const url = process.env.ELECTRON_START_URL || "http://127.0.0.1:3000";
    win.loadURL(url);
  }

  return win;
}

app.whenReady().then(() => {
  configurePlaywrightBrowsers();

  const mainWindow = createMainWindow();
  const recordingsDir = path.join(app.getPath("userData"), "recordings");

  const scanEngine = createScanEngine({
    recordingsDir,
    onStatus: status => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("scan:status", status);
      }
    },
    onTune: tune => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("scan:tune", tune);
      }
    },
    onWaveform: waveform => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("scan:waveform", waveform);
      }
    },
  });

  ipcMain.handle("scan:status", () => scanEngine.getStatus());
  ipcMain.handle("scan:start", (_event, options) => scanEngine.start(options));
  ipcMain.handle("scan:stop", () => scanEngine.stop());
  ipcMain.handle("scan:update", (_event, options) => scanEngine.update(options));
  ipcMain.handle("record:start", (_event, label) => scanEngine.recordStart(label));
  ipcMain.handle("record:stop", () => scanEngine.recordStop());
  ipcMain.handle("app:setContentSize", (_event, size) => {
    if (!size) return;
    const width = Math.max(0, Math.round(Number(size.width) || 0));
    const height = Math.max(0, Math.round(Number(size.height) || 0));
    if (width > 0 && height > 0 && !mainWindow.isDestroyed()) {
      mainWindow.setContentSize(width, height);
    }
  });

  app.on("before-quit", async () => {
    await scanEngine.stop().catch(() => null);
    await scanEngine.recordStop().catch(() => null);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

