// 爬虫表格工具：CSV/JSON 表格文件的解析与导出（导入表格 / 表格导出模块共用）。
// 纯字符串处理无 Electron 依赖；导出目录 userDataDir()/crawler-exports/（自动创建，
// config:export 备份 zip 递归打包会带上）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const load = () => import('@shopify-cli-tool/core')

let dirCache = null

/** 表格导出目录（懒初始化，core 是 ESM 只能动态 import）。 */
async function exportsDir() {
  if (dirCache) return dirCache
  const { userDataDir } = await load()
  dirCache = join(userDataDir(), 'crawler-exports')
  mkdirSync(dirCache, { recursive: true })
  return dirCache
}

/** 单行 CSV 解析：支持引号包裹、"" 转义、字段内逗号/换行。 */
function splitCsvLine(line) {
  const cells = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"' && cur === '') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

/**
 * CSV 文本 → {columns, rows}。首行为列名，其余为数据行；去 BOM、跳过空行。
 * 列名重复时后者加后缀（表格按列名做变量引用，必须唯一）。
 */
export function parseCsv(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = clean.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return { columns: [], rows: [] }
  const rawHeader = splitCsvLine(lines[0]).map((h) => h.trim())
  const columns = []
  for (const h of rawHeader) {
    let name = h || `列${columns.length + 1}`
    let i = 2
    while (columns.includes(name)) name = `${h}(${i++})`
    columns.push(name)
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const row = {}
    columns.forEach((c, idx) => (row[c] = (cells[idx] ?? '').trim()))
    rows.push(row)
  }
  return { columns, rows }
}

/** 按扩展名读表格文件（.json 需为对象数组）。 */
export function readTableFile(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  if (/\.json$/i.test(filePath)) {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || arr.length === 0 || typeof arr[0] !== 'object') {
      throw new Error('JSON 表格必须是对象数组（如 [{ "列名": "值" }]）')
    }
    const columns = []
    for (const r of arr) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k)
    return { columns, rows: arr }
  }
  return parseCsv(raw)
}

const csvEscape = (v) => {
  if (v === null || v === undefined) return ''
  // 对象/数组（如接口拦截存入的 JSON 变量）序列化成 JSON 文本，否则 String() 会是 [object Object]
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 表格 → CSV 文本（带 BOM，Excel 打开中文不乱码）。 */
export function tableToCsv(columns, rows) {
  const cols = columns.length ? columns : Object.keys(rows[0] || {})
  const lines = [cols.map(csvEscape).join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))]
  // \uFEFF BOM：Excel 无 BOM 会按 ANSI 解析，中文列名/内容乱码
  return `\uFEFF${lines.join('\r\n')}`
}

/** 表格 → JSON 文本。 */
export function tableToJson(columns, rows) {
  const cols = columns.length ? columns : Object.keys(rows[0] || {})
  return JSON.stringify(cols.length ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))) : rows, null, 2)
}

/**
 * 表格导出：savePath 指定保存目录（必填，~ 按家目录展开，不存在自动创建）；
 * 未指定时回落到 crawler-exports/（兼容旧画布与手动调用）。
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function exportTableFile({ savePath, baseName, format, columns, rows }) {
  try {
    let dir
    if (String(savePath || '').trim()) {
      const expanded = String(savePath).trim().replace(/^~(?=\/|$)/, homedir())
      mkdirSync(expanded, { recursive: true }) // 目录不存在当场建；建不了（权限/非法路径）在这里报
      dir = expanded
    } else {
      dir = await exportsDir()
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const safe = String(baseName || 'crawler-table').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'crawler-table'
    const path = join(dir, `${safe}_${stamp}.${format === 'json' ? 'json' : 'csv'}`)
    writeFileSync(path, format === 'json' ? tableToJson(columns, rows) : tableToCsv(columns, rows), 'utf8')
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
