/**
 * JSON 可视化（主题 templates/*.json + config/settings_data.json）：
 *   - 列出主题内可可视化的 JSON 文件
 *   - 读写 + 解析（兼容带 BOM / 宽松 JSON）
 *   - 为 JSON 里的每个 key 解析「代表什么」（section schema 的 name/label，或 settings_schema 的 label）
 *   - 版本快照：每次保存写入一份带时间戳的历史版本，支持回切
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { userDataDir, ensureDataDir } from './paths.js'

const SCHEMA_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/

/**
 * 去除 JSON 里的 JS 风格注释（// 与 / * * /），保留字符串内的内容。
 * 主题 templates/*.json 顶部有 Shopify 自动生成的注释块，标准 JSON.parse 无法识别。
 */
function stripJsonComments(text) {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 提取文件头部的前导内容（BOM + 空白 + 注释块），保存时原样保留。 */
function extractHeader(text) {
  let i = 0
  if (text.charCodeAt(0) === 0xfeff) i = 1
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    break
  }
  return text.slice(0, i)
}

/** 剥 BOM、去注释后按标准 JSON 解析，失败再走宽松化（去尾随逗号）重试；都失败返回 null。 */
function parseLooseJson(code) {
  const text = stripJsonComments(String(code ?? '').replace(/^﻿/, '')).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))
    } catch {
      return null
    }
  }
}

/** 递归列出目录下所有 .json 文件（相对路径用 posix 分隔符）。 */
function walkJson(dir, base = dir) {
  const out = []
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push(...walkJson(full, base))
    } else if (/\.json$/i.test(name)) {
      out.push(full.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
    }
  }
  return out
}

/**
 * 列出主题里可可视化的 JSON 文件：templates/** 下所有 .json，
 * 外加 config/settings_data.json（全局配置数据）。
 * @param {string} repoDir 主题根目录
 * @returns {{ path: string, rel: string }[]} path 绝对路径，rel 相对主题根的路径
 */
export function listThemeJsonFiles(repoDir) {
  const out = []
  const templates = join(repoDir, 'templates')
  if (existsSync(templates)) {
    for (const rel of walkJson(templates, repoDir)) {
      out.push({ rel, path: join(repoDir, rel) })
    }
  }
  const settingsData = join(repoDir, 'config', 'settings_data.json')
  if (existsSync(settingsData)) {
    out.push({ rel: 'config/settings_data.json', path: settingsData })
  }
  return out
}

/** 读取并解析 JSON 文件。 */
export function readJsonFile(path) {
  const raw = readFileSync(path, 'utf8')
  const data = parseLooseJson(raw)
  return { raw, data }
}

/**
 * 以 2 空格缩进写入 JSON。
 * 保留原文件头部注释块（Shopify auto-generated 提示），避免保存后丢失 BOM/注释。
 */
export function writeJsonFile(path, value) {
  let header = ''
  try {
    header = extractHeader(readFileSync(path, 'utf8'))
  } catch {}
  writeFileSync(path, header + JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 解析单个 section .liquid 的 schema，返回 { name, settingsById, blocksByType }。
 * settingsById: setting id -> { label, type, info }
 * blocksByType: block type -> { name, settingsById }
 * 解析失败返回 null。
 */
function parseSectionSchema(code) {
  const m = code.match(SCHEMA_RE)
  if (!m) return null
  const schema = parseLooseJson(m[1])
  if (!schema || typeof schema !== 'object') return null
  const settingsById = {}
  for (const s of schema.settings || []) {
    if (s && s.id) settingsById[s.id] = { label: s.label, type: s.type, info: s.info }
  }
  const blocksByType = {}
  for (const b of schema.blocks || []) {
    if (!b || !b.type) continue
    const bset = {}
    for (const s of b.settings || []) {
      if (s && s.id) bset[s.id] = { label: s.label, type: s.type, info: s.info }
    }
    blocksByType[b.type] = { name: b.name, settingsById: bset }
  }
  return { name: schema.name, settingsById, blocksByType }
}

/** 读取 config/settings_schema.json，返回 { presets, settingsById }。 */
function loadSettingsSchema(repoDir) {
  const file = join(repoDir, 'config', 'settings_schema.json')
  if (!existsSync(file)) return { presets: {}, settingsById: {} }
  const schema = parseLooseJson(readFileSync(file, 'utf8'))
  if (!Array.isArray(schema)) return { presets: {}, settingsById: {} }
  const presets = {}
  const settingsById = {}
  for (const group of schema) {
    if (!group || typeof group !== 'object') continue
    const gname = group.name
    for (const s of group.settings || []) {
      if (s && s.id) settingsById[s.id] = { label: s.label, type: s.type, group: gname }
    }
    if (gname) presets[gname] = group
  }
  return { presets, settingsById }
}

/** 深合并两个普通对象（后者覆盖前者），用于合并 storefront / schema 两套 locales。 */
function deepMerge(base, extra) {
  if (!base || typeof base !== 'object') return extra
  if (!extra || typeof extra !== 'object') return base
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
        ? deepMerge(out[k], v)
        : v
  }
  return out
}

/**
 * 读取主题 locales 的默认文案，用于把 t:xxx 翻译 key 还原成可读文案。
 * section/block 的 schema 文案在 en.default.schema.json，其它在 en.default.json，两者需合并。
 */
function loadLocaleMessages(repoDir) {
  let dict = null
  for (const rel of [
    'locales/en.default.json',
    'locales/en.default.schema.json',
    'locales/en.json',
  ]) {
    const file = join(repoDir, rel)
    if (!existsSync(file)) continue
    const obj = parseLooseJson(readFileSync(file, 'utf8'))
    if (obj && typeof obj === 'object') dict = dict ? deepMerge(dict, obj) : obj
  }
  return dict
}

/** 按点路径取嵌套字符串。 */
function getByPath(obj, path) {
  let cur = obj
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return typeof cur === 'string' ? cur : undefined
}

/**
 * 读取某个 section/block 类型的 schema：
 * 先找 sections/<type>.liquid，再找 blocks/<type>.liquid（主题块文件）。
 * App 类型（@app / shopify:...）本地无定义，直接返回 null。
 */
function loadTypeSchema(repoDir, type) {
  if (!type || type.startsWith('@') || type.startsWith('shopify:')) return null
  for (const dirName of ['sections', 'blocks']) {
    const file = join(repoDir, dirName, `${type}.liquid`)
    if (!existsSync(file)) continue
    const sch = parseSectionSchema(readFileSync(file, 'utf8'))
    if (sch) return sch
  }
  return null
}

/** 读取 schema 中 blocks 定义（内联 settings 优先，其次 blocks/<type>.liquid）。 */
function resolveBlockSchema(repoDir, sectionSchema, blockType) {
  const inline = sectionSchema?.blocksByType?.[blockType]
  if (inline && (inline.settingsById ? Object.keys(inline.settingsById).length : 0) > 0) {
    return inline
  }
  const standalone = loadTypeSchema(repoDir, blockType)
  if (standalone) {
    return { name: standalone.name, settingsById: standalone.settingsById }
  }
  return inline || null
}

/**
 * 列出某个 section 类型在 schema 里定义的全部 block 类型（供「添加区块」选择）。
 * @returns {{ types: { type: string, name: string, settingsTemplate: Record<string, unknown> }[] }}
 * settingsTemplate：按 schema 每个 setting 的 id/type 生成空值模板（text→''、checkbox→false、range→default/最小值、
 * select→第一个选项、number→0），新增 block 时配置项结构与该类型定义完全一致。
 */
export function listSectionBlockTypes(repoDir, sectionType) {
  const sch = loadTypeSchema(repoDir, sectionType)
  const blocks = []
  const inline = sch?.blocksByType || {}
  const entries = Object.entries(inline)
  if (entries.length > 0) {
    for (const [type, def] of entries) {
      blocks.push({
        type,
        name: def?.name || type,
        settingsTemplate: settingsTemplateOf(def),
        // settings 明细（id/type/label），供客户端在保存前就显示字段含义
        settings: Object.entries(def?.settingsById || {}).map(([id, s]) => ({
          id,
          type: s?.type,
          label: s?.label,
        })),
      })
    }
  } else {
    // 内联无 blocks 定义：扫 blocks/ 目录兜底（与 loadTypeSchema 的独立 block 文件约定一致）
    const bdir = join(repoDir, 'blocks')
    try {
      for (const f of readdirSync(bdir)) {
        if (!f.endsWith('.liquid')) continue
        const type = f.slice(0, -7)
        const bsch = loadTypeSchema(repoDir, type)
        if (bsch) {
          blocks.push({
            type,
            name: bsch.name || type,
            settingsTemplate: settingsTemplateOf(bsch),
            settings: Object.entries(bsch.settingsById || {}).map(([id, s]) => ({
              id,
              type: s?.type,
              label: s?.label,
            })),
          })
        }
      }
    } catch { /* blocks 目录不存在 */ }
  }
  // 翻译 t: 前缀的 block name / setting label
  const locale = loadLocaleMessages(repoDir)
  if (locale) {
    for (const b of blocks) {
      if (typeof b.name === 'string' && b.name.startsWith('t:')) {
        b.name = getByPath(locale, b.name.slice(2)) || b.name.slice(2)
      }
      for (const s of b.settings || []) {
        if (typeof s.label === 'string' && s.label.startsWith('t:')) {
          s.label = getByPath(locale, s.label.slice(2)) || s.label.slice(2)
        }
      }
    }
  }
  return { types: blocks }
}

/** 按 block schema 的 settings 定义生成空值模板（settingsById 的键就是 setting id）。 */
function settingsTemplateOf(def) {
  const tpl = {}
  for (const [id, s] of Object.entries(def?.settingsById || {})) {
    if (!id) continue
    switch (s?.type) {
      case 'checkbox': tpl[id] = false; break
      case 'range': tpl[id] = typeof s.default === 'number' ? s.default : (typeof s.min === 'number' ? s.min : 0); break
      case 'number': tpl[id] = typeof s.default === 'number' ? s.default : 0; break
      case 'select': tpl[id] = Array.isArray(s.options) && s.options.length ? (s.options[0].value ?? s.options[0]) : ''; break
      default: tpl[id] = ''
    }
  }
  return tpl
}

/**
 * 为给定的主题 JSON 构建「key 路径 -> 含义」映射。
 *
 * 支持两类文件：
 *   1. templates/*.json：sections.<id>.type -> sections/<type>.liquid schema 的 name；
 *      sections.<id>.settings.<key> -> schema.settings 里对应 id 的 label；
 *      sections.<id>.blocks.<bid>.type -> schema.blocks 里对应 type 的 name；
 *      sections.<id>.blocks.<bid>.settings.<key> -> block.settings 的 label。
 *   2. config/settings_data.json：current.<key> / presets.<name>.<key> -> settings_schema 对应 id 的 label；
 *      current.sections.* / presets.*.sections.* 同样按 section 类型解析。
 *
 * @param {string} repoDir 主题根目录
 * @param {string} filePath 正在可视化的 JSON 文件绝对路径
 * @param {object} json 已解析的 JSON
 * @returns { Record<string, { label?: string, type?: string, section?: string }> }
 *   key 为点路径（如 sections.main.settings.show_sku），value 为含义信息
 */
export function resolveJsonMeta(repoDir, filePath, json) {
  const meta = {}
  if (!json || typeof json !== 'object') return meta

  const rel = relative(repoDir, filePath).replace(/\\/g, '/')
  const isSettingsData = rel === 'config/settings_data.json'

  // 收集所有用到的 section 类型，批量读取 schema
  const sectionTypes = new Set()
  const collectTypes = (obj) => {
    if (!obj || typeof obj !== 'object') return
    const sections = obj.sections
    if (sections && typeof sections === 'object') {
      for (const s of Object.values(sections)) {
        if (s && typeof s.type === 'string') sectionTypes.add(s.type)
      }
    }
  }
  if (isSettingsData) {
    collectTypes(json.current)
    for (const p of Object.values(json.presets || {})) collectTypes(p)
  } else {
    collectTypes(json)
  }

  const schemas = {}
  for (const type of sectionTypes) {
    schemas[type] = loadTypeSchema(repoDir, type)
  }

  const { settingsById: globalSettings } = loadSettingsSchema(repoDir)

  // 给某个 sections 对象填 meta
  const fillSections = (sections, prefix) => {
    if (!sections || typeof sections !== 'object') return
    for (const [sid, s] of Object.entries(sections)) {
      if (!s || typeof s !== 'object') continue
      const secPrefix = `${prefix}.${sid}`
      if (typeof s.type === 'string') {
        meta[`${secPrefix}.type`] = { section: s.type }
      }
      const sch = typeof s.type === 'string' ? schemas[s.type] || null : null
      if (sch) {
        meta[secPrefix] = { label: sch.name, section: s.type }
        // settings
        if (s.settings && typeof s.settings === 'object') {
          for (const k of Object.keys(s.settings)) {
            const set = sch.settingsById[k]
            if (set) meta[`${secPrefix}.settings.${k}`] = { label: set.label, type: set.type, section: s.type }
          }
        }
      }
      // blocks：新版为对象（block id -> block），旧版为数组，两种都要支持。
      // 即使 section 自身没有 schema，block 仍可能由 blocks/<type>.liquid 提供说明。
      const blockEntries = Array.isArray(s.blocks)
        ? s.blocks.map((b, i) => [i, b])
        : s.blocks && typeof s.blocks === 'object'
          ? Object.entries(s.blocks)
          : []
      for (const [bid, b] of blockEntries) {
        if (!b || typeof b !== 'object') continue
        const bPrefix = `${secPrefix}.blocks.${bid}`
        if (typeof b.type !== 'string') continue
        const bs = resolveBlockSchema(repoDir, sch, b.type)
        if (!bs) continue
        meta[bPrefix] = { label: bs.name, section: s.type, blockType: b.type }
        if (b.settings && typeof b.settings === 'object') {
          for (const k of Object.keys(b.settings)) {
            const set = bs.settingsById[k]
            if (set) meta[`${bPrefix}.settings.${k}`] = { label: set.label, type: set.type, section: s.type, blockType: b.type }
          }
        }
      }
    }
  }

  if (isSettingsData) {
    // 顶层 current / presets.<name>
    if (json.current && typeof json.current === 'object') {
      fillSections(json.current.sections, 'current.sections')
      for (const k of Object.keys(json.current)) {
        if (k === 'sections') continue
        const gs = globalSettings[k]
        if (gs) meta[`current.${k}`] = { label: gs.label, type: gs.type, group: gs.group }
      }
    }
    for (const [pname, p] of Object.entries(json.presets || {})) {
      if (!p || typeof p !== 'object') continue
      fillSections(p.sections, `presets.${pname}.sections`)
      for (const k of Object.keys(p)) {
        if (k === 'sections') continue
        const gs = globalSettings[k]
        if (gs) meta[`presets.${pname}.${k}`] = { label: gs.label, type: gs.type, group: gs.group }
      }
    }
  } else {
    if (typeof json.name === 'string') meta['name'] = { label: '模板名称', type: 'string' }
    if (Array.isArray(json.order)) meta['order'] = { label: '区块顺序', type: 'array' }
    fillSections(json.sections, 'sections')
  }

  // 把 t:sections.xxx.name 这类翻译 key 还原为 locales 里的实际文案
  const locale = loadLocaleMessages(repoDir)
  if (locale) {
    for (const v of Object.values(meta)) {
      if (v && typeof v.label === 'string' && v.label.startsWith('t:')) {
        v.label = getByPath(locale, v.label.slice(2)) || v.label.slice(2)
      }
    }
  }

  return meta
}

/** 版本存储根目录（userDataDir/json-versions/）。 */
function versionsRoot() {
  const dir = join(userDataDir(), 'json-versions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 近期改动记录文件（userDataDir/json-recent.json）。 */
function recentFile() {
  return join(userDataDir(), 'json-recent.json')
}

const RECENT_MAX = 50

/**
 * 记录一次「文件被保存/切换/外部处理」的改动。
 * 同一文件只保留最近一条，按时间倒序。
 * @returns {{ items: Array<{ repoDir: string, repoName: string, rel: string, path: string, ts: number, label: string }> }}
 */
export function addJsonRecent(entry) {
  const file = recentFile()
  let items = []
  try {
    items = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(items)) items = []
  } catch {}
  const item = {
    repoDir: entry.repoDir,
    repoName: entry.repoName || basename(entry.repoDir),
    rel: entry.rel,
    path: entry.path,
    ts: Date.now(),
    label: formatVersionLabel(Date.now()),
  }
  // 同一文件去重：新记录放最前
  items = items.filter((it) => !(it.repoDir === item.repoDir && it.rel === item.rel))
  items.unshift(item)
  items = items.slice(0, RECENT_MAX)
  writeFileSync(file, JSON.stringify(items, null, 2), 'utf8')
  return { items }
}

/** 读取近期改动列表（按时间倒序）。 */
export function listJsonRecent() {
  try {
    const items = JSON.parse(readFileSync(recentFile(), 'utf8'))
    return { items: Array.isArray(items) ? items : [] }
  } catch {
    return { items: [] }
  }
}

/** 删除单条近期改动记录（按 repoDir + rel 定位）。 */
export function removeJsonRecent(repoDir, rel) {
  const file = recentFile()
  let items = []
  try {
    items = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(items)) items = []
  } catch {}
  items = items.filter((it) => !(it.repoDir === repoDir && it.rel === rel))
  writeFileSync(file, JSON.stringify(items, null, 2), 'utf8')
  return { items }
}

/** 清空全部近期改动记录。 */
export function clearJsonRecent() {
  try {
    writeFileSync(recentFile(), '[]', 'utf8')
  } catch {}
  return { items: [] }
}

/** 把「仓库路径 + 文件相对路径」哈希成稳定的目录名。 */
/**
 * 读取仓库当前分支（同步）。非 git 仓库 / 出错返回 '_nobranch'。
 * 仅用于版本目录命名，不需要异步性能。
 */
function currentBranchOf(repoDir) {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const b = String(out || '').trim()
    return b || '_nobranch'
  } catch {
    return '_nobranch'
  }
}

/**
 * 版本目录按「仓库 + 分支 + 文件」隔离：不同分支各自一份历史，互不干扰。
 * 分支名可能含 /（如 feature/x），先做安全替换再参与哈希。
 * @param {string} [branch] 显式指定分支；不传则自动读仓库当前分支
 */
function versionDir(repoDir, filePath, branch) {
  const rel = relative(repoDir, filePath).replace(/\\/g, '/')
  const safeBranch = String(branch || currentBranchOf(repoDir)).replace(/[^\w.-]+/g, '_')
  const hash = createHash('sha1').update(`${repoDir}::${safeBranch}::${rel}`).digest('hex').slice(0, 16)
  const dir = join(versionsRoot(), hash)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 记录原始路径信息（便于调试/迁移）
  const metaFile = join(dir, '_source.json')
  if (!existsSync(metaFile)) {
    try {
      writeFileSync(metaFile, JSON.stringify({ repoDir, branch: safeBranch, rel, file: basename(filePath) }, null, 2), 'utf8')
    } catch {}
  }
  return dir
}

/**
 * 一次性迁移：早期版本目录的哈希键是 repoDir::rel（未按分支隔离），
 * 分支隔离上线后哈希键改为 repoDir::branch::rel，旧快照会「失联」看不见。
 * 这里把旧目录（_source.json 无 branch 字段）里的快照搬进按仓库当前分支算出的新目录；
 * 仓库已不存在 / 非 git 仓库的旧目录跳过（无法确定归属分支）。搬空后旧目录只剩元数据，不会再触发。
 */
let legacyMigrated = false
function migrateLegacyVersionDirs() {
  if (legacyMigrated) return
  legacyMigrated = true
  const root = versionsRoot()
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(root, name)
    let src
    try {
      src = JSON.parse(readFileSync(join(dir, '_source.json'), 'utf8'))
    } catch {
      continue
    }
    if (src?.branch) continue // 已是新结构
    if (!src?.repoDir || !src?.rel || !existsSync(src.repoDir)) continue
    let safeBranch
    try {
      safeBranch = currentBranchOf(src.repoDir).replace(/[^\w.-]+/g, '_')
    } catch {
      continue
    }
    const hash = createHash('sha1')
      .update(`${src.repoDir}::${safeBranch}::${src.rel}`)
      .digest('hex')
      .slice(0, 16)
    const target = join(root, hash)
    if (target === dir) continue
    try {
      mkdirSync(target, { recursive: true })
      const metaFile = join(target, '_source.json')
      if (!existsSync(metaFile)) {
        writeFileSync(
          metaFile,
          JSON.stringify({ ...src, branch: safeBranch, migratedFrom: name }, null, 2),
          'utf8',
        )
      }
      for (const f of readdirSync(dir)) {
        if (!/^\d+\.json$/.test(f)) continue
        const to = join(target, f)
        if (!existsSync(to)) renameSync(join(dir, f), to)
      }
    } catch {
      /* 单个目录迁移失败不影响其它 */
    }
  }
}

/**
 * 保存一份版本快照。
 * @param {string} [name] 可选自定义名称，写入 <id>.name 与重命名共用一套展示逻辑
 * @returns {{ id: string, ts: number, label: string }}
 */
export function saveJsonVersion(repoDir, filePath, content, branch, name) {
  migrateLegacyVersionDirs()
  const dir = versionDir(repoDir, filePath, branch)
  const ts = Date.now()
  const id = String(ts)
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  writeFileSync(join(dir, `${id}.json`), text, 'utf8')
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed) writeFileSync(join(dir, `${id}.name`), trimmed, 'utf8')
  return { id, ts, label: formatVersionLabel(ts) }
}

/** 列出某文件的所有版本（按时间倒序）。自定义名称存于 <id>.name，展示时优先于时间戳。 */
export function listJsonVersions(repoDir, filePath, branch) {
  migrateLegacyVersionDirs()
  const dir = versionDir(repoDir, filePath, branch)
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  return files
    .map((f) => {
      const id = f.slice(0, -5)
      const ts = Number(id)
      let name = null
      try {
        name = readFileSync(join(dir, `${id}.name`), 'utf8').trim() || null
      } catch { /* 无自定义名称 */ }
      return { id, ts, name, label: name || formatVersionLabel(ts) }
    })
    .sort((a, b) => b.ts - a.ts)
}

/** 重命名版本（label 显示自定义名称；传空串清除恢复为时间戳）。 */
export function renameJsonVersion(repoDir, filePath, id, name, branch) {
  const dir = versionDir(repoDir, filePath, branch)
  const clean = String(name || '').trim()
  const nameFile = join(dir, `${id}.name`)
  if (!clean) {
    try { unlinkSync(nameFile) } catch { /* 本就不存在 */ }
    return { id, name: null, label: formatVersionLabel(Number(id)) }
  }
  writeFileSync(nameFile, clean, 'utf8')
  return { id, name: clean, label: clean }
}

/** 删除版本快照（内容 + 自定义名称）。返回剩余版本数。 */
export function deleteJsonVersion(repoDir, filePath, id, branch) {
  const dir = versionDir(repoDir, filePath, branch)
  try { unlinkSync(join(dir, `${id}.json`)) } catch { /* 文件不存在 */ }
  try { unlinkSync(join(dir, `${id}.name`)) } catch { /* 无名称 */ }
  const left = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length
  return { left }
}

/** 批量删除版本快照。ids 为版本 id 数组，返回剩余版本数。 */
export function deleteJsonVersions(repoDir, filePath, ids, branch) {
  const dir = versionDir(repoDir, filePath, branch)
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    try { unlinkSync(join(dir, `${id}.json`)) } catch { /* 文件不存在 */ }
    try { unlinkSync(join(dir, `${id}.name`)) } catch { /* 无名称 */ }
  }
  const left = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length
  return { left }
}

/** 加载某版本的内容（字符串）。 */
export function loadJsonVersion(repoDir, filePath, id, branch) {
  const dir = versionDir(repoDir, filePath, branch)
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

/**
 * 在版本快照中找到与 content 内容一致的那个，返回其 id（无匹配返回 null）。
 * 用于打开文件时把「当前版本」指针校准到磁盘真实状态，而不是无脑指最新。
 */
export function matchVersionId(repoDir, filePath, content, branch) {
  const dir = versionDir(repoDir, filePath, branch)
  if (!existsSync(dir)) return null
  // 内容级比较：剥注释头后解析成 JSON 再序列化比较，不受缩进/空白差异影响
  // （快照可能来自格式化后的写入，磁盘可能保留原始排版，逐字符比永远比不上）
  const norm = (s) => {
    try {
      const stripped = String(s || '')
        .replace(/^\uFEFF/, '')
        .replace(/^\/\*[\s\S]*?\*\//, '')
        .replace(/,(\s*[}\]])/g, '$1')
      return JSON.stringify(JSON.parse(stripped))
    } catch {
      return null
    }
  }
  const target = norm(content)
  if (!target) return null
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  for (const f of files) {
    try {
      const v = norm(readFileSync(join(dir, f), 'utf8'))
      if (v && v === target) return f.slice(0, -5)
    } catch {
      /* 单个快照读失败不阻塞 */
    }
  }
  return null
}

/** 格式化时间戳为「YYYY-MM-DD HH:mm:ss」（精确到秒，作为版本下拉显示名）。 */
function formatVersionLabel(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
