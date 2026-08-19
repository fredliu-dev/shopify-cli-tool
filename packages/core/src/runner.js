import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, delimiter } from 'node:path'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

// @shopify/cli 的 exports 没有暴露 bin 子路径，所以先解析它的 package.json
// （该子路径已暴露），再读 bin 字段定位实际入口脚本。
const pkgJsonPath = require.resolve('@shopify/cli/package.json')
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.shopify
const SHOPIFY_BIN = join(dirname(pkgJsonPath), binRel)

/** 实装的 @shopify/cli 版本（与 bin 同源，解析自其 package.json）。桌面端「关于」展示用。 */
export const SHOPIFY_CLI_VERSION = pkg.version || null

/** 是否身处 Electron 主进程（此时 process.execPath 是 Electron 而非系统 node）。 */
const isElectron = !!process.versions.electron
/** 缓存解析出的系统 node 路径（Electron 下不能直接拿偏旧的内置 Node 跑新版 @shopify/cli）。 */
let _systemNode = null
/** 解析结果是否为兜底（没找到系统 Node、只能退回 Electron 内置 Node）；桌面端据此提示安装 Node.js。 */
let _nodeIsFallback = false
/**
 * 子进程的 stdin 策略：有真实 TTY（CLI 场景）才 inherit 以保留 shopify 的交互输入（如登录确认）；
 * 双击启动的 Windows GUI Electron 无控制台、stdin 句柄无效，inherit 会让 spawn 直接 EBADF/EINVAL 失败，故降级 ignore。
 */
const STDIN = process.stdin?.isTTY ? 'inherit' : 'ignore'

/**
 * 扫 process.env.PATH 各目录，返回第一个存在且可执行的 node（同步、即时）。
 * dev 下 Electron 从终端继承的 PATH 已含 nvm，命中即用；GUI 直启的 Electron 的 PATH 常被裁剪，
 * 此处查不到时再由 resolveShopifyNode 走登录 shell 兜底。
 */
function nodeFromPath() {
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    // 跳过 Microsoft Store 的 App Execution Alias 目录：里面的 node.exe 是 0 字节 stub，存在但执行即失败
    if (isWin && /\\microsoft\\windowsapps[\\/]?$/i.test(dir)) continue
    const full = join(dir, exe)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      /* 继续找下一个目录 */
    }
  }
  return null
}

/**
 * 解析跑 @shopify/cli 的 node 解释器路径。
 * CLI 里 process.execPath 本就是系统 node；Electron 下它却是 Electron 自带的偏旧 Node——
 * 新版 @shopify/cli 的 bin/run.js 顶部静态 `import { enableCompileCache } from 'node:module'`，
 * 该命名导出在旧 Node 上不存在，会在 import 阶段直接 SyntaxError，故 Electron 下必须改用系统 node：
 * 先扫 PATH（dev 下命中即用）；查不到再用登录+交互 shell 还原用户 PATH（含 nvm/homebrew）后取 node；
 * 再兜底常见安装路径；仍找不到才退回 process.execPath（可能仍失败，但至少给个可读错误）。
 * 结果按进程缓存，仅首次解析有一次（最多）登录 shell 的同步开销。
 * @returns {Promise<string>}
 */
function resolveShopifyNode() {
  if (!isElectron) return Promise.resolve(process.execPath)
  if (_systemNode) return Promise.resolve(_systemNode)
  const fast = nodeFromPath()
  if (fast) {
    _systemNode = fast
    return Promise.resolve(fast)
  }
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    // Windows 必须用 cmd（ComSpec）且不能先看 SHELL：Git Bash 里启动的进程带着 SHELL=/usr/bin/bash
    // （POSIX 路径 + bash 语法），spawn 它再传 cmd 的 /c 会直接 ENOENT，node 解析链就此断裂。
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh'
    const flag = isWin ? '/c' : '-lic' // -l 登录 + -i 交互：source .zshrc/.zprofile 等以还原 nvm/homebrew
    const script = isWin ? 'where node' : 'command -v node'
    const child = spawn(shell, [flag, script], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })
    let out = ''
    let settled = false
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    const finish = () => {
      if (settled) return
      settled = true
      // 过滤不可用的命中：.cmd/.bat shim（Node 18.20+ 禁止无 shell 直接 spawn，会 EINVAL）与
      // Microsoft Store 的 0 字节 App Execution Alias；取首个 = PATH 优先级最高的 node。
      const picked = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => (isWin ? l.toLowerCase().endsWith('.exe') && !/\\microsoft\\windowsapps\\/i.test(l) : true))
      if (picked && existsSync(picked)) {
        _systemNode = picked
        return resolve(picked)
      }
      // 兜底常见安装路径：macOS homebrew / Windows Program Files\nodejs / Linux
      const candidates = isWin
        ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((r) => join(r, 'nodejs', 'node.exe'))
        : ['/opt/homebrew/bin/node', '/usr/local/bin/node']
      for (const cand of candidates) {
        if (existsSync(cand)) {
          _systemNode = cand
          return resolve(cand)
        }
      }
      // 兜底：退回 Electron 自带 Node（跑新版 @shopify/cli 大概率因 enableCompileCache 失败）。
      // 标记 fallback 供桌面端启动自检提示「请安装 Node.js」；同时缓存，避免每条命令重跑 shell 探测。
      _systemNode = process.execPath
      _nodeIsFallback = true
      resolve(process.execPath)
    }
    child.on('close', finish)
    child.on('error', finish)
  })
}

/**
 * 查询跑 @shopify/cli 的 node 解释器状态（桌面端启动自检 / 「关于」展示用）。
 * @returns {Promise<{ node: string, fallback: boolean }>} fallback=true 表示没找到系统 Node、
 *   只能退回 Electron 内置的偏旧 Node（跑新版 @shopify/cli 会失败），应提示用户安装 Node.js ≥22。
 */
export async function getShopifyNodeInfo() {
  const node = await resolveShopifyNode()
  return { node, fallback: isElectron && _nodeIsFallback }
}

/**
 * 用子进程跑 @shopify/cli，shopify 自身的彩色输出原样透传。
 * headless：进程错误时静默返回退出码（不再打印，由调用方按退出码处理）。
 * Electron 下用系统 node 作解释器（见 resolveShopifyNode），避开 Electron 偏旧内置 Node 跑不了新版 CLI 的问题。
 * （环境参数请用 config.js 的 resolveEnvironment(args) 单独获取。）
 * @param {string[]} args 透传给 shopify 的参数（原样，不做改动）
 * @param {{ cwd?: string }} [opts] cwd 不传则用 process.cwd()（CLI 依赖此默认）
 * @returns {Promise<number>} 进程退出码
 */
export async function runShopify(args, { cwd } = {}) {
  const node = await resolveShopifyNode()
  return new Promise((resolve) => {
    const child = spawn(node, [SHOPIFY_BIN, ...args], {
      stdio: [STDIN, 'inherit', 'inherit'],
      // 只有真终端才强制开色：重定向到文件/管道（shop xxx > log.txt）时保留原始文本，不混入 ESC 序列
      env: { ...process.env, FORCE_COLOR: process.stdout?.isTTY ? '1' : '0', INIT_CWD: cwd || process.cwd() },
      ...(cwd ? { cwd } : {}),
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
 * @param {{ cwd?: string }} [opts] cwd 不传则用 process.cwd()
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function captureShopify(args, { cwd } = {}) {
  const node = await resolveShopifyNode()
  return new Promise((resolve) => {
    const child = spawn(node, [SHOPIFY_BIN, ...args], {
      stdio: [STDIN, 'pipe', 'pipe'],
      // INIT_CWD 必须同步到 cwd：shopify 的 cwd() 是 process.env.INIT_CWD || process.cwd()，
      // Electron 主进程的 INIT_CWD 是 dev 启动目录（项目根），会让 shopify 拿错目录去找 toml。
      env: { ...process.env, FORCE_COLOR: '0', INIT_CWD: cwd || process.cwd() },
      ...(cwd ? { cwd } : {}),
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
    // spawn 失败（node 缺失/不可执行）时把原因写进 stderr，让 GUI / CLI 至少能看到可读错误而非只有退出码 1
    child.on('error', (err) =>
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\nshopify 子进程启动失败（${node}）：${err.message}`,
      }),
    )
  })
}

/**
 * 跑 @shopify/cli 并把输出**按 chunk 流式回调**（供 GUI 实时显示）。
 * 介于 runShopify（inherit，GUI 拿不到字节）与 captureShopify（全量 buffer，不适合 dev server 长连接）之间。
 * @param {string[]} args 透传给 shopify 的参数
 * @param {{ onData?: (chunk: string, stream: 'stdout'|'stderr') => void, env?: Record<string,string>, cwd?: string }} [opts]
 *   cwd 不传则用 process.cwd()（GUI 跑指定仓库时必传）
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, done: Promise<number> }>}
 *   child 可用于提前 kill；done resolve 退出码
 */
export async function streamShopify(args, { onData, env, cwd } = {}) {
  const node = await resolveShopifyNode()
  const child = spawn(node, [SHOPIFY_BIN, ...args], {
    stdio: [STDIN, 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1', INIT_CWD: cwd || process.cwd(), ...env },
    ...(cwd ? { cwd } : {}),
  })
  child.stdout.on('data', (d) => onData?.(d.toString(), 'stdout'))
  child.stderr.on('data', (d) => onData?.(d.toString(), 'stderr'))

  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      // 与 captureShopify 一致：spawn 失败时把可读原因回灌到 stderr 流，GUI 日志能看到
      onData?.(`shopify 子进程启动失败（${node}）：${err.message}\n`, 'stderr')
      resolve(1)
    })
  })
  return { child, done }
}
