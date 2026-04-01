const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, shell } = require("electron");

let mainWindow = null;
let serverHandle = null;

function isLocalAppUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function copyDirectoryIfMissing(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryIfMissing(sourcePath, targetPath);
      continue;
    }
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function ensureRuntimeFiles(runtimeRoot) {
  const appRoot = app.getAppPath();
  const packagedAppConfigPath = path.join(appRoot, "config", "app.config.json");
  const runtimeAppConfigPath = path.join(runtimeRoot, "app.config.json");
  if (fs.existsSync(packagedAppConfigPath) && !fs.existsSync(runtimeAppConfigPath)) {
    fs.copyFileSync(packagedAppConfigPath, runtimeAppConfigPath);
  }
  copyDirectoryIfMissing(path.join(appRoot, "config"), path.join(runtimeRoot, "config"));
  copyDirectoryIfMissing(path.join(appRoot, "files"), path.join(runtimeRoot, "files"));
  copyDirectoryIfMissing(path.join(runtimeRoot, "Files"), path.join(runtimeRoot, "files"));
}

function getRuntimeRoot() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return path.join(app.getAppPath(), ".electron-runtime");
}

async function createMainWindow() {
  const runtimeRoot = getRuntimeRoot();
  ensureRuntimeFiles(runtimeRoot);

  process.env.APP_RUNTIME_DIR = runtimeRoot;
  process.env.APP_CONFIG_PATH = path.join(runtimeRoot, "app.config.json");
  process.env.LEGACY_VIEWS_CONFIG_PATH = path.join(runtimeRoot, "config", "views.config.json");
  process.env.SERVED_FILES_PATH = path.join(runtimeRoot, "files");

  const { startServer } = require("../src/server");
  serverHandle = await startServer({ port: 0, host: "127.0.0.1" });

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalAppUrl(url)) {
      mainWindow.loadURL(url);
    } else if (url) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isLocalAppUrl(url)) {
      return;
    }
    event.preventDefault();
    if (url) {
      shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(serverHandle.url);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (!BrowserWindow.getAllWindows().length) {
    try {
      await createMainWindow();
    } catch (error) {
      dialog.showErrorBox("Startup Error", error.message);
      app.quit();
    }
  }
});

app.whenReady()
  .then(createMainWindow)
  .catch((error) => {
    dialog.showErrorBox("Startup Error", error.message);
    app.quit();
  });

app.on("before-quit", async () => {
  if (serverHandle?.server) {
    await new Promise((resolve) => {
      serverHandle.server.close(() => resolve());
    });
  }
});
