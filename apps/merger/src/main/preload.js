const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings:    ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s)      => ipcRenderer.invoke('save-settings', s),
  chooseFolder:   ()       => ipcRenderer.invoke('choose-folder'),
  chooseSources:  ()       => ipcRenderer.invoke('choose-sources'),
  identifySource: (file)   => ipcRenderer.invoke('identify-source', file),
  merge:          (plan)   => ipcRenderer.invoke('merge', plan),
  cancel:         ()       => ipcRenderer.invoke('cancel'),
  getToolsStatus: ()       => ipcRenderer.invoke('get-tools-status'),
  openUrl:        (url)    => ipcRenderer.invoke('open-url', url),

  on: (channel, cb) => {
    const allowed = ['log', 'progress', 'merge-complete', 'merge-error'];
    if (allowed.includes(channel)) {
      const sub = (_, ...a) => cb(...a);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  }
});
