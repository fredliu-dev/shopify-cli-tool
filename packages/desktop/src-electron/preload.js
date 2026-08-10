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
    dataDir: () => ipcRenderer.invoke('config:dataDir'),
    export: () => ipcRenderer.invoke('config:export'),
    createTemplate: (opts) => ipcRenderer.invoke('config:createTemplate', opts),
    templateEnv: (name) => ipcRenderer.invoke('config:templateEnv', name),
    updateTemplate: (opts) => ipcRenderer.invoke('config:updateTemplate', opts),
    deleteTemplate: (name) => ipcRenderer.invoke('config:deleteTemplate', name),
    initStatus: (dir) => ipcRenderer.invoke('config:initStatus', dir),
    initCreate: (opts) => ipcRenderer.invoke('config:initCreate', opts),
    initMerge: (opts) => ipcRenderer.invoke('config:initMerge', opts),
  },
  dialog: {
    pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  },
  git: {
    scanRepos: (dir) => ipcRenderer.invoke('git:scanRepos', dir),
    repoInfo: (repoPath) => ipcRenderer.invoke('git:repoInfo', repoPath),
  },
  repos: {
    scan: (dir) => ipcRenderer.invoke('repos:scan', dir),
    status: (repoPath) => ipcRenderer.invoke('repos:status', repoPath),
    save: (opts) => ipcRenderer.invoke('repos:save', opts),
    copyLive: (opts) => ipcRenderer.invoke('repos:copyLive', opts),
    changedJson: (opts) => ipcRenderer.invoke('repos:changedJson', opts),
    runCommand: (opts) => ipcRenderer.invoke('repos:runCommand', opts),
    editors: () => ipcRenderer.invoke('repos:editors'),
    openInEditor: (opts) => ipcRenderer.invoke('repos:openInEditor', opts),
    branches: (dir) => ipcRenderer.invoke('repos:branches', dir),
    remoteBranches: (dir) => ipcRenderer.invoke('repos:remoteBranches', dir),
    checkout: (opts) => ipcRenderer.invoke('repos:checkout', opts),
    createBranch: (opts) => ipcRenderer.invoke('repos:createBranch', opts),
    workingTree: (opts) => ipcRenderer.invoke('repos:workingTree', opts),
    merge: (opts) => ipcRenderer.invoke('repos:merge', opts),
    cloneableTemplates: (workspaceDir) => ipcRenderer.invoke('repos:cloneableTemplates', workspaceDir),
    clone: (opts) => ipcRenderer.invoke('repos:clone', opts),
    templates: () => ipcRenderer.invoke('repos:templates'),
    resolveTemplate: (store) => ipcRenderer.invoke('repos:resolveTemplate', store),
    // 仓库文件（配置/templates）变动后，主进程推送的最新仓库数据
    // 返回真正的注销函数（ipcRenderer.on 返回的是 ipcRenderer 对象本身，非函数；
    // 渲染层清理时直接调用返回值会抛 "off is not a function"，故包成 removeListener）
    onUpdated: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('repos:repoUpdated', listener)
      return () => ipcRenderer.removeListener('repos:repoUpdated', listener)
    },
    // 工作区目录下仓库新增/删除后，主进程推送的完整新仓库列表（整体替换）
    onReposChanged: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('repos:reposChanged', listener)
      return () => ipcRenderer.removeListener('repos:reposChanged', listener)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    setWorkspace: (dir) => ipcRenderer.invoke('settings:setWorkspace', dir),
    setEditor: (editorId) => ipcRenderer.invoke('settings:setEditor', editorId),
  },
  system: {
    versions: () => ipcRenderer.invoke('system:versions'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (dir) => ipcRenderer.invoke('shell:openPath', dir),
    copy: (text) => ipcRenderer.invoke('shell:copy', text),
  },
  contacts: {
    ls: () => ipcRenderer.invoke('contacts:ls'),
    upsert: (opts) => ipcRenderer.invoke('contacts:upsert', opts),
    remove: (id) => ipcRenderer.invoke('contacts:remove', id),
  },
  dingtalk: {
    load: () => ipcRenderer.invoke('dingtalk:load'),
    upsertGroup: (opts) => ipcRenderer.invoke('dingtalk:upsertGroup', opts),
    removeGroup: (id) => ipcRenderer.invoke('dingtalk:removeGroup', id),
    upsertTemplate: (opts) => ipcRenderer.invoke('dingtalk:upsertTemplate', opts),
    removeTemplate: (id) => ipcRenderer.invoke('dingtalk:removeTemplate', id),
    saveDefaults: (opts) => ipcRenderer.invoke('dingtalk:saveDefaults', opts),
    parsePlaceholders: (templateId) => ipcRenderer.invoke('dingtalk:parsePlaceholders', templateId),
    gotest: (opts) => ipcRenderer.invoke('dingtalk:gotest', opts),
    notify: (opts) => ipcRenderer.invoke('dingtalk:notify', opts),
  },
})
