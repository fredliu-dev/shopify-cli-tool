import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

// @shopify/cli 的 exports 没有暴露 bin 子路径，所以先解析它的 package.json
// （该子路径已暴露），再读 bin 字段定位实际入口脚本。
const pkgJsonPath = require.resolve('@shopify/cli/package.json')
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.shopify
const SHOPIFY_BIN = join(dirname(pkgJsonPath), binRel)

/**
 * 用子进程跑 @shopify/cli，shopify 自身的彩色输出原样透传。
 * headless：进程错误时静默返回退出码（不再打印，由调用方按退出码处理）。
 * （环境参数请用 config.js 的 resolveEnvironment(args) 单独获取。）
 * @param {string[]} args 透传给 shopify 的参数（原样，不做改动）
 * @returns {Promise<number>} 进程退出码
 */
export function runShopify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHOPIFY_BIN, ...args], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    })
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', () => resolve(1))
  })
}

/**
 * 跑 @shopify/cli 但捕获 stdout/stderr（用于 -j 的 JSON 命令，如 theme list/duplicate）。
 * 与 runShopify 的区别：stdout 不直接打印而是收集起来供解析；stderr 收集后由调用方按需打印。
 * 关掉彩色（FORCE_COLOR=0）避免 ANSI 码污染 JSON。
 * @param {string[]} args 透传给 shopify 的参数（原样，不做改动）
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function captureShopify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHOPIFY_BIN, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
    child.on('error', () => resolve({ code: 1, stdout, stderr }))
  })
}

/**
 * 跑 @shopify/cli 并把输出**按 chunk 流式回调**（供 GUI 实时显示）。
 * 介于 runShopify（inherit，GUI 拿不到字节）与 captureShopify（全量 buffer，不适合 dev server 长连接）之间。
 * @param {string[]} args 透传给 shopify 的参数
 * @param {{ onData?: (chunk: string, stream: 'stdout'|'stderr') => void, env?: Record<string,string> }} [opts]
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<number> }}
 *   child 可用于提前 kill；done resolve 退出码
 */
export function streamShopify(args, { onData, env } = {}) {
  const child = spawn(process.execPath, [SHOPIFY_BIN, ...args], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1', ...env },
  })
  child.stdout.on('data', (d) => onData?.(d.toString(), 'stdout'))
  child.stderr.on('data', (d) => onData?.(d.toString(), 'stderr'))

  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', () => resolve(1))
  })
  return { child, done }
}
