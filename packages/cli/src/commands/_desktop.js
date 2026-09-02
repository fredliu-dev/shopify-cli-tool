/**
 * 桌面应用（Shopify Toolbox）相关的纯逻辑：定位/启动已装应用、按平台选 Release 资产、流式下载。
 * 供 `shop ui` 与 `shop download` 共用，命令文件保持轻量。
 * 只用 Node 内置模块 + 全局 fetch（Node ≥22），不引新依赖。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

/** Windows：NSIS 默认（oneClick、perMachine=false）装到 %LOCALAPPDATA%\Programs\<APP_NAME>；其余位置兜底。 */
function findWinApp() {
  const exe = `${APP_NAME}.exe`
  const candidates = []
  if (process.env.LOCALAPPDATA) {
    // electron-builder NSIS 的默认安装目录带 Programs 这一层，必须放首位
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', APP_NAME, exe))
    candidates.push(join(process.env.LOCALAPPDATA, APP_NAME, exe))
  }
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
    // 直接 spawn exe 路径（libuv 负责加引号），不绕 cmd start——后者会对 %、& 等元字符二次解释
    spawn(p, [], { detached: true, stdio: 'ignore' }).unref()
  } else {
    return { ok: false }
  }
  return { ok: true, path: p }
}

/** 用系统默认方式打开文件（macOS `open` / Windows 资源管理器）；用于下载后打开安装包。 */
export function openFile(p) {
  if (process.platform === 'darwin') {
    spawn('open', [p], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'win32') {
    // explorer.exe 打开文件等同双击，且不会像 cmd start 那样解释路径里的元字符
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref()
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
 * 自动重试（指数退避）+ 连接超时——api.github.com 时通时断，单次请求失败不应直接放弃。
 * @returns {Promise<object | null>} 404（还没发布）返回 null；重试耗尽后抛错
 */
export async function fetchLatestRelease() {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { 'User-Agent': 'shopify-cli-tool', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GitHub 接口返回 HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr
}

/** 从 Release 里挑出适配当前平台的安装包资产；找不到返回 null。 */
export function pickAsset(release, pf) {
  const match = desiredAssetMatcher(pf)
  if (!match || !release) return null
  return (release.assets || []).find((a) => match(String(a.name).toLowerCase())) || null
}

/** 下载的 HTTP 状态类错误（403/404 等）——重试无意义，需与网络类错误区分开。 */
class HttpError extends Error {}

/** 下载写盘一律先写 <dest>.part，全部校验通过后再原子改名——半截文件永不冒充成品。 */
const partFileOf = (dest) => `${dest}.part`

/**
 * 单次下载尝试：支持 Range 续传（.part 已有字节则从断点接着下）。
 * 用「无数据心跳」看门狗代替整体超时——大文件慢速下载不该被掐断，
 * 只有连接挂起 / 中途断流（30 秒没有任何新数据）才中止本次尝试。
 */
async function downloadOnce(url, dest, onProgress) {
  const partFile = partFileOf(dest)
  const offset = existsSync(partFile) ? statSync(partFile).size : 0
  const headers = { 'User-Agent': 'shopify-cli-tool' }
  if (offset > 0) headers.Range = `bytes=${offset}-`

  // 不传 signal 给 fetch 本体，改用下面可续期的看门狗（AbortSignal.timeout 会连同响应体一起掐）
  const ac = new AbortController()
  let watchdog
  const arm = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => ac.abort(new Error('下载超时：30 秒没有收到新数据')), 30_000)
  }
  arm()

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal })
    if (!res.ok) {
      rmSync(partFile, { force: true }) // 状态类错误续传无意义，清掉 .part 让下次全量重来
      throw new HttpError(`下载失败：HTTP ${res.status}`)
    }
    if (!res.body) throw new Error('下载响应无内容流')

    // 服务器不支持 Range（返回 200 全量）→ 丢弃 .part 从头下
    const resumed = offset > 0 && res.status === 206
    const base = resumed ? offset : 0
    if (!resumed && offset > 0) {
      rmSync(partFile, { force: true })
      return downloadOnce(url, dest, onProgress)
    }
    const total = base + (Number(res.headers.get('content-length')) || 0)

    // .part 已齐（上次下完但没来得及改名）→ 直接收尾，不重复下载
    if (total > 0 && base >= total) {
      renameSync(partFile, dest)
      return base
    }

    // 建流放在 fetch 之后：避免响应未就绪时写流先报错却没人监听
    const ws = createWriteStream(partFile, { flags: resumed ? 'a' : 'w' })
    const rs = Readable.fromWeb(res.body)
    let loaded = base
    rs.on('data', (chunk) => {
      loaded += chunk.length
      arm() // 有数据就续命
      onProgress?.({ loaded, total })
    })
    await pipeline(rs, ws) // 任一侧出错/中止都会 reject，两侧流都会被清掉
    // 完整性校验：CDN 中途掐断时流可能「正常」结束，长度对不上必须重试
    if (total > 0 && loaded !== total) {
      throw new Error(`下载不完整：${loaded}/${total} 字节`)
    }
    renameSync(partFile, dest)
    return loaded
  } finally {
    clearTimeout(watchdog)
  }
}

/**
 * 流式下载资产到 dest，回调进度。带自动重试（网络类错误最多 3 次）+ 断点续传
 * （.part 跨尝试甚至跨运行保留，下次从断点接着下）+ 长度完整性校验。
 * @param {string} url 资产 browser_download_url（GitHub 会 302 到 CDN，fetch 自动跟随）
 * @param {string} dest 本地保存路径
 * @param {({ loaded: number, total: number }) => void} [onProgress]
 * @returns {Promise<number>} 已写字节数
 */
export async function downloadAsset(url, dest, onProgress) {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await downloadOnce(url, dest, onProgress)
    } catch (err) {
      // HTTP 状态类错误重试无意义；abort（看门狗掐断）等网络类错误才值得再试
      if (err instanceof HttpError) throw err
      lastErr = err
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  // 重试耗尽：保留 .part 供下次运行续传，但把「不完整」类错误说清楚
  throw lastErr
}
