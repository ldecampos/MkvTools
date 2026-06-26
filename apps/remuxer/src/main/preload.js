const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getMeta: () => ipcRenderer.invoke('get-meta'),
  getStrings: (lang) => ipcRenderer.invoke('get-strings', lang),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  chooseFiles: () => ipcRenderer.invoke('choose-files'),
  analyzeFile: (p) => ipcRenderer.invoke('analyze-file', p),
  searchMovie: (q) => ipcRenderer.invoke('search-movie', q),
  searchTV: (q) => ipcRenderer.invoke('search-tv', q),
  replan: (args) => ipcRenderer.invoke('replan', args),
  getEpisode: (args) => ipcRenderer.invoke('get-episode', args),
  processBatch: (items) => ipcRenderer.invoke('process-batch', items),
  cancel: () => ipcRenderer.invoke('cancel'),

  // Tools & MakeMKV
  getToolsStatus: () => ipcRenderer.invoke('get-tools-status'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  scanDisc: () => ipcRenderer.invoke('scan-disc'),
  ripTitle: (args) => ipcRenderer.invoke('rip-title', args),
  cancelRip: () => ipcRenderer.invoke('cancel-rip'),

  on: (channel, cb) => {
    const allowed = ['log', 'progress', 'item-done', 'batch-complete',
                     'rip-started', 'rip-progress', 'rip-complete', 'rip-failed'];
    if (allowed.includes(channel)) {
      const sub = (_, ...a) => cb(...a);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  }
});
