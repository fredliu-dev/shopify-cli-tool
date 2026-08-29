// 爬虫断点继续持久化层。
// 每个运行（runId）在 userDataDir()/crawler-runs/<projectId>/<runId>/ 下保存状态。
// 支持单流程、loop、并发 loop 的断点恢复。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const load = () => import('@shopify-cli-tool/core')

let dirCache = null

/** 运行状态根目录。 */
async function runsDir() {
  if (dirCache) return dirCache
  const { userDataDir } = await load()
  dirCache = join(userDataDir(), 'crawler-runs')
  mkdirSync(dirCache, { recursive: true })
  return dirCache
}

async function runsProjectDir(projectId) {
  return join(await runsDir(), projectId)
}

async function runDir(projectId, runId) {
  return join(await runsProjectDir(projectId), runId)
}

async function stateFile(projectId, runId) {
  return join(await runDir(projectId, runId), 'state.json')
}

/** 生成新 runId。 */
export function newRunId() {
  return randomUUID().slice(0, 8)
}

/**
 * 保存断点。
 * @param {string} projectId
 * @param {string} runId
 * @param {object} checkpoint
 */
export async function saveCheckpoint(projectId, runId, checkpoint) {
  const file = await stateFile(projectId, runId)
  mkdirSync(dirname(file), { recursive: true })
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...checkpoint,
  }
  const text = JSON.stringify(payload, replacer, 2)
  writeFileSync(file, text, 'utf8')
  return { ok: true, path: file, bytes: Buffer.byteLength(text) }
}

/**
 * 加载断点。
 * @returns {object | null}
 */
export async function loadCheckpoint(projectId, runId) {
  const file = await stateFile(projectId, runId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'), reviver)
  } catch (err) {
    return { _broken: true, error: err.message }
  }
}

/** 列出某项目下所有未完成的运行（status !== done）。 */
export async function listRunningRuns(projectId) {
  const pdir = await runsProjectDir(projectId)
  if (!existsSync(pdir)) return []
  const out = []
  for (const runId of readdirSync(pdir)) {
    const cp = await loadCheckpoint(projectId, runId)
    if (!cp || cp._broken) continue
    if (cp.status !== 'done') {
      out.push({ runId, status: cp.status, updatedAt: cp.updatedAt, failedAt: cp.failedAt || null })
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** 列出某项目的最新未完成运行。 */
export async function latestRunningRun(projectId) {
  const runs = await listRunningRuns(projectId)
  return runs[0] || null
}

/** 删除某次运行的断点数据。 */
export async function removeCheckpoint(projectId, runId) {
  const dir = await runDir(projectId, runId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  return { ok: true }
}

/** 完成时可选归档或删除。默认删除。 */
export async function finishCheckpoint(projectId, runId, keep = false) {
  if (keep) {
    const cp = await loadCheckpoint(projectId, runId)
    if (cp) {
      cp.status = 'done'
      await saveCheckpoint(projectId, runId, cp)
    }
    return { ok: true, kept: true }
  }
  return removeCheckpoint(projectId, runId)
}

/** 保存 worker 断点（并发 loop 用）。 */
export async function saveWorkerCheckpoint(projectId, runId, workerIndex, checkpoint) {
  const dir = join(await runDir(projectId, runId), 'workers')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `worker-${workerIndex}.json`)
  const text = JSON.stringify(checkpoint, replacer, 2)
  writeFileSync(file, text, 'utf8')
  return { ok: true, path: file, bytes: Buffer.byteLength(text) }
}

/** 加载 worker 断点。 */
export async function loadWorkerCheckpoint(projectId, runId, workerIndex) {
  const file = join(await runDir(projectId, runId), 'workers', `worker-${workerIndex}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'), reviver)
  } catch {
    return null
  }
}

/** 列出某运行下所有 worker 断点。 */
export async function listWorkerCheckpoints(projectId, runId) {
  const dir = join(await runDir(projectId, runId), 'workers')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    const m = f.match(/^worker-(\d+)\.json$/)
    if (!m) continue
    const idx = Number(m[1])
    const cp = await loadWorkerCheckpoint(projectId, runId, idx)
    if (cp) out.push({ workerIndex: idx, checkpoint: cp })
  }
  return out.sort((a, b) => a.workerIndex - b.workerIndex)
}

/** 删除指定 worker 断点。 */
export async function removeWorkerCheckpoint(projectId, runId, workerIndex) {
  const file = join(await runDir(projectId, runId), 'workers', `worker-${workerIndex}.json`)
  if (existsSync(file)) rmSync(file)
  return { ok: true }
}

/** Map 序列化。 */
function replacer(_key, value) {
  if (value instanceof Map) {
    return { __type: 'Map', value: Array.from(value.entries()) }
  }
  return value
}

/** Map 反序列化。 */
function reviver(_key, value) {
  if (value && typeof value === 'object' && value.__type === 'Map') {
    return new Map(value.value)
  }
  return value
}
