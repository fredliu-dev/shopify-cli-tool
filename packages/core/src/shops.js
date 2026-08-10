/**
 * 首批命令的纯逻辑（headless）：供 CLI 与 Electron 桌面应用共用。
 * 这些函数只读写数据/解析配置，不打印、不提问；展示与交互由各自的壳负责。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProjects, saveProjects } from './projects.js'
import { loadTemplateEnv, resolveEnvironment, loadThemeConfig, setEnvField, storeToTemplate } from './config.js'
import { buildLinks } from './links.js'

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
    port: p.port,
  })
  return { ...p, links }
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
  if (p.domain !== env.domain) return false
  if (String(p.theme) !== String(env.theme)) return false
  if (String(p.previewKey ?? '') !== String(env.preview_key ?? '')) return false
  if (p.description !== env.project_desc) return false
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
 * @param {string} repoPath 仓库目录
 * @param {string} [branch] 当前 git 分支
 * @returns {{ hasToml: boolean, devEnv: object | null, matched: object | null }}
 */
export function getRepoStatus(repoPath, branch) {
  const hasToml = existsSync(join(repoPath, 'shopify.theme.toml'))
  if (!hasToml) return { hasToml: false, devEnv: null, matched: null }
  const cfg = loadThemeConfig(repoPath)
  const devEnv = cfg?.environments?.dev ?? null
  return { hasToml: true, devEnv, matched: devEnv ? findSavedProject(devEnv, branch) : null }
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
    port: String(resolved.port),
    description: resolved.project_desc,
    _branch: branch || null,
    _tapd: tapd || null,
  }

  const projects = loadProjects()
  const dup = projects.find((p) => isSameProject(p, resolved, branch))
  if (dup) {
    // 命中已有项目：_tapd 是衍生数据（不在六要素里），单独更新即可，不算"新建"
    if (tapd && dup._tapd !== tapd) {
      dup._tapd = tapd
      saveProjects(projects)
    }
    return { project: withLinks(dup), created: false }
  }

  proj.id = String(Date.now())
  projects.push(proj)
  saveProjects(projects)
  return { project: withLinks(proj), created: true }
}
