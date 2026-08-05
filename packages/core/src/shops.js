/**
 * 首批命令的纯逻辑（headless）：供 CLI 与 Electron 桌面应用共用。
 * 这些函数只读写数据/解析配置，不打印、不提问；展示与交互由各自的壳负责。
 */
import { loadProjects, saveProjects } from './projects.js'
import { loadTemplateEnv, resolveEnvironment } from './config.js'
import { buildLinks } from './links.js'

/**
 * 组装所有项目的展示数据（含预览链接）—— `ls` 的纯逻辑。
 * projects.json 里没存 domain/store，从模板的 [environments.dev] 补齐。
 * @returns {Array<object>} 每项为原 project 字段并附加 `links`
 */
export function assembleProjects() {
  const projects = loadProjects()
  return projects.map((p) => {
    const tplEnv = loadTemplateEnv(p.templateName)
    const links = buildLinks({
      domain: p.domain ?? tplEnv.domain,
      store: p.store ?? tplEnv.store,
      theme: p.theme,
      preview_key: p.previewKey,
      port: p.port,
    })
    return { ...p, links }
  })
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
