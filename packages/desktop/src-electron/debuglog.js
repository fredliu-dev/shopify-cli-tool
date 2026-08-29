// 诊断日志（闪退排查专用）：落盘到 userDataDir()/logs/crawler-debug.log。
// 现有 ctx.log 只推给渲染窗口，进程一崩日志全丢——这里用 appendFileSync 同步追加，
// 任何未捕获异常/渲染进程崩溃发生时，之前的日志已在盘上。
// 所有错误静默吞掉：诊断工具不能反噬主流程。文件超 20MB 轮转为 .old 防无限增长。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOG_MAX = 20 * 1024 * 1024

let logFile = null
let initStarted = false
let writeCount = 0
const buffer = [] // 日志路径就绪前的行先缓冲，初始化完成后按序补写

async function ensureFile() {
  const { userDataDir } = await import('@shopify-cli-tool/core')
  mkdirSync(join(userDataDir(), 'logs'), { recursive: true })
  logFile = join(userDataDir(), 'logs', 'crawler-debug.log')
  for (const line of buffer.splice(0)) {
    try {
      appendFileSync(logFile, line)
    } catch {
      /* 忽略 */
    }
  }
}

/** 消息格式化：Error 打完整堆栈，对象 JSON 化（失败降级 String）。 */
function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/**
 * 追加一行诊断日志。
 * @param {string} scope 标签（app / crawler:<runId> / crawler:<runId>:w<进程号> …）
 * @param {string | Error | object} msg
 */
export function dlog(scope, msg) {
  try {
    const line = `[${new Date().toISOString()}] [${scope}] ${fmt(msg)}\n`
    if (!logFile) {
      buffer.push(line)
      if (!initStarted) {
        initStarted = true
        ensureFile().catch(() => {})
      }
      return
    }
    appendFileSync(logFile, line)
    // 每 200 行查一次大小，超限轮转（.old 被覆盖）
    if (++writeCount % 200 === 0) {
      try {
        if (statSync(logFile).size > LOG_MAX) renameSync(logFile, `${logFile}.old`)
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 静默 */
  }
}

/** 内存快照一行：排查被系统 OOM 杀掉的场景（rss 持续增长趋势可见）。 */
export function dmem(scope, tag = '') {
  try {
    const m = process.memoryUsage()
    const mb = (n) => `${Math.round(n / 1024 / 1024)}MB`
    dlog(scope, `${tag}内存 rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}`)
  } catch {
    /* 静默 */
  }
}
