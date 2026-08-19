/**
 * Shopify 主题文件引用关系扫描（headless：只读磁盘文件，不依赖 shopify CLI）。
 *
 * 主题的「引用」是约定式的，而非 JS import 那种显式依赖：
 *   - {% render 'x' %} / {% include 'x' %}       → snippets/x.liquid
 *   - {% section 'x' %}                          → sections/x.liquid
 *   - {% sections 'x' %}（section group 入口）    → sections/x.json
 *   - {{ 'x.js' | asset_url }}（字面量）          → assets/x.js
 *   - templates/*.json 与 sections/*.json（分组）的 sections.<key>.type → sections/<type>.liquid
 *   - assets/*.css 里的 @import / url() 相对引用  → assets/ 内相对路径
 *
 * 全部按字面量静态匹配：变量/拼接的动态引用（如 {% render name %}）无法识别；
 * 消费方（桌面端关系图弹窗）需附上对应的限制说明。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, posix, relative, sep } from 'node:path'
import { ensureDataDir, userDataDir } from './paths.js'

/** 引用图缓存文件（userData 目录下，与 settings.json 同级）；扫描大主题耗时，结果按仓库缓存。 */
const DEP_CACHE_FILE = join(userDataDir(), 'dep-graph-cache.json')
/** 最多缓存多少个仓库的扫描结果（按 savedAt 淘汰最旧），防缓存文件无限膨胀。 */
const DEP_CACHE_MAX = 20
/**
 * 缓存数据版本：扫描逻辑修过 bug（如 JSON 模板注释头导致边丢失）时 +1，
 * 旧版本缓存直接作废 → 打开窗口自动重扫，避免用户一直看到修复前的坏数据。
 */
const DEP_CACHE_VERSION = 2

/** 主题标准目录；节点分类/配色按这个顺序。 */
const THEME_DIRS = ['layout', 'templates', 'sections', 'snippets', 'assets']
/** assets 里始终入图的代码类文件；其余（图片/字体等）仅在被引用时入图，避免孤立图片刷屏。 */
const ASSET_CODE_RE = /\.(css|js|mjs|cjs)$/i
/** 需要读内容解析引用的文件；其余（图片等）只作为「被引用」的落点。 */
const PARSEABLE_RE = /\.(liquid|json|css|js|mjs|cjs)$/i
/** 超大文件（压缩后的资产等）跳过解析，防一次性读爆内存。 */
const MAX_PARSE_SIZE = 5 * 1024 * 1024

const toPosix = (p) => p.split(sep).join('/')

/** Liquid 标签/过滤器提取规则：捕获字面量名 → 主题内目标文件（theme 相对路径）。 */
const LIQUID_RULES = [
  { re: /\{%-?\s*render\s+['"]([^'"]+)['"]/g, to: (n) => `snippets/${n}.liquid` },
  { re: /\{%-?\s*include\s+['"]([^'"]+)['"]/g, to: (n) => `snippets/${n}.liquid` },
  { re: /\{%-?\s*section\s+['"]([^'"]+)['"]/g, to: (n) => `sections/${n}.liquid` },
  { re: /\{%-?\s*sections\s+['"]([^'"]+)['"]/g, to: (n) => `sections/${n}.json` },
  { re: /\{\{\s*['"]([^'"]+)['"]\s*\|[^{}]*asset_url/g, to: (n) => `assets/${n}` },
]

/** CSS 相对引用提取：@import 与 url()；http(s)/data:/# 等外部引用在解析时过滤。 */
const CSS_RULES = [/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g, /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g]

/** 递归找主题根：目录下直接挂主题目录（layout/templates，或 sections+snippets）即视为主题根，不再下钻。 */
function findThemeRoots(dir, depth, found) {
  if (depth > 3) return found
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  const names = new Set(entries.map((e) => e.name))
  const isTheme = names.has('layout') || names.has('templates') || (names.has('sections') && names.has('snippets'))
  if (isTheme) {
    found.push(dir)
    return found
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    findThemeRoots(join(dir, e.name), depth + 1, found)
  }
  return found
}

/** 递归收集目录下全部文件（跳过 . 开头），收集绝对路径到 out。 */
function collectFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectFiles(full, out)
    else if (e.isFile()) out.push(full)
  }
}

/** 从 liquid 源码提取引用（theme 相对路径，未加根前缀）。 */
function refsFromLiquid(code) {
  const out = []
  for (const { re, to } of LIQUID_RULES) {
    for (const [, name] of code.matchAll(re)) out.push(to(name))
  }
  return out
}

/**
 * 宽松化非标 JSON：字符串外剥掉 // 行注释、块注释与尾逗号。
 * 主题编辑器生成的 JSON 头部有块注释声明块，手改过的模板还可能带行内注释、尾逗号
 * （这些 JSON.parse 都不接受）；用状态机跳过字符串内容，避免误伤 "shopify://" 这类值。
 */
function looseJson(code) {
  let out = ''
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '"') {
      let j = i + 1
      while (j < code.length && code[j] !== '"') j += code[j] === '\\' ? 2 : 1
      out += code.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? code.length : end + 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < code.length && /\s/.test(code[j])) j++
      if (code[j] === '}' || code[j] === ']') continue
    }
    out += c
  }
  return out
}

/** 剥 BOM 后先按标准 JSON 解析，失败再走宽松化重试；两次都失败才返回 null。 */
function parseLooseJson(code) {
  const text = code.replace(/^﻿/, '')
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(looseJson(text))
    } catch {
      return null
    }
  }
}

/**
 * 从 JSON 模板 / section 分组提取引用；顺带返回顶层 name（分组自身描述）。
 * 注意：只认 sections.<key>.type；blocks[].type 是区块类型（schema 内定义），不指向文件。
 */
function refsFromThemeJson(code) {
  const json = parseLooseJson(code)
  if (!json || typeof json !== 'object') return { refs: [], desc: null }
  const refs = []
  for (const s of Object.values(json.sections ?? {})) {
    if (s && typeof s.type === 'string') refs.push(`sections/${s.type}.liquid`)
  }
  const name = typeof json.name === 'string' ? json.name.trim() : ''
  return { refs, desc: name || null }
}

/** 从 CSS 提取相对引用：去 ?查询/#锚点，按当前文件目录归一化；外部/越界引用丢弃。 */
function refsFromCss(code, themeRelFile) {
  const out = []
  const baseDir = posix.dirname(themeRelFile)
  for (const re of CSS_RULES) {
    for (const [, raw] of code.matchAll(re)) {
      const ref = raw.trim().replace(/[?#].*$/, '')
      if (!ref || /^(https?:)?\/\//i.test(ref) || /^data:/i.test(ref) || ref.startsWith('/') || ref.startsWith('#')) continue
      const target = posix.normalize(posix.join(baseDir, ref))
      if (target.startsWith('../')) continue
      out.push(target)
    }
  }
  return out
}

/** section 的 {% schema %} name 作为文件描述（解析失败静默返回 null）。 */
function sectionDesc(code) {
  const m = code.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/)
  if (!m) return null
  const name = parseLooseJson(m[1])?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * 读取引用图缓存：{ [repoPath]: { v, savedAt, data } }；文件缺失/损坏返回 {}。
 * 版本号不匹配的旧条目视为不存在（丢弃，触发下次打开自动重扫）。
 * @returns {Record<string, { savedAt: number, data: object }>}
 */
export function loadDepGraphCache() {
  ensureDataDir()
  try {
    const obj = JSON.parse(readFileSync(DEP_CACHE_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object') return {}
    for (const key of Object.keys(obj)) {
      if (obj[key]?.v !== DEP_CACHE_VERSION) delete obj[key]
    }
    return obj
  } catch {
    return {}
  }
}

/**
 * 写入单个仓库的引用图缓存，并按 savedAt 淘汰最旧的（只保留最近 DEP_CACHE_MAX 个）。
 * 写失败静默（不影响扫描结果本身返回）。
 * @param {string} repoPath
 * @param {object} data scanThemeDeps 的 data
 */
export function saveDepGraphCache(repoPath, data) {
  ensureDataDir()
  const all = { ...loadDepGraphCache(), [repoPath]: { v: DEP_CACHE_VERSION, savedAt: Date.now(), data } }
  const keys = Object.keys(all)
  if (keys.length > DEP_CACHE_MAX) {
    const drop = keys.sort((a, b) => all[a].savedAt - all[b].savedAt).slice(0, keys.length - DEP_CACHE_MAX)
    drop.forEach((k) => delete all[k])
  }
  try {
    writeFileSync(DEP_CACHE_FILE, JSON.stringify(all), 'utf8')
  } catch {
    /* 磁盘满/权限等：缓存写不进就算了 */
  }
}

/**
 * 扫描仓库内 Shopify 主题文件的静态引用关系。
 * 支持主题在仓库根或子目录（递归找主题根，最多 3 层）；多个主题根时并入同一张图（id 带各自前缀）。
 * @param {string} repoPath 仓库路径
 * @param {{ onProgress?: (p: { stage: 'parse'|'done', current: number, total: number }) => void }} [opts]
 *   onProgress：逐文件上报解析进度（扫描大主题时 UI 可显示 x/y）；每 20 个文件让出一次主线程，
 *   保证 Electron 主进程在扫描期间仍响应事件。
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 *   data.nodes：{ id, name, path, dir, desc, refIn, refOut }，id 与 path 均为仓库相对 POSIX 路径
 *   data.edges：{ source, target }，source=被引用文件、target=引用它的文件（箭头指向引用方）
 *   data.stats：{ files, edges, missing, roots }；data.missing：不存在的引用示例（去重，最多 30 条）
 */
export async function scanThemeDeps(repoPath, { onProgress } = {}) {
  const report = (p) => {
    try {
      onProgress?.(p)
    } catch {
      /* 回调异常不影响扫描 */
    }
  }
  const roots = findThemeRoots(repoPath, 0, [])
  const metas = new Map() // id -> { id, name, dir, desc }
  const allFiles = [] // { abs, id, themeRel, dir }
  const refs = [] // { from: id, to: id }

  // 第一遍：收集主题目录下全部文件
  for (const root of roots) {
    const prefix = toPosix(relative(repoPath, root))
    const withPrefix = (themeRel) => (prefix ? `${prefix}/${themeRel}` : themeRel)
    for (const dirName of THEME_DIRS) {
      const dirAbs = join(root, dirName)
      if (!existsSync(dirAbs)) continue
      const collected = []
      collectFiles(dirAbs, collected)
      for (const abs of collected) {
        // relative(root, abs) 本身就以目录名开头（abs 在 root/dirName/ 下），不要再拼一遍
        const themeRel = toPosix(relative(root, abs))
        const id = withPrefix(themeRel)
        metas.set(id, { id, name: basename(abs), path: id, dir: dirName, desc: null })
        allFiles.push({ abs, id, themeRel, dir: dirName })
      }
    }
  }

  // 第二遍：读代码文件解析引用 + 提取描述（section schema name / 分组 name）。
  // 每个文件上报一次进度；每 20 个文件让出主线程（setImmediate），扫描期间主进程不卡、
  // 进度事件也能平滑送达渲染层，而不是扫描结束时一次性收到。
  let done = 0
  for (const f of allFiles) {
    done += 1
    report({ stage: 'parse', current: done, total: allFiles.length })
    if (done % 20 === 0) await new Promise((resolve) => setImmediate(resolve))
    if (!PARSEABLE_RE.test(f.id)) continue
    let code
    try {
      if (statSize(f.abs) > MAX_PARSE_SIZE) continue
      code = readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    const root = roots.find((r) => f.abs.startsWith(r + sep))
    const prefix = root ? toPosix(relative(repoPath, root)) : ''
    const withPrefix = (themeRel) => (prefix ? `${prefix}/${themeRel}` : themeRel)
    const pushRefs = (targets) => {
      for (const t of targets) refs.push({ from: f.id, to: withPrefix(t) })
    }

    if (f.dir === 'assets' && /\.css$/i.test(f.abs)) {
      pushRefs(refsFromCss(code, f.themeRel))
    } else if (/\.liquid$/i.test(f.abs)) {
      pushRefs(refsFromLiquid(code))
      if (f.dir === 'sections') metas.get(f.id).desc = sectionDesc(code)
    } else if (/\.json$/i.test(f.abs) && (f.dir === 'templates' || f.dir === 'sections')) {
      const { refs: targets, desc } = refsFromThemeJson(code)
      pushRefs(targets)
      metas.get(f.id).desc = desc
    }
  }

  // 入图集合：非 assets 全进；assets 仅代码文件 + 被引用的（孤立图片不进图）
  const referenced = new Set(refs.map((r) => r.to))
  const nodeIds = new Set()
  const nodes = []
  for (const f of allFiles) {
    const always = f.dir !== 'assets' || ASSET_CODE_RE.test(f.id)
    if (!always && !referenced.has(f.id)) continue
    nodeIds.add(f.id)
    nodes.push({ ...metas.get(f.id), refIn: 0, refOut: 0 })
  }

  // 建边（source=被引用 → target=引用方）并统计次数；目标文件不存在 → 计入 missing
  const edges = []
  const missing = new Set()
  for (const r of refs) {
    if (!nodeIds.has(r.from) || !nodeIds.has(r.to)) {
      if (nodeIds.has(r.from)) missing.add(`${r.from} → ${r.to}`)
      continue
    }
    if (r.to === r.from) continue
    edges.push({ source: r.to, target: r.from })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    byId.get(e.source).refIn += 1
    byId.get(e.target).refOut += 1
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  report({ stage: 'done', current: done, total: allFiles.length })

  return {
    ok: true,
    data: {
      nodes,
      edges,
      stats: { files: nodes.length, edges: edges.length, missing: missing.size, roots: roots.length },
      missing: [...missing].slice(0, 30),
    },
  }
}

/** 文件大小（读不了 stat 的按超限处理，跳过解析）。 */
function statSize(abs) {
  try {
    return statSync(abs).size
  } catch {
    return Infinity
  }
}
