'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings:    ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s)      => ipcRenderer.invoke('save-settings', s),
  getMeta:        ()       => ipcRenderer.invoke('get-meta'),
  getToolsStatus: ()       => ipcRenderer.invoke('get-tools-status'),
  chooseFolder:   ()       => ipcRenderer.invoke('choose-folder'),
  chooseSources:  ()       => ipcRenderer.invoke('choose-sources'),
  identifySource: (file)   => ipcRenderer.invoke('identify-source', file),
  analyzeMovie:   (file)   => ipcRenderer.invoke('analyze-movie', file),
  searchMovie:    (q)      => ipcRenderer.invoke('search-movie', q),
  searchTV:       (q)      => ipcRenderer.invoke('search-tv', q),
  getEpisode:     (args)   => ipcRenderer.invoke('get-episode', args),
  planTracks:     (args)   => ipcRenderer.invoke('plan-tracks', args),
  analyzeSync:    (srcs)   => ipcRenderer.invoke('analyze-sync', srcs),
  merge:          (args)   => ipcRenderer.invoke('merge', args),
  cancel:         ()       => ipcRenderer.invoke('cancel'),
  openUrl:        (url)    => ipcRenderer.invoke('open-url', url),
  getFilePath:    (file)   => webUtils.getPathForFile(file),
  getStrings:     (lang)   => ipcRenderer.invoke('get-strings', lang),
  getOcrStatus:   (p)      => ipcRenderer.invoke('get-ocr-status', p),
  ocrConvert:     (args)   => ipcRenderer.invoke('ocr-convert', args),

  on: (channel, cb) => {
    const allowed = ['log', 'progress', 'merge-complete', 'merge-error', 'ocr-progress'];
    if (!allowed.includes(channel)) return;
    const sub = (_, ...a) => cb(...a);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
