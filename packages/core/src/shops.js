/**
 * 首批命令的纯逻辑（headless）：供 CLI 与 Electron 桌面应用共用。
 * 这些函数只读写数据/解析配置，不打印、不提问；展示与交互由各自的壳负责。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProjects, saveProjects } from './projects.js'
import { buildThemeConfig, listTemplates, loadTemplateEnv, resolveEnvironment, loadThemeConfig, setEnvField, storeToTemplate } from './config.js'
import { buildLinks } from './links.js'
import { getRemoteUrl, isTomlTracked, repoNameFromUrl } from './git.js'
import { getPortPids, killPort } from './port.js'

/**
 * 给单个 project 补预览链接（domain/store 缺失时从模板补，同 assembleProjects）。
 * @param {object} p
 * @returns {object & { links: object } | null}
 */
function withLinks(p) {
  if (!p) return null
  const tplEnv = loadTemplateEnv(p.templateName)
  const links = buildLinks({
    domain: p.domain ?? tplEnv.domain,
    store: p.store ?? tplEnv.store,
    theme: p.theme,
    preview_key: p.previewKey,
    preview_path: p.previewPath,
    port: p.port,
  })
  return { ...p, links }
}

/**
 * 从 project_desc 复合文本里拆分工单链接：第一个 http(s) 链接 → tapd，剩余去【】括号并 trim → 标题。
 * 工单链接只进 projects.json 的 _tapd，不进 shopify.theme.toml（与桌面端一致）。
 * CLI `shop add`/`shop edit` 的描述输入与桌面端表单共用此逻辑，避免正则漂移。
 * @param {string} raw 用户输入的描述（可能含工单链接）
 * @returns {{ desc: string, tapd: string|null }}
 */
export function splitDesc(raw) {
  if (!raw) return { desc: '', tapd: null }
  const m = String(raw).match(/https?:\/\/\S+/i)
  const tapd = m ? m[0] : null
  const desc = (tapd ? String(raw).replace(tapd, '') : String(raw))
    .replace(/[【】]/g, '')
    .trim()
  return { desc, tapd }
}

/**
 * 组装所有项目的展示数据（含预览链接）—— `ls` 的纯逻辑。
 * projects.json 里没存 domain/store，从模板的 [environments.dev] 补齐。
 * @returns {Array<object>} 每项为原 project 字段并附加 `links`
 */
export function assembleProjects() {
  return loadProjects().map(withLinks)
}

/**
 * 按 id 删除项目 —— `del` 的纯逻辑。
 * @param {Array<string|number>} ids
 * @returns {number} 实际删除数量
 */
export function deleteProjects(ids) {
  const idSet = new Set(ids)
  const projects = loadProjects()
  const remaining = projects.filter((p) => !idSet.has(p.id))
  saveProjects(remaining)
  return projects.length - remaining.length
}

/**
 * 按 id 更新单个项目字段 —— `edit` 的纯逻辑。
 * @param {string|number} id
 * @param {object} fields 任意子集（theme/previewKey/port/description/templateName…）
 * @returns {object|null} 更新后的项目，找不到返回 null
 */
export function updateProject(id, fields) {
  const projects = loadProjects()
  let updated = null
  const next = projects.map((p) => {
    if (p.id === id) {
      updated = { ...p, ...fields }
      return updated
    }
    return p
  })
  saveProjects(next)
  return updated
}

/**
 * 项目字段名 → toml [environments.dev] 键名映射。
 * 仅可编辑且需回写 toml 的字段；store/domain 是项目身份只读字段（改了即新项目，不入 toml）。
 */
const PROJECT_FIELD_TO_TOML = {
  theme: 'theme',
  previewKey: 'preview_key',
  previewPath: 'preview_path',
  port: 'port',
  description: 'project_desc',
}

/**
 * 编辑本地项目；若该项目是某仓库「当前生效」的项目，同步把改动回写该仓库的 shopify.theme.toml。
 *
 * 为何需要同步：项目与 toml 靠六要素（store/domain/theme/preview_key/project_desc/_branch）判同一性。
 * 编辑 theme/preview_key/port/description 后 projects.json 已是新值、toml 仍是旧值 →
 * 既导致配置不一致（跑 dev 仍用旧 theme/port），又令六要素失配、「当前生效」标识消失。
 * 故仅在「编辑前该项目就是当前生效（命中 toml dev 环境）」时回写新值，保持一致与命中；
 * 非当前生效项目不动 toml（toml 反映的是当前生效项，否则会静默切换生效配置）。
 *
 * 「当前生效」判定必须用编辑前的旧项目和 toml 比——toml 此刻仍是旧值，旧项目命中才说明它原本是生效项。
 * 回写用 setEnvField 逐字段改值（保留 toml 原格式，与 upsertProjectFromConfig 一致），
 * 不重建整份 toml（避免 switchConfigToProject 的杀端口副作用）。toml 被 git 跟踪时跳过回写
 * （与 syncConfigForBranch / switchConfigToProject 一致，避免污染工作区、阻塞合并）。
 *
 * @param {string|number} id
 * @param {object} fields 项目字段（previewKey/description/port/theme…，项目字段名）
 * @param {string} [repoPath] 关联仓库目录；不传则只更 projects.json、不回写 toml（无仓库上下文场景）
 * @returns {Promise<{ project: object|null, synced: boolean, skipped?: 'tracked'|'not-active'|'no-toml' }>}
 */
export async function updateProjectSynced(id, fields, repoPath) {
  // 用「旧项目」判定是否当前生效：toml 仍是旧值，旧项目命中 toml 才说明它原本就是生效项
  const old = loadProjects().find((p) => p.id === id) || null
  const wasActive = (() => {
    if (!old || !repoPath) return false
    const devEnv = loadThemeConfig(repoPath)?.environments?.dev
    if (!devEnv) return false
    return isSameProject(old, devEnv, devEnv._branch ?? null)
  })()

  // 更新 projects.json（复用既有 updateProject 的写盘逻辑）
  const updated = updateProject(id, fields)

  if (!wasActive) return { project: updated, synced: false, skipped: repoPath ? 'not-active' : undefined }

  // 当前生效 → 回写 toml。被 git 跟踪则跳过（保持工作区干净）
  if (await isTomlTracked(repoPath)) return { project: updated, synced: false, skipped: 'tracked' }

  const cfg = loadThemeConfig(repoPath)
  if (!cfg) return { project: updated, synced: false, skipped: 'no-toml' }
  let content = readFileSync(cfg.path, 'utf8')
  for (const [k, v] of Object.entries(fields)) {
    const tomlKey = PROJECT_FIELD_TO_TOML[k]
    if (tomlKey && v !== undefined && v !== null) content = setEnvField(content, 'dev', tomlKey, v)
  }
  writeFileSync(cfg.path, content, 'utf8')
  return { project: withLinks(updated), synced: true }
}

/**
 * 删除本地项目；若该项目是某仓库「当前生效」的项目，同步删除该仓库的 shopify.theme.toml。
 *
 * 与 updateProjectSynced 对称：编辑时当前生效项把新值回写 toml，删除时当前生效项把 toml 一并清掉，
 * 让仓库回到未初始化状态（与 syncConfigForBranch「该分支无项目则删 toml」一致）。非当前生效项目只删
 * projects.json——toml 反映的是当前生效项，删一条未生效项目不该牵连改动生效配置。
 *
 * 「当前生效」判定与 updateProjectSynced 同源：用删除前的旧项目和 toml dev 环境比，旧项目命中才说明
 * 它原本就是生效项（删 projects.json 不影响 toml，故在删前后判定等价；这里在删前判，与 update 一致）。
 * toml 被 git 跟踪时跳过删除（与全链路一致，避免污染工作区、阻塞合并）。
 *
 * @param {string|number} id
 * @param {string} [repoPath] 关联仓库目录；不传则只删 projects.json、不删 toml（无仓库上下文场景）
 * @returns {Promise<{ deleted: number, synced: boolean, skipped?: 'tracked'|'not-active'|'no-toml' }>}
 */
export async function deleteProjectSynced(id, repoPath) {
  // 用「旧项目」判定是否当前生效（与 updateProjectSynced 同源）
  const old = loadProjects().find((p) => p.id === id) || null
  const wasActive = (() => {
    if (!old || !repoPath) return false
    const devEnv = loadThemeConfig(repoPath)?.environments?.dev
    if (!devEnv) return false
    return isSameProject(old, devEnv, devEnv._branch ?? null)
  })()

  // 删除 projects.json（复用既有 deleteProjects 的写盘逻辑）
  const deleted = deleteProjects([id])

  if (!wasActive) return { deleted, synced: false, skipped: repoPath ? 'not-active' : undefined }

  // 当前生效 → 删除 toml。被 git 跟踪则跳过（保持工作区干净）
  if (await isTomlTracked(repoPath)) return { deleted, synced: false, skipped: 'tracked' }

  const tomlPath = join(repoPath, 'shopify.theme.toml')
  if (!existsSync(tomlPath)) return { deleted, synced: false, skipped: 'no-toml' }
  unlinkSync(tomlPath)
  return { deleted, synced: true }
}

/**
 * 取某环境的提测链接 —— `pre` 的纯逻辑。
 * @param {{ startDir?: string, envName?: string, args?: string[] }} [opts]
 *   - startDir: 项目目录（GUI 传入；CLI 默认 cwd）
 *   - envName:  环境名，默认 'dev'（args 缺省时用）
 *   - args:     含 -e/--environment 的参数（优先于 envName）
 * @returns {{ devLink:string, previewLink:string, adminLink:string, editorLink:string } | null}
 *   找不到环境配置返回 null
 */
export function getDevLinks({ startDir, envName = 'dev', args } = {}) {
  const env = resolveEnvironment(args ?? ['-e', envName], startDir)
  if (!env) return null
  return buildLinks(env)
}

/**
 * 项目身份判定：与 CLI `shop add` 一致的六要素——store + domain + theme + preview_key + project_desc + _branch。
 * 任一可编辑属性（domain/theme/preview_key/project_desc）变化即视为新项目，使 CLI 与桌面端行为统一：
 * previewKey 改了之后两边都会新增项目（而非 UI 仍命中旧项目导致保存按钮不可点 / 孤儿项目不可见）。
 * 字段名映射：project 用 previewKey/description，env(toml) 用 preview_key/project_desc；
 * theme、preview_key 比对前规范化（String + ?? ''），避免数字/undefined 造成误判。
 * 历史项目未记录 _branch（null/undefined）时视为通配，避免升级后已存项目全部失配。
 * @param {object} p 已存项目
 * @param {object} env toml 环境对象
 * @param {string} [branch] 当前 git 分支（由调用方从 git 取得传入）
 * @returns {boolean}
 */
function isSameProject(p, env, branch) {
  if (p.store !== env.store) return false
  // 字符串字段比对前 trim：buildThemeConfig 写入会 trim、而项目存储未 trim，
  // 不 trim 会导致切换分支重建 toml 后 matched 失配（「当前生效」标识消失）
  if (String(p.domain ?? '').trim() !== String(env.domain ?? '').trim()) return false
  if (String(p.theme).trim() !== String(env.theme).trim()) return false
  if (String(p.previewKey ?? '').trim() !== String(env.preview_key ?? '').trim()) return false
  if (String(p.description ?? '').trim() !== String(env.project_desc ?? '').trim()) return false
  // 新项目必须与当前分支一致；历史项目无 _branch 视为通配
  if (p._branch == null) return true
  return p._branch === branch
}

/**
 * 在本地 projects.json 里找与某 toml 环境一致的项目（含链接），找不到返回 null。
 * 用于判断仓库「是否已保存为本地项目」。branch 为当前 git 分支，参与 _branch 比对。
 * @param {object} env toml 环境对象
 * @param {string} [branch] 当前 git 分支
 * @returns {object | null}
 */
export function findSavedProject(env, branch) {
  if (!env || !env.store) return null
  const hit = loadProjects().find((p) => isSameProject(p, env, branch))
  return hit ? withLinks(hit) : null
}

/**
 * 取单个仓库的配置状态：有没有 shopify.theme.toml、dev 环境内容、是否已存为本地项目。
 * branch 为当前 git 分支，传入后参与本地项目的 _branch 比对（区分不同分支的项目）。
 *
 * toml 缺失时不再彻底失联：仓库↔项目的关联桥梁本就是 dev.store，而 store 可由仓库远程地址
 * 反查模板得到（见 storeFromRemote）。故 toml 不在时，用 remote 推出 store 维持关联——
 * 卡片上的本地项目不至于消失，且切到有项目的分支时 syncConfigForBranch 会按 store 重建 toml。
 * remote 由调用方从 getRepoInfo().remoteUrl 传入（扫描时已取，不额外加 git 调用）。
 * @param {string} repoPath 仓库目录
 * @param {string} [branch] 当前 git 分支
 * @param {{ remote?: string }} [opts] remote 为仓库 origin 地址，toml 缺失时用于反查 store
 * @returns {{ hasToml: boolean, devEnv: object | null, matched: object | null }}
 */
export function getRepoStatus(repoPath, branch, { remote } = {}) {
  const hasToml = existsSync(join(repoPath, 'shopify.theme.toml'))
  if (hasToml) {
    const cfg = loadThemeConfig(repoPath)
    const devEnv = cfg?.environments?.dev ?? null
    return { hasToml: true, devEnv, matched: devEnv ? findSavedProject(devEnv, branch) : null }
  }
  // toml 缺失：按远程地址反查 store，仅保留 store 作为关联身份（其余运行字段无来源，留空）
  const store = remote ? storeFromRemote(remote) : null
  const devEnv = store ? { store } : null
  return { hasToml: false, devEnv, matched: devEnv ? findSavedProject(devEnv, branch) : null }
}

/**
 * 由仓库远程地址反推 store：把 remote 与各模板 [environments.dev]._github 比对（按仓库名归一化，
 * 兼容 SSH/HTTPS），命中模板的 store 即仓库身份。用于 toml 缺失/无 store 时仍能关联本地项目。
 * @param {string} remoteUrl 仓库的 origin 地址
 * @returns {string | null} 命中模板的 store；无 _github 或无 store 返回 null
 */
function storeFromRemote(remoteUrl) {
  if (!remoteUrl) return null
  const target = repoNameFromUrl(remoteUrl)
  if (!target) return null
  for (const t of listTemplates()) {
    const env = loadTemplateEnv(t.name)
    if (env?._github && repoNameFromUrl(env._github) === target && env.store) {
      return env.store
    }
  }
  return null
}

/**
 * 由仓库远程地址反查模板名：把 remote 与各模板 [environments.dev]._github 比对（按仓库名归一化，
 * 兼容 SSH/HTTPS），命中返回模板名。与 storeFromRemote 同源匹配，但不要求模板含 store、返回的是
 * 模板名。用于初始化弹窗按仓库地址自动选中模板（匹配到直接填充，省去用户手选）。
 * @param {string} remoteUrl 仓库的 origin 地址
 * @returns {string | null} 命中模板的 name；无 _github 或未命中返回 null
 */
export function templateFromRemote(remoteUrl) {
  if (!remoteUrl) return null
  const target = repoNameFromUrl(remoteUrl)
  if (!target) return null
  for (const t of listTemplates()) {
    const env = loadTemplateEnv(t.name)
    if (env?._github && repoNameFromUrl(env._github) === target) return t.name
  }
  return null
}

/**
 * 把某 toml 环境「保存为本地项目」的 headless 逻辑（shop add 的核心，去掉交互）。
 *   1. 读 toml 的 env，合并调用方填好的 fields（domain/port/theme/preview_key/project_desc）
 *   2. 把 fields 写回 shopify.theme.toml（保持格式）；同时把当前分支记到 _branch（供「合并」取源分支）
 *   3. 按 store 定位模板（可由 templateName 覆盖，用于 store 反查不到模板时由调用方指定），构 project；
 *      按六要素（store/domain/theme/preview_key/project_desc/_branch）命中已有项目则跳过，否则新增
 * @param {{ startDir: string, envName?: string, fields?: object, branch?: string, templateName?: string, tapd?: string }} opts
 *   fields 用 toml 键名（preview_key / project_desc）；branch 为当前 git 分支；
 *   templateName 覆盖按 store 反查到的模板（GUI 在 store 反查不到模板时让用户选好后传入）；
 *   tapd 为从 project_desc 复合文本里拆出的工单链接，只记到 projects.json 的 _tapd（不写回 toml）
 * @returns {{ project: object, created: boolean }} project 含 links
 * @throws {Error} 缺配置文件 / 缺环境 / 缺 store 时抛错，由调用方提示
 */
export function upsertProjectFromConfig({ startDir, envName = 'dev', fields = {}, branch, templateName, tapd } = {}) {
  const cfg = loadThemeConfig(startDir)
  if (!cfg) throw new Error('未找到 shopify.theme.toml')
  const env = cfg.environments[envName]
  if (!env) throw new Error(`配置缺少 [environments.${envName}]`)
  if (!env.store) throw new Error(`[environments.${envName}] 缺少 store`)

  const resolved = { ...env, ...fields }

  // 把填好的字段写回 toml（保持原格式，仅改值/补行）
  let content = readFileSync(cfg.path, 'utf8')
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') content = setEnvField(content, envName, k, v)
  }
  // 记录当前分支到 _branch：既是项目身份的一部分，也供「合并」自动取源分支
  if (branch) content = setEnvField(content, envName, '_branch', branch)
  writeFileSync(cfg.path, content, 'utf8')

  const proj = {
    envName,
    templateName: templateName || storeToTemplate(resolved.store) || null,
    store: resolved.store,
    domain: resolved.domain,
    theme: String(resolved.theme),
    previewKey: String(resolved.preview_key ?? ''),
    previewPath: String(resolved.preview_path ?? ''),
    port: String(resolved.port),
    description: resolved.project_desc,
    _branch: branch || null,
    _tapd: tapd || null,
  }

  const projects = loadProjects()
  const dup = projects.find((p) => isSameProject(p, resolved, branch))
  if (dup) {
    // 命中已有项目：不在六要素里的字段（_tapd 衍生数据、preview_path/port 等非身份字段）
    // 单独回填为本次保存的值，不算"新建"——否则已存项目永远带不上后来才填的网页路径
    let dirty = false
    if (tapd && dup._tapd !== tapd) {
      dup._tapd = tapd
      dirty = true
    }
    const nextPath = String(resolved.preview_path ?? '')
    if (String(dup.previewPath ?? '') !== nextPath) {
      dup.previewPath = nextPath
      dirty = true
    }
    if (String(dup.port ?? '') !== String(resolved.port ?? '')) {
      dup.port = String(resolved.port)
      dirty = true
    }
    if (dirty) saveProjects(projects)
    return { project: withLinks(dup), created: false }
  }

  proj.id = String(Date.now())
  projects.push(proj)
  saveProjects(projects)
  return { project: withLinks(proj), created: true }
}

/**
 * 切换分支后同步 shopify.theme.toml：按目标分支对应的「最近一个本地项目」重建配置；
 * 该分支无项目则删除整个 toml，让仓库回到未初始化状态（切到有项目分支时自会按 store 重建）。
 *
 * 删 toml 不影响仓库↔项目关联：身份桥梁 dev.store 在 toml 缺失时由仓库远程地址反查模板得到
 * （storeFromRemote：remote → 模板 _github → 该模板 store），getRepoStatus 据此维持项目卡片不消失。
 * 故「无项目」直接删文件，逼用户在新分支重新初始化/保存，避免上分支配置残留被误用启动。
 *
 * 项目缺 templateName 时按 store 反查模板兜底（storeToTemplate），避免历史未记 templateName 的项目
 * 重建失败。toml 被 git 跟踪时整体跳过（git checkout 已切换它，再改会让工作区变脏、阻塞合并）。
 *
 * @param {string} repoPath 仓库目录
 * @param {string} branch 切到的目标分支
 * @returns {Promise<{ applied: boolean, project?: object, hadToml: boolean, reason?: 'no-project'|'no-store'|'template-missing', templateName?: string, skipped?: 'tracked' }>}
 */
export async function syncConfigForBranch(repoPath, branch) {
  const tomlPath = join(repoPath, 'shopify.theme.toml')
  const hadToml = existsSync(tomlPath)

  // toml 被 git 跟踪：checkout 已切换它，不能再改
  if (await isTomlTracked(repoPath)) {
    return { applied: false, hadToml, skipped: 'tracked' }
  }

  // 仓库身份(store)：优先 toml 的 dev.store；缺失则按远程地址反查模板 store（自愈关键）
  const cfg = loadThemeConfig(repoPath)
  const store = cfg?.environments?.dev?.store || storeFromRemote(await getRemoteUrl(repoPath))
  if (!store) {
    // 既无 toml store、远程也反查不到模板：没有仓库身份，不动（避免误伤）
    return { applied: false, hadToml, reason: 'no-store' }
  }

  // 该仓库(store)+该分支 最近保存的一条项目（reverse 后取首个 = 最后保存的）
  const project = [...loadProjects()]
    .reverse()
    .find((p) => p.store && p.store === store && p._branch === branch)

  if (project) {
    // 有项目：用项目配置覆盖重建（templateName 缺失时按 store 反查模板兜底；先构建，抛错则保留旧 toml）
    const templateName = project.templateName || storeToTemplate(store)
    let content
    try {
      content = buildThemeConfig({
        templateName,
        theme: project.theme,
        port: project.port,
        previewKey: project.previewKey,
        previewPath: project.previewPath,
        projectDesc: project.description,
      })
    } catch {
      return { applied: false, hadToml, reason: 'template-missing', templateName }
    }
    content = setEnvField(content, 'dev', '_branch', branch)
    writeFileSync(tomlPath, content, 'utf8')
    return { applied: true, project: withLinks(project), hadToml }
  }

  // 无项目：删除整个 toml（若存在），让仓库回到未初始化状态。toml 缺失不影响关联——
  // getRepoStatus 会按远程地址反查 store 维持项目卡片，切到有项目分支时自会按 store 重建。
  if (hadToml) {
    unlinkSync(tomlPath)
  }
  return { applied: false, hadToml, reason: 'no-project' }
}

/**
 * 把某仓库的 shopify.theme.toml 切换到「指定的本地项目」配置（桌面端项目卡片「切换」按钮）。
 *
 * 与 syncConfigForBranch 的区别：后者按分支取「该分支最近一条项目」，本函数按 projectId 精确指定——
 * 同一分支下同 store 可存多条项目（不同 theme/port/preview_key），切换即把 toml 的 dev 段改成该项目，
 * 使其成为「当前生效」（getRepoStatus 据此重算 matched）。不再复制启动命令、不再打开编辑器：
 * 用户在自己的编辑器里跑 shopify theme dev 时读到的就是该项目配置。
 *
 * 写入语义与 syncConfigForBranch 完全一致（用项目配置覆盖重建 toml、补 _branch），
 * 故无论是切分支还是点切换按钮，toml 行为统一。toml 被 git 跟踪时跳过（写它会污染工作区、阻塞合并）。
 *
 * @param {string} repoPath 仓库目录
 * @param {string|number} projectId 目标项目的 id
 * @returns {Promise<{ applied: boolean, project?: object, skipped?: 'tracked', reason?: 'no-project'|'template-missing', templateName?: string, port?: { port: number|null, wasOccupied: boolean, killed: number } }>}
 */
export async function switchConfigToProject(repoPath, projectId) {
  const tomlPath = join(repoPath, 'shopify.theme.toml')

  // toml 被 git 跟踪：改它会污染工作区、阻塞后续合并，跳过（与 syncConfigForBranch 一致）
  if (await isTomlTracked(repoPath)) {
    return { applied: false, skipped: 'tracked' }
  }

  // 按 id 精确定位项目（不像 syncConfigForBranch 按 store+branch 取最近一条）
  const project = loadProjects().find((p) => p.id === projectId)
  if (!project) {
    return { applied: false, reason: 'no-project' }
  }

  // 用项目配置覆盖重建 toml（templateName 缺失时按 store 反查模板兜底；构建失败则保留旧 toml）
  const templateName = project.templateName || storeToTemplate(project.store)
  let content
  try {
    content = buildThemeConfig({
      templateName,
      theme: project.theme,
      port: project.port,
      previewKey: project.previewKey,
      previewPath: project.previewPath,
      projectDesc: project.description,
    })
  } catch {
    return { applied: false, reason: 'template-missing', templateName }
  }
  content = setEnvField(content, 'dev', '_branch', project._branch || '')
  writeFileSync(tomlPath, content, 'utf8')

  // 释放目标端口：切换后用户会用该端口跑 dev，若被旧 dev server 等占用则先杀掉，避免端口冲突。
  // 仅在成功切换时执行（失败/跳过不动端口）；杀不掉不阻塞切换，结果随返回值带给前端提示。
  const port = Number(project.port)
  const occupying = port ? getPortPids(port) : []
  const portInfo = {
    port: port || null,
    wasOccupied: occupying.length > 0,
    killed: occupying.length ? killPort(port) : 0,
  }

  return { applied: true, project: withLinks(project), port: portInfo }
}
