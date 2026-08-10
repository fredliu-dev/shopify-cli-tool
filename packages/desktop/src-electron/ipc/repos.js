import { ipcMain, BrowserWindow, clipboard } from 'electron'
import { watch, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listEditors, openInEditor } from '../editor.js'

const load = () => import('@shopify-cli-tool/core')

/** 把消息推给渲染层（取首个窗口；桌面端只有一个主窗口）。 */
const send = (channel, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)

/** templates 下的 json 文件判定（与 CLI _pull-changed-json.js 一致）。 */
function isTemplateJson(p) {
  return /(^|\/)templates?\//i.test(p) && /\.json$/i.test(p)
}

/* -------- 文件监听：配置/templates 变动后重取该仓库状态并推给渲染层 -------- */
const watchers = new Map() // repoPath -> FSWatcher[]
const debounce = new Map() // repoPath -> timer

/** 重取单个仓库的最新状态（含 changedFiles）并推送。 */
async function refreshAndSend(repoPath, core) {
  try {
    const info = await core.getRepoInfo(repoPath)
    send('repos:repoUpdated', { repo: { ...info, ...core.getRepoStatus(repoPath, info.currentBranch) } })
  } catch {
    /* 仓库被删等：忽略 */
  }
}

/** 为单个仓库建立监听：根目录（catch 配置增删改）+ templates 目录（catch 模板改动）。 */
function watchRepo(repoPath, core) {
  // 先清掉旧监听
  watchers.get(repoPath)?.forEach((w) => {
    try {
      w.close()
    } catch {}
  })

  const trigger = () => {
    if (debounce.has(repoPath)) clearTimeout(debounce.get(repoPath))
    debounce.set(
      repoPath,
      setTimeout(() => {
        debounce.delete(repoPath)
        refreshAndSend(repoPath, core)
      }, 400),
    )
  }

  const ws = []
  try {
    ws.push(watch(repoPath, trigger)) // 根目录（非递归）：shopify.theme.toml 增删改
  } catch {}
  for (const tname of ['templates', 'template']) {
    const tdir = join(repoPath, tname)
    if (existsSync(tdir) && statSync(tdir).isDirectory()) {
      try {
        ws.push(watch(tdir, { recursive: true }, trigger))
      } catch {}
    }
  }
  if (ws.length) watchers.set(repoPath, ws)
}

/* -------- 工作区目录监听：子目录（仓库）新增/删除后重扫并同步 watchers -------- */
const workspaceWatcher = { watcher: null, dir: null, timer: null }

/** 关闭所有仓库内部监听（全量重扫/切换工作区前清理，避免旧监听残留误触发）。 */
function closeAllWatchers() {
  for (const ws of watchers.values()) {
    ws?.forEach((w) => {
      try {
        w.close()
      } catch {}
    })
  }
  watchers.clear()
}

/**
 * 重新扫描工作区：重取所有仓库状态，同步内部监听（新仓库建、消失仓库关），
 * 并把完整新列表推给渲染层整体替换。
 */
async function rescanWorkspace(dir, core) {
  try {
    const repos = await core.scanGitRepos(dir)
    const data = repos.map((r) => ({ ...r, ...core.getRepoStatus(r.path, r.currentBranch) }))
    const nextPaths = new Set(repos.map((r) => r.path))
    // 已不存在的仓库：关闭其内部监听
    for (const p of [...watchers.keys()]) {
      if (!nextPaths.has(p)) {
        watchers.get(p)?.forEach((w) => {
          try {
            w.close()
          } catch {}
        })
        watchers.delete(p)
      }
    }
    // 新出现的仓库：建立内部监听
    data.forEach((r) => {
      if (!watchers.has(r.path)) watchRepo(r.path, core)
    })
    send('repos:reposChanged', { data })
  } catch {
    /* 工作区被删等：忽略 */
  }
}

/** 监听工作区目录本身（非递归）：子目录增删即触发重扫（debounce）。 */
function watchWorkspace(dir, core) {
  try {
    workspaceWatcher.watcher?.close()
  } catch {}
  if (workspaceWatcher.timer) {
    clearTimeout(workspaceWatcher.timer)
    workspaceWatcher.timer = null
  }
  workspaceWatcher.dir = dir
  const trigger = () => {
    if (workspaceWatcher.timer) clearTimeout(workspaceWatcher.timer)
    workspaceWatcher.timer = setTimeout(() => {
      workspaceWatcher.timer = null
      rescanWorkspace(dir, core)
    }, 600)
  }
  try {
    workspaceWatcher.watcher = watch(dir, trigger)
  } catch {}
}

/**
 * repos 域 IPC handlers：仓库工作台（扫描/状态/初始化复用 config/保存/复制 live/拉取/运行/编辑器）。
 * core 是 ESM 包，CJS 主进程用动态 import 加载。
 */
export function registerReposIpc() {
  // 扫描工作区一层仓库，逐个附带 toml 状态与本地项目匹配结果
  ipcMain.handle('repos:scan', async (_evt, dir) => {
    const core = await load()
    try {
      const repos = await core.scanGitRepos(dir)
      const data = repos.map((r) => ({ ...r, ...core.getRepoStatus(r.path, r.currentBranch) }))
      // 全量重扫：先关闭所有旧监听（含上一个工作区残留），再按新结果重建
      closeAllWatchers()
      // 为每个仓库建立文件监听（配置/templates 变动后实时刷新）
      data.forEach((r) => watchRepo(r.path, core))
      // 监听工作区目录本身：子目录（仓库）新增/删除后实时重扫
      watchWorkspace(dir, core)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 单仓库完整状态（init/save 后局部刷新，免全量重扫）
  ipcMain.handle('repos:status', async (_evt, repoPath) => {
    const { getRepoInfo, getRepoStatus } = await load()
    try {
      const info = await getRepoInfo(repoPath)
      return { ok: true, data: { ...info, ...getRepoStatus(repoPath, info.currentBranch) } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 保存为本地项目（shop add 的 headless 核心）：写回 toml + upsert projects.json
  // templateName 由前端在 store 反查不到模板时让用户选好后传入，覆盖按 store 的反查
  ipcMain.handle('repos:save', async (_evt, { dir, envName, fields, templateName, tapd }) => {
    const { upsertProjectFromConfig, listBranches } = await load()
    try {
      // 取当前分支记入 _branch（区分不同分支的项目）
      const { current: branch } = await listBranches(dir)
      return { ok: true, data: upsertProjectFromConfig({ startDir: dir, envName, fields, branch, templateName, tapd }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 模板名列表（过滤 empty 占位）：供「本地保存」在 store 反查不到模板时让用户选
  ipcMain.handle('repos:templates', async () => {
    const { listTemplates } = await load()
    try {
      return { ok: true, data: listTemplates().filter((t) => t.name !== 'empty').map((t) => t.name) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 按 store 反查模板名；store 不在任何模板的 dev.store 里时返回 null（前端据此弹出模板选择）
  ipcMain.handle('repos:resolveTemplate', async (_evt, store) => {
    const { storeToTemplate } = await load()
    try {
      return { ok: true, data: storeToTemplate(store) ?? null }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 复制线上 live 主题（headless）：返回新 theme id + 链接；namePrefix 覆盖主题名前缀（如 'release'）
  ipcMain.handle('repos:copyLive', async (_evt, { dir, envName, envConfig, activity, owner, namePrefix }) => {
    const { duplicateLiveTheme } = await load()
    try {
      const res = await duplicateLiveTheme({ cwd: dir, envName, envConfig, activity, owner, namePrefix })
      if (res.ok) return { ok: true, data: { id: res.id, name: res.name, links: res.links } }
      return { ok: false, error: `复制主题失败（${res.stage}，退出码 ${res.code}）`, stderr: res.stderr }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 当前分支改动过的 templates json（供运行前多选拉取）
  ipcMain.handle('repos:changedJson', async (_evt, { dir }) => {
    const { getChangedFiles } = await load()
    try {
      const files = (await getChangedFiles(dir)).filter(isTemplateJson)
      return { ok: true, data: files }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /**
   * 拼接「选中的改动 json pull + theme dev」为一条命令（与 shop async 对齐）。
   * pullFiles 为空时只跑 dev。不含 cd：编辑器已用该仓库目录打开（openInEditor），
   * 其集成终端 cwd 即为项目根，shopify 能直接定位 shopify.theme.toml，粘贴即用。
   *
   * 命令分隔符按平台选：mac/linux 用 `&&`（单行、pull 失败则不跑 dev、粘贴无多行确认弹窗；
   * 这些 shell 都支持 &&）；Windows 改用换行——`&&` 在老版 PowerShell 5.1 不被支持，
   * 而换行对 cmd / PowerShell（5.1 与 7）/ Git Bash 都通用（粘贴时逐行执行）。
   * （此命令仅写入剪贴板由用户手动粘贴，故换行不会影响任何自动注入路径。）
   */
  function buildAsyncCommand(pullFiles, env = 'dev') {
    const parts = []
    if (Array.isArray(pullFiles) && pullFiles.length) {
      const only = pullFiles.map((f) => `--only "${f}"`).join(' ')
      parts.push(`shopify theme pull -e ${env} ${only}`)
    }
    parts.push(`shopify theme dev --theme-editor-sync -e ${env}`)
    return parts.join(process.platform === 'win32' ? '\n' : ' && ')
  }

  // 打开编辑器到该仓库目录，并把启动命令（pull + theme dev）复制到剪贴板；不再自动注入/
  // 执行——用户在编辑器终端粘贴运行即可。命令已含 cd + INIT_CWD，粘贴即用、无需改环境。
  ipcMain.handle('repos:runCommand', async (_evt, { dir, editorId, pullFiles }) => {
    try {
      const command = buildAsyncCommand(pullFiles)
      clipboard.writeText(command) // 启动命令写入剪贴板
      try {
        openInEditor(dir, editorId) // 打开编辑器到该仓库目录
      } catch {}
      return { ok: true, command }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 列出本机已装编辑器
  ipcMain.handle('repos:editors', () => ({ ok: true, data: listEditors() }))

  // 用默认编辑器打开仓库目录
  ipcMain.handle('repos:openInEditor', (_evt, { dir, editorId }) => {
    try {
      openInEditor(dir, editorId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 当前分支 + 本地分支列表（供弹窗选基准/目标/主分支）
  ipcMain.handle('repos:branches', async (_evt, dir) => {
    const { listBranches } = await load()
    try {
      return { ok: true, data: await listBranches(dir) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 分支切换下拉懒加载：fetch origin 后列本地+远程全部分支（去 origin/ 前缀）
  ipcMain.handle('repos:remoteBranches', async (_evt, repoPath) => {
    const { listAllBranches } = await load()
    try {
      return { ok: true, data: await listAllBranches(repoPath) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 切换本地分支（git checkout）
  ipcMain.handle('repos:checkout', async (_evt, { dir, branch }) => {
    const { checkoutBranch } = await load()
    try {
      const res = await checkoutBranch(dir, branch)
      if (res.ok) return { ok: true }
      return { ok: false, error: res.error }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 基于基准分支创建并切到新分支（先 fetch origin/<base>，回退本地 <base>）；
  // push=true 时先校验远程同名分支再推到 origin（「拉取分支」用，远程已存在则拒绝创建）
  ipcMain.handle('repos:createBranch', async (_evt, { dir, base, name, push }) => {
    const { createBranch } = await load()
    try {
      const res = await createBranch(dir, { base, name, fetch: true, push })
      if (res.ok) return { ok: true }
      return { ok: false, error: res.error }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 工作区未提交文件列表（合并前脏检查）
  ipcMain.handle('repos:workingTree', async (_evt, { dir }) => {
    const { workingTreeFiles } = await load()
    try {
      return { ok: true, data: await workingTreeFiles(dir) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 合并：source(开发) → target(release)，合并前先合 main(主) 解冲突
  ipcMain.handle('repos:merge', async (_evt, { dir, source, target, main }) => {
    const { mergeBranches } = await load()
    try {
      const res = await mergeBranches(dir, { source, target, main })
      if (res.ok) return { ok: true }
      return { ok: false, error: `（${res.step}）${res.error}` }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 列出模板里带 _github 的项目模板，并标注其仓库是否已在工作区存在（供「创建项目」查重）
  ipcMain.handle('repos:cloneableTemplates', async (_evt, workspaceDir) => {
    const { listTemplates, loadTemplateEnv, repoNameFromUrl } = await load()
    try {
      const out = []
      for (const t of listTemplates()) {
        const github = loadTemplateEnv(t.name)?._github
        if (!github) continue
        const repoName = repoNameFromUrl(github)
        out.push({ name: t.name, github, repoName, exists: existsSync(join(workspaceDir, repoName)) })
      }
      return { ok: true, data: out }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 克隆模板 _github 仓库到工作区（成功后目录监听会自动重扫）
  ipcMain.handle('repos:clone', async (_evt, { workspaceDir, github }) => {
    const { cloneRepo } = await load()
    try {
      const res = await cloneRepo(github, workspaceDir)
      if (res.ok) return { ok: true, data: { path: res.path } }
      return { ok: false, error: res.error }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
