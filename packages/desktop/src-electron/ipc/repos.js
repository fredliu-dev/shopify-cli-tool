import { ipcMain, BrowserWindow } from 'electron'
import { watch, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listEditors, openInEditor } from '../editor.js'

const load = () => import('@shopify-cli-tool/core')

/** 把消息推给渲染层（取首个窗口；桌面端只有一个主窗口）。 */
const send = (channel, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)

/* -------- 文件监听：配置/templates 变动后重取该仓库状态并推给渲染层 -------- */
const watchers = new Map() // repoPath -> FSWatcher[]
const debounce = new Map() // repoPath -> timer

/** 重取单个仓库的最新状态（含 changedFiles）并推送。 */
async function refreshAndSend(repoPath, core) {
  try {
    const info = await core.getRepoInfo(repoPath)
    send('repos:repoUpdated', { repo: { ...info, ...core.getRepoStatus(repoPath, info.currentBranch, { remote: info.remoteUrl }) } })
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
    const data = repos.map((r) => ({ ...r, ...core.getRepoStatus(r.path, r.currentBranch, { remote: r.remoteUrl }) }))
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
 * repos 域 IPC handlers：仓库工作台（扫描/状态/初始化复用 config/保存/复制 live/切换配置/编辑器）。
 * core 是 ESM 包，CJS 主进程用动态 import 加载。
 */
export function registerReposIpc() {
  // 扫描工作区一层仓库，逐个附带 toml 状态与本地项目匹配结果
  ipcMain.handle('repos:scan', async (_evt, dir) => {
    const core = await load()
    try {
      const repos = await core.scanGitRepos(dir)
      const data = repos.map((r) => ({ ...r, ...core.getRepoStatus(r.path, r.currentBranch, { remote: r.remoteUrl }) }))
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
      return { ok: true, data: { ...info, ...getRepoStatus(repoPath, info.currentBranch, { remote: info.remoteUrl }) } }
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

  // 把仓库的 shopify.theme.toml 切换到指定本地项目配置（项目卡片「切换」按钮）：
  // 不复制命令、不打开编辑器，只把 [environments.dev] 改成该项目字段，使其成为「当前生效」。
  ipcMain.handle('repos:switchConfig', async (_evt, { dir, projectId }) => {
    const { switchConfigToProject } = await load()
    try {
      return { ok: true, data: await switchConfigToProject(dir, projectId) }
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

  // 切换本地分支（git checkout）：成功后同步 shopify.theme.toml 到目标分支对应的项目配置
  // （该分支无项目则删 toml；toml 被 git 跟踪则跳过，由 git 自行切换）。createBranch 不走这里——
  // 新建分支必然无项目，同步会删掉正在用的配置，故 createBranch 豁免。
  ipcMain.handle('repos:checkout', async (_evt, { dir, branch }) => {
    const { checkoutBranch, syncConfigForBranch } = await load()
    try {
      const res = await checkoutBranch(dir, branch)
      if (!res.ok) return { ok: false, error: res.error }
      const sync = await syncConfigForBranch(dir, branch)
      return { ok: true, data: { sync } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 基于基准分支创建并切到新分支（先 fetch origin/<base>，回退本地 <base>）；
  // push=true 时先校验远程同名分支再推到 origin（「拉取分支」用，远程已存在则拒绝创建）。
  // 与 checkout 一致：切到新分支后同步 toml——新分支名是全新的，几乎不会有对应本地项目，
  // 故通常结果是「无项目 → 删除上分支残留的 toml」，逼用户在新分支重新初始化/保存。
  ipcMain.handle('repos:createBranch', async (_evt, { dir, base, name, push }) => {
    const { createBranch, syncConfigForBranch } = await load()
    try {
      const res = await createBranch(dir, { base, name, fetch: true, push })
      if (!res.ok) return { ok: false, error: res.error }
      const sync = await syncConfigForBranch(dir, name)
      return { ok: true, data: { sync } }
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
