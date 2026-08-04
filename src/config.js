import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { parse } from 'smol-toml'
import { log } from './ui/logger.js'

const CONFIG_FILE = 'shopify.theme.toml'

// 工具自带的模板目录（src/config/，相对本文件定位）
const TEMPLATES_DIR = new URL('./config/', import.meta.url)

/**
 * 从 startDir 逐级向上查找 shopify.theme.toml，直到文件系统根。
 * 读取位置是 cwd（用户的主题项目目录），不是本工具的 __dirname。
 * @param {string} [startDir=process.cwd()]
 * @returns {string | undefined} 配置文件绝对路径，找不到返回 undefined
 */
export function findThemeConfig(startDir = process.cwd()) {
  let dir = startDir
  // 逐级向上，直到 dirname 不再变化（即到达文件系统根）
  while (true) {
    const candidate = join(dir, CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 读取并解析 shopify.theme.toml。
 * @returns {{ path: string, environments: Record<string, object> } | null}
 *   文件不存在或解析失败返回 null（解析失败会 warn，但不阻断透传）。
 */
export function loadThemeConfig() {
  const path = findThemeConfig()
  if (!path) return null

  let parsed
  try {
    parsed = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    log.warn(`解析 ${basename(path)} 失败：${err.message}`)
    return null
  }

  return { path, environments: parsed.environments ?? {} }
}

/**
 * 解析命令对应的环境参数对象（shopify.theme.toml 里 [environments.<name>] 的内容）。
 * 纯函数：不打印、无副作用，只把参数对象 return 出来。
 * @param {string[]} args 含 -e/--environment 的参数
 * @returns {Record<string, string | number> | null}
 *   命中时返回该环境的参数对象（如 { domain, theme, store, port, preview_key }）；
 *   未带 -e、找不到文件、或环境名不存在时返回 null。
 */
export function resolveEnvironment(args) {
  const name = extractEnvironmentArg(args)
  if (!name) return null
  const cfg = loadThemeConfig()
  if (!cfg) return null
  return cfg.environments[name] ?? null
}

/**
 * 从 argv 中提取环境名，识别四种写法：
 *   -e dev | -e=dev | --environment dev | --environment=dev
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function extractEnvironmentArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '-e' || tok === '--environment') {
      return argv[i + 1] // 下一个 token 作为值；缺失则 undefined
    }
    if (tok.startsWith('-e=')) return tok.slice(3)
    if (tok.startsWith('--environment=')) return tok.slice('--environment='.length)
  }
  return undefined
}

/**
 * 把某个 [environments.<envName>] 区段内的字段值改写为新值。
 * 只替换该 section 内首个匹配的 key（遇到下一个 [ 开头的表头即视为 section 结束），
 * 保留原有引号/裸值写法、缩进、注释与其余行。
 * key 不存在时，在 section 末尾新增一行（字符串加引号，纯数字裸值）。
 * 找不到 section 则原样返回。
 * @param {string} content 原始 TOML 文本
 * @param {string} envName 环境名，如 'dev'
 * @param {string} key 字段名，如 'theme' / 'project_desc'
 * @param {string | number} value 新值
 * @returns {string} 改写后的文本（可能与入参相同）
 */
export function setEnvField(content, envName, key, value) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)

  // 定位 [environments.<envName>] 表头
  const headerRe = new RegExp(`^\\s*\\[environments\\.${escapeRegExp(envName)}\\]\\s*$`)
  const start = lines.findIndex((l) => headerRe.test(l))
  if (start === -1) return content

  // 在该 section 内（直到下一个表头）查找 key 行；顺带记录缩进与最后一个 key 行位置
  const keyRe = new RegExp('^(\\s*' + escapeRegExp(key) + '\\s*=\\s*)(?:"([^"]*)"|([^\\s"\\n]+))')
  let indent = ''
  let lastKeyIdx = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break // 进入下一个 section
    const km = /^(\s*)[A-Za-z0-9_]+\s*=/.exec(lines[i])
    if (km) {
      if (indent === '') indent = km[1]
      lastKeyIdx = i
    }
    const m = keyRe.exec(lines[i])
    if (m) {
      const isQuoted = m[2] !== undefined
      const replacement = isQuoted
        ? '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
        : String(value)
      lines[i] = m[1] + replacement
      return lines.join(eol)
    }
  }
  // key 不存在 → 紧跟该 section 最后一个 key 行新增一行（没有 key 行则贴在表头后）
  const isNumber = typeof value === 'number' || /^\d+$/.test(String(value))
  const serialized = isNumber
    ? String(value)
    : '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  const insertAt = lastKeyIdx >= 0 ? lastKeyIdx + 1 : start + 1
  lines.splice(insertAt, 0, `${indent}${key} = ${serialized}`)
  return lines.join(eol)
}

/** 转义正则元字符，用于把 envName/key 安全嵌入 RegExp。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 列出工具自带模板（src/config/*.toml）。
 * @returns {{ file: string, name: string }[]} name = 文件名第一个点前的文案（如 'us'）
 */
export function listTemplates() {
  try {
    return readdirSync(fileURLToPath(TEMPLATES_DIR))
      .filter((f) => f.endsWith('.toml'))
      .map((f) => ({ file: f, name: f.split('.')[0] }))
  } catch {
    return []
  }
}

/**
 * 根据 store 反查模板：读每个模板的 [environments.dev].store，返回匹配的模板名。
 * 用于「模板由 store 决定」的判断（add/edit/ls）。
 * @param {string} store
 * @returns {string | undefined} 模板名；未匹配返回 undefined
 */
export function storeToTemplate(store) {
  if (!store) return undefined
  for (const t of listTemplates()) {
    try {
      const env = parse(readFileSync(new URL(t.file, TEMPLATES_DIR), 'utf8')).environments?.dev
      if (env?.store === store) return t.name
    } catch {}
  }
  return undefined
}
