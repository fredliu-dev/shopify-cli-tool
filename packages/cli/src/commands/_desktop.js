/**
 * 桌面应用（Shopify Toolbox）相关的纯逻辑：定位/启动已装应用、按平台选 Release 资产、流式下载。
 * 供 `shop ui` 与 `shop download` 共用，命令文件保持轻量。
 * 只用 Node 内置模块 + 全局 fetch（Node ≥22），不引新依赖。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'

/** 桌面应用产品名（与 electron-builder.yml 的 productName 一致）。 */
export const APP_NAME = 'Shopify Toolbox'
/** GitHub Release 来源（与 electron-builder.yml 的 publish 一致）。 */
export const REPO = { owner: 'fredliu-dev', name: 'shopify-cli-tool' }
const RELEASES_API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/latest`

/** 归一化当前系统：os = darwin | win32 | linux；arch = arm64 | x64。 */
export function detectPlatform() {
  return { os: process.platform, arch: process.arch }
}

/* ---------------- 定位已安装应用 ---------------- */

/** macOS：在常见安装位置找 `<APP_NAME>.app`；找不到返回 null。 */
function findMacApp() {
  const app = `${APP_NAME}.app`
  const dirs = ['/Applications', join(homedir(), 'Applications')]
  for (const d of dirs) {
    const p = join(d, app)
    if (existsSync(p)) return p
  }
  return null
}

/** Windows：NSIS 默认装到 %LOCALAPPDATA%\<APP_NAME>；Program Files 兜底。 */
function findWinApp() {
  const exe = `${APP_NAME}.exe`
  const candidates = []
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, APP_NAME, exe))
  if (process.env['ProgramFiles']) candidates.push(join(process.env['ProgramFiles'], APP_NAME, exe))
  if (process.env['ProgramFiles(x86)']) candidates.push(join(process.env['ProgramFiles(x86)'], APP_NAME, exe))
  return candidates.find(existsSync) || null
}

/** 定位已安装的桌面应用；不支持的平台或未安装返回 null。 */
export function findApp() {
  if (process.platform === 'darwin') return findMacApp()
  if (process.platform === 'win32') return findWinApp()
  return null
}

/* ---------------- 启动 / 打开 ---------------- */

/**
 * 启动已安装的桌面应用（detach 后立即返回，不阻塞 CLI）。
 * @returns {{ ok: true, path: string } | { ok: false }}
 */
export function launchApp() {
  const p = findApp()
  if (!p) return { ok: false }
  if (process.platform === 'darwin') {
    spawn('open', [p], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref()
  } else {
    return { ok: false }
  }
  return { ok: true, path: p }
}

/** 用系统默认方式打开文件（macOS `open` / Windows `start`）；用于下载后打开安装包。 */
export function openFile(p) {
  if (process.platform === 'darwin') {
    spawn('open', [p], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref()
  }
}

/* ---------------- Release 资产选取 + 下载 ---------------- */

/**
 * 根据平台返回「目标安装包」的资产匹配函数（asset.name 小写匹配）。
 * mac：取 .dmg 且含 arch（如 -arm64.dmg），避开供 updater 用的 zip；
 * win：取 nsis 的 .exe（Setup，默认名不含 arch）；
 * 其它平台返回 null。
 */
function desiredAssetMatcher({ os, arch }) {
  if (os === 'darwin') {
    return (name) => name.endsWith('.dmg') && name.includes(arch)
  }
  if (os === 'win32') {
    return (name) => name.endsWith('.exe')
  }
  return null
}

/**
 * 拉取最新 Release（GitHub API）。需带 User-Agent，否则 403。
 * @returns {Promise<object | null>} 404（还没发布）返回 null；其它错误抛错
 */
export async function fetchLatestRelease() {
  const res = await fetch(RELEASES_API, {
    headers: { 'User-Agent': 'shopify-cli-tool', Accept: 'application/vnd.github+json' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub 接口返回 HTTP ${res.status}`)
  return res.json()
}

/** 从 Release 里挑出适配当前平台的安装包资产；找不到返回 null。 */
export function pickAsset(release, pf) {
  const match = desiredAssetMatcher(pf)
  if (!match || !release) return null
  return (release.assets || []).find((a) => match(String(a.name).toLowerCase())) || null
}

/**
 * 流式下载资产到 dest，回调进度。
 * @param {string} url 资产 browser_download_url（GitHub 会 302 到 CDN，fetch 自动跟随）
 * @param {string} dest 本地保存路径
 * @param {({ loaded: number, total: number }) => void} [onProgress]
 * @returns {Promise<number>} 已写字节数
 */
export async function downloadAsset(url, dest, onProgress) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  if (!res.body) throw new Error('下载响应无内容流')
  const total = Number(res.headers.get('content-length')) || 0
  const ws = createWriteStream(dest)
  const rs = Readable.fromWeb(res.body)
  let loaded = 0
  rs.on('data', (chunk) => {
    loaded += chunk.length
    onProgress?.({ loaded, total })
  })
  await new Promise((resolve, reject) => {
    rs.pipe(ws).on('error', reject).on('finish', resolve)
  })
  return loaded
}
