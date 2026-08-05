import { contextBridge, ipcRenderer } from 'electron'

// contextIsolation 下渲染层无法直接访问 Node/Electron，只暴露最小白名单 API。
contextBridge.exposeInMainWorld('api', {
  shops: {
    ls: () => ipcRenderer.invoke('shops:ls'),
    delete: (ids) => ipcRenderer.invoke('shops:delete', ids),
    update: (id, fields) => ipcRenderer.invoke('shops:update', { id, fields }),
    storeToTemplate: (store) => ipcRenderer.invoke('shops:storeToTemplate', store),
  },
  links: {
    get: (opts) => ipcRenderer.invoke('links:get', opts),
  },
  config: {
    templates: () => ipcRenderer.invoke('config:templates'),
    initStatus: (dir) => ipcRenderer.invoke('config:initStatus', dir),
    initCreate: (opts) => ipcRenderer.invoke('config:initCreate', opts),
    initMerge: (opts) => ipcRenderer.invoke('config:initMerge', opts),
  },
  dialog: {
    pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  },
})
