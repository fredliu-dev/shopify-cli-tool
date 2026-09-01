// 爬虫工作流项目持久化：userDataDir()/crawlers/<id>.json，一个项目一个文件。
// 说明：爬虫执行依赖 Electron BrowserWindow，不可能 headless，故不放 core（发 npm、CLI 共用的
// headless 包）；desktop ipc 绕过 core 直写文件已有先例（config.js 导出 zip / initCreate 写 toml）。
// 数据目录复用 core 的 userDataDir()/ensureDataDir()（路径单一来源，config:export 备份 zip
// 递归打包 userDataDir 自动带上 crawlers/）。本模块纯 fs 无 Electron 依赖，将来若 CLI 也要跑
// 爬虫可整体上提 core。
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const load = () => import('@shopify-cli-tool/core')

let dirCache = null

/** crawlers 数据目录（懒初始化，core 是 ESM 只能动态 import）。 */
async function crawlersDir() {
  if (dirCache) return dirCache
  const { userDataDir } = await load()
  dirCache = join(userDataDir(), 'crawlers')
  mkdirSync(dirCache, { recursive: true })
  return dirCache
}

/** 画布默认结构（新建项目用）。 */
function emptyGraph() {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 校验画布结构（保存/导入/运行前共用）：nodes/edges 为数组、node 带 id/type/position/data、
 * edge 带 id/source/target。只做结构校验，模块配置完整性由 runner 的运行前校验负责。
 * @returns {{ok: boolean, error?: string}}
 */
export function validateGraph(graph) {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, error: '画布数据缺少 nodes/edges 数组' }
  }
  const nodeIds = new Set()
  for (const n of graph.nodes) {
    if (!isPlainObject(n) || typeof n.id !== 'string' || typeof n.type !== 'string') {
      return { ok: false, error: '存在缺少 id/type 的节点' }
    }
    if (!isPlainObject(n.position) || typeof n.position.x !== 'number') {
      return { ok: false, error: `节点 ${n.id} 缺少 position` }
    }
    nodeIds.add(n.id)
  }
  for (const e of graph.edges) {
    if (!isPlainObject(e) || typeof e.source !== 'string' || typeof e.target !== 'string') {
      return { ok: false, error: '存在缺少 source/target 的连线' }
    }
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      return { ok: false, error: `连线 ${e.source} → ${e.target} 引用了不存在的节点` }
    }
  }
  return { ok: true }
}

/** 文档转列表项（ls 不回传完整画布，减载荷）。 */
function toSummary(doc) {
  return {
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    nodeCount: doc.graph?.nodes?.length ?? 0,
  }
}

/** 项目列表（摘要，按 updatedAt 倒序）。 */
export async function listCrawlers() {
  const dir = await crawlersDir()
  const docs = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      docs.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* 单个文件损坏不拖垮整个列表 */
    }
  }
  return docs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(toSummary)
}

/** 读单个项目，不存在返回 null。 */
export async function getCrawler(id) {
  const dir = await crawlersDir()
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 新建项目（空画布）。 */
export async function createCrawler(name) {
  const now = new Date().toISOString()
  const doc = { version: 1, id: randomUUID(), name, createdAt: now, updatedAt: now, graph: emptyGraph() }
  const dir = await crawlersDir()
  writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf8')
  return doc
}

/**
 * 保存画布（自动保存与手动保存共用）。id 不存在报错；graph 结构校验失败报错。
 * @param {{id: string, name?: string, graph: object}} opts
 */
export async function saveCrawler({ id, name, graph }) {
  const existing = await getCrawler(id)
  if (!existing) return { ok: false, error: '项目不存在（可能已被删除），请重新打开' }
  const check = validateGraph(graph)
  if (!check.ok) return { ok: false, error: check.error }
  const updatedAt = new Date().toISOString()
  const doc = { ...existing, name: typeof name === 'string' && name.trim() ? name.trim() : existing.name, graph, updatedAt }
  const dir = await crawlersDir()
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(doc, null, 2), 'utf8')
  return { ok: true, data: { updatedAt } }
}

/** 另存为新项目（生成新 id，含原文档画布）。 */
export async function saveCrawlerAs({ name, graph }) {
  const check = validateGraph(graph)
  if (!check.ok) return { ok: false, error: check.error }
  const now = new Date().toISOString()
  const doc = { version: 1, id: randomUUID(), name, createdAt: now, updatedAt: now, graph }
  const dir = await crawlersDir()
  writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf8')
  return { ok: true, data: doc }
}

/** 重命名。 */
export async function renameCrawler({ id, name }) {
  const existing = await getCrawler(id)
  if (!existing) return { ok: false, error: '项目不存在' }
  existing.name = name.trim()
  existing.updatedAt = new Date().toISOString()
  const dir = await crawlersDir()
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(existing, null, 2), 'utf8')
  return { ok: true }
}

/** 删除项目文件。 */
export async function deleteCrawler(id) {
  const dir = await crawlersDir()
  const file = join(dir, `${id}.json`)
  if (existsSync(file)) unlinkSync(file)
  return { ok: true }
}

/* -------- 公共资源库（跨项目共享的元素选择器 / 网址） -------- */

/**
 * 公共资源库文件：userDataDir()/crawler-common.json（crawlers 目录外——listCrawlers
 * 会把目录里所有 .json 当项目读，混进去会在项目列表里出现一条垃圾数据）。
 * 结构：{ version: 1, elements: [{id,name,mode,value}], urls: [{id,name,value}] }。
 * 模块配置里选中公共条目即把值拷进节点 data（运行时与手填完全一致，runner 无感知）。
 */
async function commonFile() {
  const { userDataDir, ensureDataDir } = await load()
  ensureDataDir()
  return join(userDataDir(), 'crawler-common.json')
}

/** 读公共资源库，损坏/不存在返回空库。 */
export async function getCommonLib() {
  const file = await commonFile()
  if (!existsSync(file)) return { elements: [], urls: [] }
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    return {
      elements: Array.isArray(doc.elements) ? doc.elements : [],
      urls: Array.isArray(doc.urls) ? doc.urls : [],
    }
  } catch {
    return { elements: [], urls: [] }
  }
}

/** 写公共资源库（整体覆盖）：条目做最小形状校验，元素带 mode/value、网址带 value。 */
export async function saveCommonLib(data) {
  if (!isPlainObject(data)) return { ok: false, error: '公共资源数据格式错误' }
  const normList = (arr, isElement) => {
    if (!Array.isArray(arr)) return null
    const out = []
    for (const item of arr) {
      if (!isPlainObject(item) || !String(item.value || '').trim()) continue // 无值的条目直接丢弃
      out.push({
        id: typeof item.id === 'string' ? item.id : randomUUID(),
        name: String(item.name || '').trim().slice(0, 50) || String(item.value).slice(0, 50),
        ...(isElement ? { mode: String(item.mode || 'class') } : {}),
        value: String(item.value).trim().slice(0, 500),
      })
    }
    return out
  }
  const elements = normList(data.elements, true)
  const urls = normList(data.urls, false)
  if (!elements || !urls) return { ok: false, error: '公共资源数据格式错误' }
  const file = await commonFile()
  writeFileSync(file, JSON.stringify({ version: 1, elements, urls }, null, 2), 'utf8')
  return { ok: true, data: { elements, urls } }
}
