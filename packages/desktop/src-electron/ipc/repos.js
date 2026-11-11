import { ipcMain, BrowserWindow } from 'electron'
import { watch, existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { listEditors, openInEditor } from '../editor.js'

const load = () => import('@shopify-cli-tool/core')

/** shopify 失败输出取最后一条非空行（完整 stderr 常带堆栈/进度条，弹窗放不下）。 */
const lastLine = (s) =>
  (s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || '未知错误'

/** 把消息推给渲染层（取首个窗口；桌面端只有一个主窗口）。 */
const send = (channel, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)

/** 推送给全部窗口：引用图是独立窗口，进度事件不能再只发首个（主）窗口。 */
const broadcast = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, payload)
    } catch {
      /* 窗口销毁瞬间：跳过 */
    }
  }
}

/* -------- 引用图独立窗口（每仓库一个，重复点击聚焦已有窗口） -------- */
const depWindows = new Map() // repoPath -> BrowserWindow

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

/** 目录内（递归）是否存在 .json 文件，用于决定是否值得建监听。 */
function dirHasJson(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === 'release' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory() ? dirHasJson(full) : /\.json$/i.test(name)) return true
  }
  return false
}

/** 为单个仓库建立监听：根目录 + 所有一级子目录中含 .json 的（templates/config/locales/sections 等），改动后刷新状态。 */
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
  // 一级子目录逐个递归监听（含 .json 才监听，避开 node_modules 等大目录）
  let subNames = []
  try {
    subNames = readdirSync(repoPath)
  } catch {}
  for (const name of subNames) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === 'release' || name.startsWith('.')) continue
    const sub = join(repoPath, name)
    if (!existsSync(sub) || !statSync(sub).isDirectory()) continue
    if (!dirHasJson(sub)) continue
    try {
      ws.push(watch(sub, { recursive: true }, trigger))
    } catch {}
  }
  if (ws.length) watchers.set(repoPath, ws)
}

/* -------- 分支变化检测：监听 .git/HEAD，外部（终端/IDE）切分支后自动套用该分支的项目配置 -------- */
const lastBranchByRepo = new Map() // repoPath -> 上次已知分支（首次记录基线，之后比对判断变化）
const branchDebounce = new Map() // repoPath -> timer（与 toml 刷新的 debounce 分开，避免互相覆盖）

/**
 * 检测单个仓库的分支变化：与上次已知分支不同时，按新分支同步 shopify.theme.toml
 * （有对应本地项目 → 套用最近一条项目配置；无项目 → 删残留 toml），
 * 推送刷新后的仓库状态 + 分支同步结果（repos:branchSynced，渲染层据此提示）。
 * 与 in-app checkout 同一套 syncConfigForBranch；app 内切换操作会先更新基线，不会重复触发。
 */
async function checkBranchChange(repoPath, core) {
  try {
    const info = await core.getRepoInfo(repoPath)
    const prev = lastBranchByRepo.get(repoPath)
    lastBranchByRepo.set(repoPath, info.currentBranch)
    if (prev === undefined || info.currentBranch === prev) return
    const sync = await core.syncConfigForBranch(repoPath, info.currentBranch)
    await refreshAndSend(repoPath, core)
    send('repos:branchSynced', { path: repoPath, branch: info.currentBranch, sync })
  } catch {
    /* 仓库被删等：忽略 */
  }
}

/** 为单个仓库建立 .git/HEAD 监听：checkout/switch 会改写 HEAD，借其感知外部分支切换。 */
function watchGitHead(repoPath, core) {
  const gitDir = join(repoPath, '.git')
  if (!existsSync(join(gitDir, 'HEAD'))) return
  try {
    // 监听 .git 目录（非 HEAD 文件本身）：git 以「写临时文件 + rename」更新 HEAD，
    // 直接 watch 文件在 rename 后可能失效；watch 目录按 filename 过滤更稳
    const w = watch(gitDir, (_evt, filename) => {
      if (filename !== 'HEAD') return
      if (branchDebounce.has(repoPath)) clearTimeout(branchDebounce.get(repoPath))
      branchDebounce.set(
        repoPath,
        setTimeout(() => {
          branchDebounce.delete(repoPath)
          checkBranchChange(repoPath, core)
        }, 500),
      )
    })
    watchers.set(repoPath, [...(watchers.get(repoPath) || []), w])
  } catch {}
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
      if (!watchers.has(r.path)) {
        watchRepo(r.path, core)
        watchGitHead(r.path, core)
      }
      // 记录/刷新分支基线：避免重扫把上次已知分支覆盖成旧值导致误判
      lastBranchByRepo.set(r.path, r.currentBranch)
    })
    send('repos:reposChanged', { data })
  } catch {
    /* 工作区被删等：忽略 */
  }
}

/* -------- JSON 可视化：单个文件变化监听 -------- */
const jsonWatchers = new Map() // absPath -> FSWatcher

/** 关闭单个 JSON 文件的监听。 */
function closeJsonWatcher(path) {
  const w = jsonWatchers.get(path)
  if (w) {
    try {
      w.close()
    } catch {}
    jsonWatchers.delete(path)
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
      // 为每个仓库建立文件监听（配置/templates 变动后实时刷新）+ .git/HEAD 监听（外部分支切换检测）
      data.forEach((r) => {
        watchRepo(r.path, core)
        watchGitHead(r.path, core)
        lastBranchByRepo.set(r.path, r.currentBranch)
      })
      // 监听工作区目录本身：子目录（仓库）新增/删除后实时重扫
      watchWorkspace(dir, core)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 打开引用图独立窗口（标题=仓库名，hash 路由 #/dep-graph 渲染专用页面）；
  // 同仓库已开过则聚焦，不重复开
  ipcMain.handle('repos:openDepGraph', (_evt, { dir, name }) => {
    try {
      const existed = depWindows.get(dir)
      if (existed && !existed.isDestroyed()) {
        if (existed.isMinimized()) existed.restore()
        existed.focus()
        return { ok: true }
      }
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: name || '文件引用关系',
        backgroundColor: '#0d0d0f',
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      depWindows.set(dir, win)
      win.on('closed', () => depWindows.delete(dir))
      const hash = `#/dep-graph?${new URLSearchParams({ dir, name: name || '' }).toString()}`
      if (process.env.ELECTRON_RENDERER_URL) {
        win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${hash}`)
      } else {
        win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 扫描仓库内 Shopify 主题文件的静态引用关系（render/section/asset_url 等），供前端画关系图。
  // 默认读缓存（上次扫描结果，秒开）；force=true 清缓存重扫。
  // 扫描进度经 repos:depGraphProgress 广播到全部窗口（引用图是独立窗口，首个窗口不一定是它）。
  ipcMain.handle('repos:depGraph', async (_evt, { dir, force }) => {
    const { scanThemeDeps, loadDepGraphCache, saveDepGraphCache } = await load()
    try {
      if (!force) {
        const cached = loadDepGraphCache()[dir]
        if (cached) return { ok: true, cached: true, savedAt: cached.savedAt, data: cached.data }
      }
      const res = await scanThemeDeps(dir, {
        onProgress: (p) => broadcast('repos:depGraphProgress', { dir, ...p }),
      })
      // 空结果（非主题仓库）不缓存，避免下次点击直接命中空缓存、无法重试
      if (res.ok && res.data?.nodes?.length) saveDepGraphCache(dir, res.data)
      return { ...res, cached: false, savedAt: Date.now() }
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

  // 按仓库远程地址（origin）反查模板名：把 remote 与各模板 _github 比对，命中返回模板名；
  // 未命中返回 null（前端据此保留模板下拉让用户手选）。用于初始化弹窗按仓库地址自动选中模板。
  ipcMain.handle('repos:resolveTemplateByRemote', async (_evt, remoteUrl) => {
    const { templateFromRemote } = await load()
    try {
      return { ok: true, data: templateFromRemote(remoteUrl) ?? null }
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

  // 主题列表（theme list -j）：主题列表弹窗展示当前 store 全部主题（live 优先由前端排序）
  // store 优先走 --store（不依赖本地 toml，未创建本地项目也可用）；无 store 回退 -e 环境名
  ipcMain.handle('repos:themeList', async (_evt, { dir, envName, store }) => {
    const { listThemes } = await load()
    try {
      const res = await listThemes({ cwd: dir, envName: envName || 'dev', store })
      if (!res.ok) return { ok: false, error: `获取主题列表失败（退出码 ${res.code}）：${lastLine(res.stderr)}` }
      return { ok: true, data: res.themes }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 重命名线上主题（theme rename headless；仅改名称不影响发布状态，live 也可改）
  ipcMain.handle('repos:renameTheme', async (_evt, { dir, themeId, name, store }) => {
    const { renameTheme } = await load()
    try {
      const res = await renameTheme({ cwd: dir, envName: 'dev', themeId, name, store })
      if (!res.ok) return { ok: false, error: `重命名主题失败（退出码 ${res.code}）：${lastLine(res.stderr)}` }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 发布主题为线上 live（theme publish --force 跳过交互确认；live 不可发布由前端按 role 拦截）
  ipcMain.handle('repos:publishTheme', async (_evt, { dir, themeId, store }) => {
    const { publishTheme } = await load()
    try {
      const res = await publishTheme({ cwd: dir, envName: 'dev', themeId, store })
      if (!res.ok) return { ok: false, error: `发布主题失败（退出码 ${res.code}）：${lastLine(res.stderr)}` }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 查询项目 theme id 对应的线上主题信息（theme list -j）：删除主题前二次确认弹窗展示名称/角色用；
  // data=null 表示该主题在线上已不存在
  ipcMain.handle('repos:themeInfo', async (_evt, { dir, themeId, store }) => {
    const { getThemeInfo } = await load()
    try {
      const res = await getThemeInfo({ cwd: dir, envName: 'dev', themeId, store })
      if (!res.ok) return { ok: false, error: `查询主题失败（退出码 ${res.code}）：${lastLine(res.stderr)}` }
      return { ok: true, data: res.theme }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除项目 theme id 对应的线上主题（theme delete --force 跳过 CLI 交互确认），
  // 成功后按 store+theme 连带清理引用该主题的本地项目（deleteProjectsByTheme）
  ipcMain.handle('repos:deleteTheme', async (_evt, { dir, themeId, store }) => {
    const { deleteTheme, deleteProjectsByTheme } = await load()
    try {
      const res = await deleteTheme({ cwd: dir, envName: 'dev', themeId, store })
      if (!res.ok) return { ok: false, error: `删除主题失败（退出码 ${res.code}）：${lastLine(res.stderr)}` }
      // 线上主题已删（不可恢复），本地清理失败不回滚，把错误带回给前端提示即可
      let local = { deleted: 0, synced: 0 }
      let localError = null
      try {
        if (store) local = await deleteProjectsByTheme(store, themeId, dir)
      } catch (err) {
        localError = err.message
      }
      return { ok: true, deletedProjects: local.deleted, tomlDeleted: local.synced, localError }
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
  ipcMain.handle('repos:openInEditor', (_evt, { dir, editorId, file }) => {
    try {
      let target = file
      if (target) {
        // file 必须落在 dir 内且真实存在：VS Code 系 CLI 会把不存在的路径
        // 当成「无标题」新文件打开，这里先校验，避免弹出无标题空文件。
        // 必须传绝对路径给编辑器——CLI 对相对路径按「自身进程 cwd」解析，
        // 会跑到客户端工具所在目录下新建文件，而不是目标仓库
        const abs = isAbsolute(target) ? resolve(target) : resolve(dir, target)
        const relToDir = relative(dir, abs)
        const inside = relToDir && !relToDir.startsWith('..') && !isAbsolute(relToDir)
        target = inside && existsSync(abs) ? abs : null
      }
      openInEditor(dir, editorId, target)
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

  // 取仓库的 GitHub 协作者列表：token 优先取 settings.githubToken，回退 GH_TOKEN 环境变量
  ipcMain.handle('repos:collaborators', async (_evt, repoPath) => {
    const { getCollaborators, loadSettings } = await load()
    try {
      const token = loadSettings()?.githubToken
      return { ok: true, data: await getCollaborators(repoPath, token) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 创建 Pull Request 并请求 reviewer：opts={ dir, title, head, base, body, reviewers }
  ipcMain.handle('repos:createPull', async (_evt, { dir, title, head, base, body, reviewers }) => {
    const { createPullRequest, loadSettings } = await load()
    try {
      const token = loadSettings()?.githubToken
      const data = await createPullRequest(dir, { title, head, base, body, reviewers }, token)
      return { ok: true, data }
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
      lastBranchByRepo.set(dir, branch) // 刷新分支基线：HEAD 监听不必再对本次 app 内切换重复同步
      const sync = await syncConfigForBranch(dir, branch)
      return { ok: true, data: { sync } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 基于基准分支创建（默认并切到）新分支（先 fetch origin/<base>，回退本地 <base>）；
  // push=true 时先校验远程同名分支再推到 origin（远程已存在则拒绝创建）。
  // switch=false（「创建 release」用）：仅建分支不切换，此时仍停留在原分支，不做 toml 同步。
  // 默认（switch 不传/为 true，「拉取分支」用）：切到新分支后同步 toml——新分支名是全新的，
  // 几乎不会有对应本地项目，故通常结果是「无项目 → 删除上分支残留的 toml」，逼用户在新分支重新初始化/保存。
  ipcMain.handle('repos:createBranch', async (_evt, { dir, base, name, push, switch: doSwitch }) => {
    const { createBranch, syncConfigForBranch } = await load()
    try {
      const res = await createBranch(dir, { base, name, fetch: true, push, switch: doSwitch })
      if (!res.ok) return { ok: false, error: res.error }
      // 仅在切到新分支时才同步 toml；不切换时仍停留在原分支，配置保持原样
      if (doSwitch !== false) lastBranchByRepo.set(dir, name) // 刷新基线，避免 HEAD 监听重复同步
      const sync = doSwitch === false ? undefined : await syncConfigForBranch(dir, name)
      return { ok: true, data: { sync } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除分支（本地 + 远程，远程不存在时跳过）。删当前分支时先自动切到 main/master/其它本地分支，
  // 切换成功后同样同步 toml（与 checkout 一致：目标分支无项目则清配置）。
  ipcMain.handle('repos:deleteBranch', async (_evt, { dir, branch }) => {
    const { deleteBranch, syncConfigForBranch } = await load()
    try {
      const res = await deleteBranch(dir, { branch, deleteRemote: true })
      if (!res.ok) return res
      if (res.switchedTo) {
        lastBranchByRepo.set(dir, res.switchedTo) // 刷新基线，避免 HEAD 监听重复同步
        await syncConfigForBranch(dir, res.switchedTo)
      }
      return { ok: true, data: { remoteDeleted: res.remoteDeleted, switchedTo: res.switchedTo || null } }
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

  /* -------- JSON 可视化 -------- */

  // 列出仓库里可可视化的 JSON 文件（全仓库 .json，templates 优先）
  ipcMain.handle('repos:jsonVizList', async (_evt, dir) => {
    const { listThemeJsonFiles } = await load()
    try {
      return { ok: true, data: listThemeJsonFiles(dir) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取 JSON 文件并解析 key 含义（section schema / settings_schema）
  ipcMain.handle('repos:jsonVizRead', async (_evt, { dir, path }) => {
    const { readJsonFile, resolveJsonMeta } = await load()
    try {
      const { raw, data } = readJsonFile(path)
      if (data == null) return { ok: false, error: 'JSON 解析失败' }
      const meta = resolveJsonMeta(dir, path, data)
      return { ok: true, data, meta, raw }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 写入 JSON 文件（value 为对象，按 2 空格缩进写入）
  ipcMain.handle('repos:jsonVizWrite', async (_evt, { path, value }) => {
    const { writeJsonFile } = await load()
    try {
      writeJsonFile(path, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 保存一份版本快照（写入 userDataDir/json-versions/<hash>/<ts>.json）
  ipcMain.handle('repos:jsonVizSaveVersion', async (_evt, { dir, path, content, name }) => {
    const { saveJsonVersion } = await load()
    try {
      return { ok: true, data: saveJsonVersion(dir, path, content, undefined, name) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 重命名 / 删除历史版本
  ipcMain.handle('repos:jsonVizRenameVersion', async (_evt, opts) => {
    const { renameJsonVersion } = await load()
    try {
      return { ok: true, data: renameJsonVersion(opts.dir, opts.path, opts.id, opts.name) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('repos:jsonVizDeleteVersion', async (_evt, opts) => {
    const { deleteJsonVersions } = await load()
    try {
      // 兼容单个 id 和批量 ids 两种入参
      const ids = Array.isArray(opts.ids) ? opts.ids : [opts.id]
      return { ok: true, data: deleteJsonVersions(opts.dir, opts.path, ids) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 列出某个 section 类型在 schema 里定义的全部 block 类型（供「添加区块」选择）
  ipcMain.handle('repos:jsonVizBlockTypes', async (_evt, { dir, sectionType }) => {
    const { listSectionBlockTypes } = await load()
    try {
      return { ok: true, data: listSectionBlockTypes(dir, sectionType) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // ---- 近期改动记录 ----

  // 记录一次文件改动（保存/切换/采用外部修改时调用）
  ipcMain.handle('repos:jsonVizAddRecent', async (_evt, entry) => {
    const { addJsonRecent } = await load()
    try {
      return { ok: true, data: addJsonRecent(entry) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取近期改动列表
  ipcMain.handle('repos:jsonVizListRecent', async () => {
    const { listJsonRecent } = await load()
    try {
      return { ok: true, data: listJsonRecent().items }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除单条近期改动
  ipcMain.handle('repos:jsonVizRemoveRecent', async (_evt, { repoDir, rel }) => {
    const { removeJsonRecent } = await load()
    try {
      return { ok: true, data: removeJsonRecent(repoDir, rel) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 清空全部近期改动
  ipcMain.handle('repos:jsonVizClearRecent', async () => {
    const { clearJsonRecent } = await load()
    try {
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 列出某文件的所有版本（按时间倒序），并附带与磁盘当前内容匹配的版本 id
  ipcMain.handle('repos:jsonVizVersions', async (_evt, { dir, path }) => {
    const { listJsonVersions, matchVersionId, readJsonFile } = await load()
    try {
      const data = listJsonVersions(dir, path)
      let matchedId = null
      try {
        // readJsonFile 返回 { raw, data }，用 data（纯 JSON 内容）做版本比对
        const disk = readJsonFile(path)
        matchedId = matchVersionId(dir, path, JSON.stringify(disk.data, null, 2))
      } catch {
        /* 磁盘文件读不了就不校准 */
      }
      return { ok: true, data, matchedId }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 加载某版本的内容（字符串）
  ipcMain.handle('repos:jsonVizLoadVersion', async (_evt, { dir, path, id }) => {
    const { loadJsonVersion } = await load()
    try {
      const raw = loadJsonVersion(dir, path, id)
      if (raw == null) return { ok: false, error: '版本不存在' }
      return { ok: true, data: raw }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 监听单个 JSON 文件变化：变化时 debounce 300ms 推 repos:jsonFileChanged { path }
  ipcMain.handle('repos:jsonVizWatch', (_evt, path) => {
    closeJsonWatcher(path)
    let timer = null
    try {
      const w = watch(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          send('repos:jsonFileChanged', { path })
        }, 300)
      })
      jsonWatchers.set(path, w)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 取消监听单个 JSON 文件
  ipcMain.handle('repos:jsonVizUnwatch', (_evt, path) => {
    closeJsonWatcher(path)
    return { ok: true }
  })
}
