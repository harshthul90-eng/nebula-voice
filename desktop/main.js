'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let overlayWindow = null;
let authWindow = null;
let tray = null;
let overlayVisible = false;

// ── PTT / Toggle state ────────────────────────────────────────────────────────
let pttMode      = false;   // false = toggle, true = push-to-talk
let pttKeyHeld   = false;
let pttRelTimer  = null;
const PTT_RELEASE_MS = 150; // ms after last keydown before we treat key as released

function handleMuteKey() {
  if (pttMode) {
    // PTT: first press → unmute; key-repeat resets release timer; timeout → mute
    if (!pttKeyHeld) {
      pttKeyHeld = true;
      mainWindow?.webContents.send('ptt-press');
    }
    clearTimeout(pttRelTimer);
    pttRelTimer = setTimeout(() => {
      pttKeyHeld = false;
      mainWindow?.webContents.send('ptt-release');
    }, PTT_RELEASE_MS);
  } else {
    // Toggle: flip mute state
    mainWindow?.webContents.send('ptt-toggle');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Window
// ─────────────────────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 580,
    frame: false,           // Custom titlebar drawn in HTML
    transparent: false,
    backgroundColor: '#000000',
    resizable: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow mic access in renderer
      webSecurity: true,
    },
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Show window after it's ready to avoid flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  mainWindow.on('minimize', () => mainWindow.hide());
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay Window
// ─────────────────────────────────────────────────────────────────────────────
function createOverlayWindow() {
  // Restore last position or default to top-left
  const bounds = store.get('overlayBounds', { x: 20, y: 60, width: 260, height: 200 });

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,       // Don't steal focus from game
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.hide(); // Hidden by default

  // Persist position when moved
  overlayWindow.on('move', () => {
    const [x, y] = overlayWindow.getPosition();
    const [width, height] = overlayWindow.getSize();
    store.set('overlayBounds', { x, y, width, height });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// System Tray
// ─────────────────────────────────────────────────────────────────────────────
function createTray() {
  // Create a simple 16x16 tray icon programmatically since we may not have an .ico
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Nebula', enabled: false },
    { type: 'separator' },
    { label: 'Show App', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Toggle Overlay (F9)', click: toggleOverlay },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Nebula');
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay Toggle
// ─────────────────────────────────────────────────────────────────────────────
function toggleOverlay() {
  if (!overlayWindow) return;
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    overlayWindow.show();
  } else {
    overlayWindow.hide();
  }
  mainWindow?.webContents.send('overlay-visibility', overlayVisible);
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Handlers
// ─────────────────────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window-close', () => mainWindow?.close());

  // Overlay control
  ipcMain.on('toggle-overlay', toggleOverlay);

  // Push data to overlay from main renderer
  ipcMain.on('overlay-update', (_event, data) => {
    overlayWindow?.webContents.send('overlay-data', data);
  });

  // Google OAuth — open an in-app browser window
  ipcMain.on('open-google-auth', () => {
    if (authWindow) { authWindow.focus(); return; }

    authWindow = new BrowserWindow({
      width: 480,
      height: 640,
      parent: mainWindow,
      modal: false,
      frame: true,
      title: 'Sign in with Google',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    authWindow.loadURL('https://nebula-voicechat.onrender.com/api/auth/google');

    // Intercept the nebula:// deep-link redirect from our backend
    authWindow.webContents.on('will-redirect', (event, url) => {
      if (url.startsWith('nebula://')) {
        event.preventDefault();
        authWindow.close();
        authWindow = null;

        try {
          // Parse: nebula://auth?token=xxx  or  nebula://auth?error=xxx
          const fakeHttp = url.replace('nebula://', 'http://x/');
          const params = new URL(fakeHttp).searchParams;
          const token = params.get('token');
          const error = params.get('error');
          mainWindow?.webContents.send('google-auth-result', { token, error });
        } catch {
          mainWindow?.webContents.send('google-auth-result', { error: 'parse_failed' });
        }
      }
    });

    authWindow.on('closed', () => { authWindow = null; });
  });

  // PTT toggle — triggered by globalShortcut
  // Relay ptt-toggle to renderer

  // Electron Store (persist settings)
  ipcMain.handle('store-get', (_event, key) => store.get(key));
  ipcMain.handle('store-set', (_event, key, value) => store.set(key, value));

  // Switch between Toggle and PTT modes (called from renderer settings)
  ipcMain.on('set-ptt-mode', (_event, enabled) => {
    pttMode = enabled;
    store.set('pttMode', enabled);
    // If switching out of PTT while key held, release mic immediately
    if (!enabled && pttKeyHeld) {
      clearTimeout(pttRelTimer);
      pttKeyHeld = false;
      mainWindow?.webContents.send('ptt-release');
    }
  });

  // Open external links safely
  ipcMain.on('open-external', (_event, url) => {
    if (url.startsWith('https://')) shell.openExternal(url);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Shortcuts
// ─────────────────────────────────────────────────────────────────────────────
function registerShortcuts() {
  // F9 — Toggle overlay
  globalShortcut.register('F9', toggleOverlay);

  // Mute/unmute toggle — V key (overwrite stored default if it was old CapsLock)
  const storedKey = store.get('pttKey', 'V');
  const pttKey = storedKey === 'CapsLock' ? 'V' : storedKey; // migrate old default
  store.set('pttKey', pttKey);
  try {
    globalShortcut.register(pttKey, handleMuteKey);
  } catch (e) {
    console.warn('Could not register mute key:', pttKey, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

  // Restore persisted PTT mode
  pttMode = store.get('pttMode', false);

  createMainWindow();
  createOverlayWindow();
  createTray();
  registerIpcHandlers();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}
