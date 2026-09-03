import { contextBridge, ipcRenderer, webUtils } from 'electron'

// contextIsolation 下渲染层无法直接访问 Node/Electron，只暴露最小白名单 API。
contextBridge.exposeInMainWorld('api', {
  shops: {
    ls: () => ipcRenderer.invoke('shops:ls'),
    delete: (ids, repoPath) => ipcRenderer.invoke('shops:delete', repoPath ? { ids, repoPath } : ids),
    update: (id, fields, repoPath) => ipcRenderer.invoke('shops:update', { id, fields, repoPath }),
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
    openDepGraph: (opts) => ipcRenderer.invoke('repos:openDepGraph', opts),
    depGraph: (opts) => ipcRenderer.invoke('repos:depGraph', opts),
    // 引用图扫描进度（主进程推送 { dir, stage, current, total }，按 dir 过滤自己的仓库）
    onDepGraphProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('repos:depGraphProgress', listener)
      return () => ipcRenderer.removeListener('repos:depGraphProgress', listener)
    },
    save: (opts) => ipcRenderer.invoke('repos:save', opts),
    copyLive: (opts) => ipcRenderer.invoke('repos:copyLive', opts),
    themeInfo: (opts) => ipcRenderer.invoke('repos:themeInfo', opts),
    themeList: (opts) => ipcRenderer.invoke('repos:themeList', opts),
    publishTheme: (opts) => ipcRenderer.invoke('repos:publishTheme', opts),
    deleteTheme: (opts) => ipcRenderer.invoke('repos:deleteTheme', opts),
    switchConfig: (opts) => ipcRenderer.invoke('repos:switchConfig', opts),
    editors: () => ipcRenderer.invoke('repos:editors'),
    openInEditor: (opts) => ipcRenderer.invoke('repos:openInEditor', opts),
    branches: (dir) => ipcRenderer.invoke('repos:branches', dir),
    remoteBranches: (dir) => ipcRenderer.invoke('repos:remoteBranches', dir),
    collaborators: (dir) => ipcRenderer.invoke('repos:collaborators', dir),
    createPull: (opts) => ipcRenderer.invoke('repos:createPull', opts),
    checkout: (opts) => ipcRenderer.invoke('repos:checkout', opts),
    createBranch: (opts) => ipcRenderer.invoke('repos:createBranch', opts),
    // 删除分支（本地+远程；删当前分支时先自动切到 main/master/其它）
    deleteBranch: (opts) => ipcRenderer.invoke('repos:deleteBranch', opts),
    workingTree: (opts) => ipcRenderer.invoke('repos:workingTree', opts),
    merge: (opts) => ipcRenderer.invoke('repos:merge', opts),
    cloneableTemplates: (workspaceDir) => ipcRenderer.invoke('repos:cloneableTemplates', workspaceDir),
    clone: (opts) => ipcRenderer.invoke('repos:clone', opts),
    templates: () => ipcRenderer.invoke('repos:templates'),
    resolveTemplate: (store) => ipcRenderer.invoke('repos:resolveTemplate', store),
    resolveTemplateByRemote: (remoteUrl) => ipcRenderer.invoke('repos:resolveTemplateByRemote', remoteUrl),
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
    // 检测到外部（终端/IDE）切分支后，主进程按新分支自动同步 toml 的结果
    onBranchSynced: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('repos:branchSynced', listener)
      return () => ipcRenderer.removeListener('repos:branchSynced', listener)
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
  tapd: {
    loadConfig: () => ipcRenderer.invoke('tapd:loadConfig'),
    openLogin: () => ipcRenderer.invoke('tapd:openLogin'),
    checkLogin: () => ipcRenderer.invoke('tapd:checkLogin'),
    logout: () => ipcRenderer.invoke('tapd:logout'),
    saveConfig: (patch) => ipcRenderer.invoke('tapd:saveConfig', patch),
    workspaces: () => ipcRenderer.invoke('tapd:workspaces'),
    workspaceInfo: (workspaceId) => ipcRenderer.invoke('tapd:workspaceInfo', workspaceId),
    user: () => ipcRenderer.invoke('tapd:user'),
    suggestWorkspaces: () => ipcRenderer.invoke('tapd:suggestWorkspaces'),
    list: (opts) => ipcRenderer.invoke('tapd:list', opts),
    // 初始化弹窗工单下拉：我的未完成工单聚合；resolveWorkItem 为手输链接/ID 的单条解析
    myOpenItems: (opts) => ipcRenderer.invoke('tapd:myOpenItems', opts),
    resolveWorkItem: (opts) => ipcRenderer.invoke('tapd:resolveWorkItem', opts),
    statusMap: (opts) => ipcRenderer.invoke('tapd:statusMap', opts),
    transitions: (opts) => ipcRenderer.invoke('tapd:transitions', opts),
    lastSteps: (opts) => ipcRenderer.invoke('tapd:lastSteps', opts),
    updateStatus: (opts) => ipcRenderer.invoke('tapd:updateStatus', opts),
    // 编辑工单字段：{ type, workspaceId, id, fields }（fields 键为 TAPD 字段名，core 白名单过滤）
    update: (opts) => ipcRenderer.invoke('tapd:update', opts),
    members: (opts) => ipcRenderer.invoke('tapd:members', opts),
    comments: (opts) => ipcRenderer.invoke('tapd:comments', opts),
    addComment: (opts) => ipcRenderer.invoke('tapd:addComment', opts),
    updateComment: (opts) => ipcRenderer.invoke('tapd:updateComment', opts),
    // 实时同步（主进程增量轮询）：start 建立基线（全量加载成功后）/ pause-resume 随页面与
    // 窗口可见性启停 / stop 页面卸载停表；onChanged 推增量工单 { workspaceId, items:[{type,item}], at }，
    // onSync 推调度状态（连续失败自动暂停等）。返回值均为取消订阅函数
    syncStart: (opts) => ipcRenderer.invoke('tapd:syncStart', opts),
    syncPause: () => ipcRenderer.invoke('tapd:syncPause'),
    syncResume: () => ipcRenderer.invoke('tapd:syncResume'),
    syncStop: () => ipcRenderer.invoke('tapd:syncStop'),
    onChanged: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('tapd:changed', listener)
      return () => ipcRenderer.removeListener('tapd:changed', listener)
    },
    onSync: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('tapd:sync', listener)
      return () => ipcRenderer.removeListener('tapd:sync', listener)
    },
  },
  // 爬虫工作流（主窗口左侧栏切换页）：项目 CRUD / 画布导入导出 / 运行控制 / 结果导出。
  // 推送事件按 projectId 过滤自己的项目（同 repos:depGraphProgress 按 dir 过滤）。
  crawler: {
    ls: () => ipcRenderer.invoke('crawler:ls'),
    create: (name) => ipcRenderer.invoke('crawler:create', name),
    get: (id) => ipcRenderer.invoke('crawler:get', id),
    save: (opts) => ipcRenderer.invoke('crawler:save', opts),
    saveAs: (opts) => ipcRenderer.invoke('crawler:saveAs', opts),
    rename: (opts) => ipcRenderer.invoke('crawler:rename', opts),
    delete: (id) => ipcRenderer.invoke('crawler:delete', id),
    exportGraph: (id) => ipcRenderer.invoke('crawler:exportGraph', id),
    importGraph: () => ipcRenderer.invoke('crawler:importGraph'),
    // 拖拽导入：Electron 33 起 File.path 被移除，需在 preload 用 webUtils 换取文件路径
    importGraphFile: (file) => ipcRenderer.invoke('crawler:importGraph', webUtils.getPathForFile(file)),
    // 公共资源库（跨项目共享的元素选择器/网址）：{ elements:[{id,name,mode,value}], urls:[{id,name,value}] }
    getCommon: () => ipcRenderer.invoke('crawler:getCommon'),
    saveCommon: (data) => ipcRenderer.invoke('crawler:saveCommon', data),
    run: (opts) => ipcRenderer.invoke('crawler:run', opts),
    stop: () => ipcRenderer.invoke('crawler:stop'),
    // 断点继续：列出未完成运行 / 从断点续跑 / 丢弃断点
    pendingRuns: (id) => ipcRenderer.invoke('crawler:pendingRuns', id),
    continueRun: (opts) => ipcRenderer.invoke('crawler:continue', opts),
    discardRun: (opts) => ipcRenderer.invoke('crawler:discardRun', opts),
    // 登录窗口（与执行窗口同一持久会话，流程外登录目标站）
    openLogin: (url) => ipcRenderer.invoke('crawler:openLogin', url),
    saveResults: (opts) => ipcRenderer.invoke('crawler:saveResults', opts),
    // 选择表格文件（导入表格模块配置用；主进程弹框并解析，返回 { path, columns, rowCount }）
    pickTableFile: () => ipcRenderer.invoke('crawler:pickTableFile'),
    // 选择保存目录（表格导出模块配置用，返回 { path }）
    pickSaveDir: () => ipcRenderer.invoke('crawler:pickSaveDir'),
    // 实时日志（主进程推送 { projectId, runId, seq, ts, level, nodeId?, message }）
    onLog: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('crawler:log', listener)
      return () => ipcRenderer.removeListener('crawler:log', listener)
    },
    // 节点执行状态（{ projectId, runId, nodeId, status, error?, summary?, iteration?: {row,total} }）
    onNode: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('crawler:node', listener)
      return () => ipcRenderer.removeListener('crawler:node', listener)
    },
    // 整轮任务状态（{ projectId, runId, status: 'running'|'done'|'failed'|'stopped', rows?, error? }）
    onRun: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('crawler:run', listener)
      return () => ipcRenderer.removeListener('crawler:run', listener)
    },
    // 变量快照（{ projectId, runId, vars }）：每次变量变化（提取/接口拦截/表格行切换）全量推送
    onVars: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('crawler:vars', listener)
      return () => ipcRenderer.removeListener('crawler:vars', listener)
    },
    // 表格快照（{ projectId, runId, table }）：导入表格读入、表格编辑写入后全量推送（null=清空）
    onTable: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('crawler:table', listener)
      return () => ipcRenderer.removeListener('crawler:table', listener)
    },
  },
})
