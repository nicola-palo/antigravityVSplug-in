"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Preload script — runs in every BrowserWindow before the page loads.
 * Exposes a minimal, secure API via contextBridge so the renderer can
 * communicate with the main-process auto-updater without nodeIntegration.
 */
const electron_1 = require("electron");
const updaterAPI = {
    onStateChanged: (callback) => {
        const handler = (_event, state) => {
            callback(state);
        };
        electron_1.ipcRenderer.on('updater:state-changed', handler);
        // Return unsubscribe function
        return () => {
            electron_1.ipcRenderer.removeListener('updater:state-changed', handler);
        };
    },
    applyUpdate: () => electron_1.ipcRenderer.invoke('updater:apply'),
    quitAndInstall: () => electron_1.ipcRenderer.invoke('updater:quit-and-install'),
    checkForUpdates: () => electron_1.ipcRenderer.invoke('updater:check-for-updates'),
};
const dialogAPI = {
    showOpenDialog: () => {
        if (window.__pendingWorkspace) {
            const p = window.__pendingWorkspace;
            window.__pendingWorkspace = null;
            return Promise.resolve(p);
        }
        return electron_1.ipcRenderer.invoke('dialog:open-workspace');
    },
};
const notificationAPI = {
    send: (options) => electron_1.ipcRenderer.invoke('notification:send', options),
    openSystemPreferences: () => electron_1.ipcRenderer.invoke('notification:open-system-preferences'),
    onClicked: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };
        electron_1.ipcRenderer.on('notification:clicked', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('notification:clicked', handler);
        };
    },
};
const storageAPI = {
    getItems: () => electron_1.ipcRenderer.invoke('storage:get-items'),
    updateItems: (changes) => electron_1.ipcRenderer.invoke('storage:update-items', changes),
    onChanged: (callback) => {
        const handler = (_event, changes) => {
            callback(changes);
        };
        electron_1.ipcRenderer.on('storage:changed', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('storage:changed', handler);
        };
    },
};
const logsAPI = {
    getElectronLogs: () => electron_1.ipcRenderer.invoke('logs:electron'),
};
const extensionsAPI = {
    sendAuthorities: (authoritiesMap) => electron_1.ipcRenderer.invoke('extensions:send-authorities', authoritiesMap),
};
const deepLinkAPI = {
    onDeepLink: (callback) => {
        const handler = (_event, url) => {
            callback(url);
        };
        electron_1.ipcRenderer.on('deep-link', handler);
        return () => {
            electron_1.ipcRenderer.removeListener('deep-link', handler);
        };
    },
    getStoredDeepLink: () => electron_1.ipcRenderer.invoke('deep-link:get-stored'),
};
const agentAPI = {
    updateActiveAgentCount: (count) => electron_1.ipcRenderer.invoke('agent:update-active-count', count),
};
const electronNativeAPI = {
    getZoomLevel: () => electron_1.webFrame.getZoomFactor(),
    setTitleBarOverlay: (options) => electron_1.ipcRenderer.invoke('window:set-title-bar-overlay', options),
    minimize: () => electron_1.ipcRenderer.invoke('window:minimize'),
    maximize: () => electron_1.ipcRenderer.invoke('window:maximize'),
    unmaximize: () => electron_1.ipcRenderer.invoke('window:unmaximize'),
    isMaximized: () => electron_1.ipcRenderer.invoke('window:is-maximized'),
    close: () => electron_1.ipcRenderer.invoke('window:close'),
    toggleDevTools: () => electron_1.ipcRenderer.invoke('window:toggle-devtools'),
    zoomIn: () => {
        const current = electron_1.webFrame.getZoomLevel();
        electron_1.webFrame.setZoomLevel(current + 0.5);
    },
    zoomOut: () => {
        const current = electron_1.webFrame.getZoomLevel();
        electron_1.webFrame.setZoomLevel(current - 0.5);
    },
    resetZoom: () => {
        electron_1.webFrame.setZoomLevel(0);
    },
    openExternal: (url) => electron_1.ipcRenderer.invoke('shell:open-external', url),
};
const ideAPI = {
    isInstalled: () => electron_1.ipcRenderer.invoke('ide:is-installed'),
};
electron_1.contextBridge.exposeInMainWorld('electronUpdater', updaterAPI);
electron_1.contextBridge.exposeInMainWorld('dialog', dialogAPI);
electron_1.contextBridge.exposeInMainWorld('nativeNotifications', notificationAPI);
electron_1.contextBridge.exposeInMainWorld('nativeStorage', storageAPI);
electron_1.contextBridge.exposeInMainWorld('logs', logsAPI);
electron_1.contextBridge.exposeInMainWorld('extensions', extensionsAPI);
electron_1.contextBridge.exposeInMainWorld('deepLink', deepLinkAPI);
electron_1.contextBridge.exposeInMainWorld('agent', agentAPI);
electron_1.contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);
electron_1.contextBridge.exposeInMainWorld('ide', ideAPI);


function triggerOpenFolder() {
  var attempts = 0;
  var timer = setInterval(function () {
    var elements = document.querySelectorAll('button, div, span, a');
    var target = null;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var text = (el.textContent || '').trim();
      if (text.indexOf('Open Folder') !== -1 || text.indexOf('Apri cartella') !== -1 || text.indexOf('Add Folder') !== -1 || text.indexOf('Aggiungi cartella') !== -1) {
        var hasChildMatch = false;
        for (var j = 0; j < el.children.length; j++) {
          var childText = el.children[j].textContent || '';
          if (childText.indexOf('Open Folder') !== -1 || childText.indexOf('Apri cartella') !== -1 || childText.indexOf('Add Folder') !== -1 || childText.indexOf('Aggiungi cartella') !== -1) {
            hasChildMatch = true;
            break;
          }
        }
        if (!hasChildMatch) {
          target = el;
          break;
        }
      }
    }
    if (target) {
      target.click();
      try {
        var event = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(event);
      } catch (e) {}
      clearInterval(timer);
      return;
    }
    attempts++;
    if (attempts > 30) {
      clearInterval(timer);
    }
  }, 500);
}

electron_1.ipcRenderer.on('open-workspace-folder', (_event, path) => {
    window.__pendingWorkspace = path;
    triggerOpenFolder();
});

electron_1.ipcRenderer.invoke('get-launch-workspace').then((path) => {
    if (path) {
        window.__pendingWorkspace = path;
        triggerOpenFolder();
    }
});
