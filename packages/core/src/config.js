import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { createRequire } from 'node:module'
import { userTemplatesDir, ensureUserTemplatesDir } from './paths.js'

const requireFromHere = createRequire(import.meta.url)

const CONFIG_FILE = 'shopify.theme.toml'

// 工具自带的模板目录（src/config/）。优先用注入路径；其次相对本文件（CLI 的 ESM 正常）；
// 仍不可用时（桌面端把 core 打进 CJS bundle 后 import.meta.url 指向 out/），回退到按 core 自身 package.json 定位。
let templatesDirOverride = null
/** 覆盖模板目录定位（供 GUI 主进程启动时注入；CLI 无需调用）。 */
export function setTemplatesDir(dir) {
  templatesDirOverride = dir ? String(dir) : null
}

function resolveTemplatesDir() {
  if (templatesDirOverride) {
    try {
      readdirSync(templatesDirOverride)
      return templatesDirOverride
    } catch {}
  }
  const here = fileURLToPath(new URL('./config/', import.meta.url))
  try {
    readdirSync(here)
    return here
  } catch {}
  try {
    const pkg = requireFromHere.resolve('@shopify-cli-tool/core/package.json')
    return join(dirname(pkg), 'src', 'config')
  } catch {}
  return here
}

/**
 * 从 startDir 逐级向上查找 shopify.theme.toml，直到文件系统根。
 * 读取位置是用户的项目目录（CLI 默认 cwd；GUI 显式传入 startDir），不是本工具的 __dirname。
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
 * headless：解析失败静默返回 null（不打印），由调用方决定如何提示。
 * @param {string} [startDir] 项目目录（默认 cwd）
 * @returns {{ path: string, environments: Record<string, object> } | null}
 *   文件不存在或解析失败均返回 null。
 */
export function loadThemeConfig(startDir) {
  const path = findThemeConfig(startDir)
  if (!path) return null

  try {
    const parsed = parse(readFileSync(path, 'utf8'))
    return { path, environments: parsed.environments ?? {} }
  } catch {
    return null
  }
}

/**
 * 解析命令对应的环境参数对象（shopify.theme.toml 里 [environments.<name>] 的内容）。
 * 纯函数：不打印、无副作用，只把参数对象 return 出来。
 * @param {string[]} args 含 -e/--environment 的参数
 * @param {string} [startDir] 项目目录（默认 cwd）
 * @returns {Record<string, string | number> | null}
 *   命中时返回该环境的参数对象（如 { domain, theme, store, port, preview_key }）；
 *   未带 -e、找不到文件、或环境名不存在时返回 null。
 */
export function resolveEnvironment(args, startDir) {
  const name = extractEnvironmentArg(args)
  if (!name) return null
  const cfg = loadThemeConfig(startDir)
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
      // 空值强制加引号：裸值字段（如 port = 9292）清空成 `port = `（无值）是非法 TOML，
      // 会令整份 toml 解析失败、devEnv（含 store）全丢。故 value==='' 时一律按引号写入 ""。
      const isQuoted = m[2] !== undefined || String(value) === ''
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

/** 模板目录的绝对路径（供需要直接读模板文件的调用方使用，如 init）。 */
export function getTemplatesDir() {
  return resolveTemplatesDir()
}

/**
 * 按模板名定位其文件**绝对路径**：先查用户自建模板目录，再查内置模板目录。
 * 这样按名读模板不再假设单一目录（用户模板写到包外的 userDataDir/templates）。
 * @param {string} name 模板名（文件名第一个点前那段）
 * @returns {string | undefined} 命中文件的绝对路径；找不到返回 undefined
 */
function findTemplateFile(name) {
  if (!name) return undefined
  const file = `${name}.shopify.theme.toml`
  // 用户目录优先（允许用户覆盖同名内置模板的读取）；其次内置目录
  for (const dir of [userTemplatesDir(), resolveTemplatesDir()]) {
    const full = join(dir, file)
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * 列出全部可用模板：内置模板目录 + 用户自建模板目录，合并后按 name 去重（内置优先，避免用户同名遮蔽）。
 * @returns {{ file: string, name: string, user: boolean }[]} name = 文件名第一个点前的文案（如 'us'）；
 *   user=true 表示来自用户自建目录（可编辑/删除），false 表示内置（只读）。
 */
export function listTemplates() {
  const seen = new Set()
  const out = []
  const userDir = userTemplatesDir()
  for (const dir of [resolveTemplatesDir(), userDir]) {
    const isUserDir = dir === userDir // 内置目录先扫；用户目录里的即「自建」
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      continue // 用户目录可能尚未创建
    }
    for (const f of files) {
      if (!f.endsWith('.toml')) continue
      const name = f.split('.')[0]
      if (seen.has(name)) continue // 同名去重（内置目录先扫，故内置优先）
      seen.add(name)
      out.push({ file: f, name, user: isUserDir })
    }
  }
  return out.sort((a, b) => {
    // empty 是占位模板，选择列表里放到最后；其余保持原顺序（sort 稳定）
    if (a.name === 'empty' && b.name !== 'empty') return 1
    if (b.name === 'empty' && a.name !== 'empty') return -1
    return 0
  })
}

/**
 * 读取某模板的 [environments.dev] 配置（用于补 domain / store，projects.json 里没存这两个）。
 * 结果**保留**以 `_` 开头的只读字段（如 `_github`），供工具内部/后续功能读取；
 * 写入用户项目时由 buildThemeConfig / mergeDevEnv 统一剔除，不在这里处理。
 * @param {string} templateName
 * @returns {Record<string, string|number>} 找不到模板返回 {}
 */
export function loadTemplateEnv(templateName) {
  if (!templateName) return {}
  const file = findTemplateFile(templateName)
  if (!file) return {}
  try {
    return parse(readFileSync(file, 'utf8')).environments?.dev ?? {}
  } catch {
    return {}
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
    const file = findTemplateFile(t.name)
    if (!file) continue
    try {
      const env = parse(readFileSync(file, 'utf8')).environments?.dev
      if (env?.store === store) return t.name
    } catch {}
  }
  return undefined
}

/**
 * 把模板里某个 key 的值替换为新值（仅首个匹配，保留 key 原有空白格式与其余行/注释）。
 * 自动适配原有写法：带引号（"..."）→ 加引号 + 转义；裸值（如数字 9292）→ 原样写入不加引号。
 */
function fillValue(content, key, value) {
  const re = new RegExp('^(\\s*' + key + '\\s*=\\s*)(?:"([^"]*)"|([^\\s"\\n]+))', 'm')
  const m = re.exec(content)
  if (!m) return content
  const prefix = m[1]
  const isQuoted = m[2] !== undefined
  const replacement = isQuoted
    ? '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : String(value)
  return content.slice(0, m.index) + prefix + replacement + content.slice(m.index + m[0].length)
}

/**
 * 以 `_` 开头的键是模板自带的只读元数据（如 `_github` 仓库地址），
 * 仅供工具内部/后续功能读取，绝不应回填或写入到用户项目里。
 * 下面两个工具分别处理「对象」与「原始文本」两条写入路径。
 */
const READONLY_KEY_LINE_RE = /^\s*_[A-Za-z0-9_]+\s*=/

/** 从环境对象中剔除以 `_` 开头的只读键（mergeDevEnv 走 stringify 写入时用）。 */
function omitReadonlyKeys(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('_')))
}

/** 从原始 TOML 文本中剔除以 `_` 开头的只读键行（buildThemeConfig 保留模板格式写入时用）。 */
function stripReadonlyLines(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return content
    .split(/\r?\n/)
    .filter((line) => !READONLY_KEY_LINE_RE.test(line))
    .join(eol)
}

/**
 * 用模板生成一份新的 shopify.theme.toml 内容（`shop init` 的「文件不存在」分支纯逻辑）。
 * 注意：模板里以 `_` 开头的只读字段（如 `_github`）不会写入生成结果。
 * @param {{ templateName: string, theme?: string, port?: string, previewKey?: string, projectDesc?: string }} opts
 * @returns {string} 生成的 TOML 文本
 */
export function buildThemeConfig({ templateName, theme, port, previewKey, projectDesc }) {
  const file = findTemplateFile(templateName)
  if (!file) throw new Error(`未找到模板「${templateName}」`)
  let content = readFileSync(file, 'utf8')
  content = fillValue(content, 'theme', String(theme ?? '').trim())
  content = fillValue(content, 'port', String(port ?? '').trim())
  content = fillValue(content, 'preview_key', String(previewKey ?? '').trim())
  content = fillValue(content, 'project_desc', String(projectDesc ?? '').trim())
  return stripReadonlyLines(content)
}

/** TOML 字符串值序列化：加双引号并转义 `\` 与 `"`。 */
function tomlQuote(value) {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 新建一个用户模板：把字段写成 `<name>.shopify.theme.toml` 放到用户模板目录（userDataDir/templates）。
 * 内置模板随包只读，故用户模板一律写到包外的可写目录，升级/重装不丢。
 * 文件格式与内置模板一致（单一 [environments.dev] 区段、固定字段顺序），
 * 便于后续 setEnvField/fillValue 按行改写。
 *
 * 字段策略：
 *   - _github / domain / store / port 必填（缺一抛错）；port 按裸数字写入，非数字按裸字符串。
 *   - 其余字符串字段做空值兜底（缺省 ''）。
 *
 * @param {{ name: string, fields?: Record<string, any> }} opts
 *   fields 可含 _github / _branch / project_desc / domain / theme / store / port / preview_key
 * @returns {Promise<string>} 写出的文件绝对路径
 * @throws {Error} name 为空/含非法字符、重名、或缺少必填字段（_github/domain/store/port）时抛错
 */
export async function saveTemplate({ name, fields = {} }) {
  const cleanName = String(name ?? '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(cleanName)) {
    throw new Error('模板名称只能包含字母、数字、下划线和中划线')
  }
  // 防撞名：内置与用户模板均不可重名（listTemplates 已按 name 去重，这里直接复用）
  if (listTemplates().some((t) => t.name === cleanName)) {
    throw new Error(`已存在同名模板「${cleanName}」`)
  }
  const dir = ensureUserTemplatesDir()
  const file = join(dir, `${cleanName}.shopify.theme.toml`)
  writeFileSync(file, buildTemplateBody(fields), 'utf8')
  return file
}

/**
 * 模板字段校验 + 序列化为 TOML 文本（单一 [environments.dev] 区段、固定字段顺序）。
 * saveTemplate（新建）与 updateTemplate（改写）共用，保证写入格式一致，便于 setEnvField/fillValue 按行改写。
 * 字段策略：_github/domain/store/port 必填（缺一抛错）；port 按裸数字写入，非数字按裸字符串；其余字符串做空值兜底。
 * @param {Record<string, any>} fields 可含 _github / _branch / project_desc / domain / theme / store / port / preview_key
 * @returns {string} TOML 文本（以换行结尾）
 * @throws {Error} 缺少必填字段（_github/domain/store/port）时抛错
 */
function buildTemplateBody(fields = {}) {
  // 必填字段（与前端 CreateTemplateModal 的 required 一致，防御绕过前端的调用）
  for (const k of ['_github', 'domain', 'store', 'port']) {
    if (!String(fields?.[k] ?? '').trim()) throw new Error(`缺少必填字段：${k}`)
  }
  const get = (k, def = '') => {
    const v = fields?.[k]
    return v == null ? def : String(v).trim()
  }
  const portRaw = get('port', '9292') || '9292'
  const port = /^\d+$/.test(portRaw) ? portRaw : tomlQuote(portRaw) // 数字裸写，非数字加引号
  const lines = ['[environments.dev]']
  const github = get('_github', '')
  if (github) lines.push(`_github = ${tomlQuote(github)}`) // 空 _github 不写（同 empty 模板）
  lines.push(`_branch = ${tomlQuote(get('_branch', ''))}`)
  lines.push(`project_desc = ${tomlQuote(get('project_desc', ''))}`)
  lines.push(`domain = ${tomlQuote(get('domain', ''))}`)
  lines.push(`theme = ${tomlQuote(get('theme', ''))}`)
  lines.push(`store = ${tomlQuote(get('store', ''))}`)
  lines.push(`port = ${port}`)
  lines.push(`preview_key = ${tomlQuote(get('preview_key', ''))}`)
  return lines.join('\n') + '\n'
}

/**
 * 定位某 name 对应的「自建模板」绝对路径；不存在（内置或未建）返回 undefined。
 * 内置模板随包只读，编辑/删除一律只允许作用于 userDataDir/templates 下的文件。
 */
function userTemplateFile(name) {
  if (!name) return undefined
  const file = join(userTemplatesDir(), `${name}.shopify.theme.toml`)
  return existsSync(file) ? file : undefined
}

/**
 * 改写一个用户自建模板的字段（name 固定不可改；想改名请删后重建）。
 * 复用 buildTemplateBody 的校验与序列化，保证与新建格式一致。
 * @param {{ name: string, fields?: Record<string, any> }} opts
 * @returns {Promise<string>} 写出的文件绝对路径
 * @throws {Error} name 不存在、或属于内置模板（不可改）时抛错
 */
export async function updateTemplate({ name, fields = {} }) {
  const cleanName = String(name ?? '').trim()
  const file = userTemplateFile(cleanName)
  if (!file) {
    // 区分「内置」与「根本不存在」，给出更清晰提示
    const known = listTemplates().some((t) => t.name === cleanName)
    throw new Error(known ? `内置模板「${cleanName}」不可修改` : `模板「${cleanName}」不存在`)
  }
  writeFileSync(file, buildTemplateBody(fields), 'utf8')
  return file
}

/**
 * 删除一个用户自建模板。内置模板不可删。
 * @param {string} name 模板名
 * @returns {string} 已删除文件的绝对路径
 * @throws {Error} name 不存在、或属于内置模板时抛错
 */
export function deleteTemplate(name) {
  const cleanName = String(name ?? '').trim()
  const file = userTemplateFile(cleanName)
  if (!file) {
    const known = listTemplates().some((t) => t.name === cleanName)
    throw new Error(known ? `内置模板「${cleanName}」不可删除` : `模板「${cleanName}」不存在`)
  }
  unlinkSync(file)
  return file
}

/**
 * 把模板的 [environments.dev] 合并进已有的 shopify.theme.toml（`shop init` 的「文件已存在」分支纯逻辑）。
 * 注意：模板里以 `_` 开头的只读字段（如 `_github`）不会写入合并结果。
 * @param {string} existingToml 现有 toml 文本
 * @param {string} templateName 模板名
 * @returns {string} 合并后的 TOML 文本
 */
export function mergeDevEnv(existingToml, templateName) {
  const tplEnv = loadTemplateEnv(templateName)
  if (!tplEnv || Object.keys(tplEnv).length === 0) {
    throw new Error(`模板「${templateName}」未包含 [environments.dev]`)
  }
  let existing = {}
  try {
    existing = parse(existingToml)
  } catch {
    // 解析失败则按空处理：只写入 dev 环境（与原 CLI 行为一致）
  }
  const merged = {
    ...existing,
    environments: { ...(existing.environments || {}), dev: omitReadonlyKeys(tplEnv) },
  }
  return stringify(merged)
}
