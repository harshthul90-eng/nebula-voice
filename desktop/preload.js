'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nebula', {
  // ── Window Controls ────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // ── Google OAuth ───────────────────────────────────────────────────────────
  openGoogleAuth: () => ipcRenderer.send('open-google-auth'),
  onGoogleAuthResult: (cb) =>
    ipcRenderer.on('google-auth-result', (_event, data) => cb(data)),

  // ── Overlay ────────────────────────────────────────────────────────────────
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  updateOverlay: (data) => ipcRenderer.send('overlay-update', data),
  onOverlayData: (cb) => ipcRenderer.on('overlay-data', (_event, data) => cb(data)),
  onOverlayVisibility: (cb) => ipcRenderer.on('overlay-visibility', (_event, v) => cb(v)),

  // ── PTT / Toggle mode ──────────────────────────────────────────────────────
  // Toggle mode: V flips mute state
  onPttToggle: (cb) => ipcRenderer.on('ptt-toggle', () => cb()),
  // PTT mode: fires when V is pressed (unmute) or released (mute)
  onPttPress: (cb) => ipcRenderer.on('ptt-press', () => cb()),
  onPttRelease: (cb) => ipcRenderer.on('ptt-release', () => cb()),
  // Tell main process which mode to use (persisted to store)
  setPttMode: (enabled) => ipcRenderer.send('set-ptt-mode', enabled),
  // Read persisted mode from store
  getPttMode: () => ipcRenderer.invoke('store-get', 'pttMode'),

  // ── Persistent Storage ─────────────────────────────────────────────────────
  getStore: (key) => ipcRenderer.invoke('store-get', key),
  setStore: (key, value) => ipcRenderer.invoke('store-set', key, value),

  // ── External links ─────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ── Platform info ──────────────────────────────────────────────────────────
  platform: process.platform,
});

