/**
 * 本机编辑器检测、打开与终端执行（跨平台：macOS / Windows / Linux）。
 *
 * 检测：维护一张「已知编辑器表」，每平台给出探测候选——
 *   macOS：/Applications 或 ~/Applications 下的 .app bundle，或 CLI 命令（which）；
 *   Windows：常见安装根（LOCALAPPDATA / PROGRAMFILES）下的 .exe，或 CLI 命令（where）；
 *   Linux：CLI 命令（which）。
 * 打开：优先用「确属本编辑器」的 CLI 命令打开目录（VS Code 系 CLI 能在已开窗口打开目录，
 *       且按 realpath 校验归属，避免被 Trae / Cursor 的同名命令劫持）；归属不明则用 app bundle / .exe 兜底。
 * 终端：仅 macOS 对 VS Code 系（含 Cursor / Trae）自动注入其集成终端；其余一律开系统终端跑命令。
 */
import { existsSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { clipboard } from 'electron'

const MAC = process.platform === 'darwin'
const WIN = process.platform === 'win32'

// macOS 应用所在目录
const MAC_APP_DIRS = ['/Applications', join(homedir(), 'Applications')]

/** Windows 常见安装根（按优先级，过滤掉未设置的环境变量）。 */
function winRoots() {
  const env = process.env
  return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean)
}

/**
 * 已知编辑器表。每平台给探测候选：
 * - mac.apps：.app bundle 名；mac.cmd：CLI 命令
 * - win.rels：相对 Windows 安装根的 .exe 路径；win.cmd：CLI 命令（含 .cmd/.exe）
 * - linux.cmd：CLI 命令
 */
const EDITORS = [
  { id: 'vscode', name: 'Visual Studio Code',
    mac: { apps: ['Visual Studio Code.app'], cmd: 'code' },
    win: { cmd: 'code.cmd', rels: [join('Programs', 'Microsoft VS Code', 'Code.exe')] },
    linux: { cmd: 'code' } },
  { id: 'codex', name: 'Codex',
    // OpenAI Codex 桌面应用（独立应用，非 VS Code 系）。codex CLI 是 agent，不用来打开目录，故 cmd 留空、只用 app 本体打开。
    mac: { apps: ['Codex.app'], cmd: null },
    win: { cmd: null, rels: [join('Programs', 'codex', 'Codex.exe'), join('Programs', 'Codex', 'Codex.exe')] },
    linux: { cmd: null } },
  { id: 'cursor', name: 'Cursor',
    mac: { apps: ['Cursor.app'], cmd: 'cursor' },
    win: { cmd: 'cursor.cmd', rels: [join('Programs', 'cursor', 'Cursor.exe'), join('Programs', 'Cursor', 'Cursor.exe')] },
    linux: { cmd: 'cursor' } },
  { id: 'trae', name: 'Trae',
    mac: { apps: ['Trae.app'], cmd: 'trae' },
    win: { cmd: 'trae.cmd', rels: [join('Programs', 'Trae', 'Trae.exe')] },
    linux: { cmd: 'trae' } },
  { id: 'trae-cn', name: 'Trae CN',
    // Trae CN 的 shell 命令名是 trae-cn（不是 trae），和 VS Code 的 code 一样能 `trae-cn <dir>` 打开目录
    mac: { apps: ['Trae CN.app'], cmd: 'trae-cn' },
    win: { cmd: 'trae.cmd', rels: [join('Programs', 'Trae CN', 'Trae.exe')] },
    linux: { cmd: 'trae-cn' } },
  { id: 'webstorm', name: 'WebStorm',
    mac: { apps: ['WebStorm.app'], cmd: 'webstorm' },
    win: { cmd: 'webstorm.exe', rels: [] },
    linux: { cmd: 'webstorm' } },
  { id: 'phpstorm', name: 'PhpStorm',
    mac: { apps: ['PhpStorm.app'], cmd: 'phpstorm' },
    win: { cmd: 'phpstorm.exe', rels: [] },
    linux: { cmd: 'phpstorm' } },
  { id: 'idea', name: 'IntelliJ IDEA',
    mac: { apps: ['IntelliJ IDEA.app'], cmd: 'idea' },
    win: { cmd: 'idea.exe', rels: [] },
    linux: { cmd: 'idea' } },
  { id: 'sublime', name: 'Sublime Text',
    mac: { apps: ['Sublime Text.app'], cmd: 'subl' },
    win: { cmd: 'subl.exe', rels: [join('Sublime Text 3', 'subl.exe'), join('Sublime Text 4', 'subl.exe')] },
    linux: { cmd: 'subl' } },
  { id: 'zed', name: 'Zed',
    mac: { apps: ['Zed.app'], cmd: 'zeditor' },
    win: { cmd: 'zeditor.exe', rels: [] },
    linux: { cmd: 'zeditor' } },
]

/** 命令是否在 PATH 中：macOS/Linux 用 which，Windows 用 where。 */
function cmdExists(cmd) {
  const tool = WIN ? 'where' : 'which'
  try {
    return spawnSync(tool, [cmd], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** 取 cmd 的可执行路径（which/where 结果首行），不存在返回 null。 */
function resolveCmdPath(cmd) {
  const tool = WIN ? 'where' : 'which'
  try {
    const r = spawnSync(tool, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (r.status === 0) {
      const line = r.stdout.split(/\r?\n/)[0].trim()
      if (line) return line
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * PATH 里的 cmd 是否「真属于」给定编辑器：跟随符号链接到真实文件后，路径是否落在该编辑器
 * 的 app bundle 内。用于防止 Trae / Cursor 的 code / cursor 命令劫持「vscode」等选择——
 * 它们与 VS Code 同源，PATH 里同名命令实际指向自己。
 */
function macCmdBelongsTo(cmd, apps) {
  const p = resolveCmdPath(cmd)
  if (!p) return false
  let real
  try {
    real = realpathSync(p)
  } catch {
    real = p
  }
  return apps.some((a) => real.includes(`/${a}/`))
}

function macDetected(e) {
  return e.mac.apps.some((a) => MAC_APP_DIRS.some((d) => existsSync(join(d, a)))) || (e.mac.cmd ? cmdExists(e.mac.cmd) : false)
}
function winDetected(e) {
  return e.win.rels.some((rel) => winRoots().some((r) => existsSync(join(r, rel)))) || (e.win.cmd ? cmdExists(e.win.cmd) : false)
}
function linuxDetected(e) {
  return e.linux.cmd ? cmdExists(e.linux.cmd) : false
}

/**
 * 列出本机已装的编辑器。
 * @returns {{ id: string, name: string }[]}
 */
export function listEditors() {
  const detected = MAC ? macDetected : WIN ? winDetected : linuxDetected
  return EDITORS.filter(detected).map((e) => ({ id: e.id, name: e.name }))
}

/** 取 Windows 上编辑器 .exe 的首个存在路径（按 winRoots × rels 顺序）。 */
function winExePath(e) {
  for (const rel of e.win.rels) {
    for (const r of winRoots()) {
      const p = join(r, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * 用指定编辑器打开目录（detached，主进程不等待）。
 * @param {string} dir 要打开的目录
 * @param {string} id 编辑器 id
 */
export function openInEditor(dir, id) {
  const e = EDITORS.find((x) => x.id === id)
  if (!e) throw new Error(`未知编辑器：${id}`)
  if (MAC) openMac(e, dir)
  else if (WIN) openWin(e, dir)
  else openLinux(e, dir)
}

function openMac(e, dir) {
  // 优先用「确属本编辑器」的 CLI 命令打开目录：VS Code 系的 CLI（code / cursor / trae-cn）
  // 能把目录在已开窗口里打开；而 open -a 对部分编辑器（如 Trae CN）只激活、不打开目录。
  // 但必须校验 CLI 归属——Trae / Cursor 会把 code / cursor 命令指向自己，劫持「vscode」：
  // 只有 realpath 落在本编辑器 bundle 内的 cmd 才可信。
  if (e.mac.cmd && macCmdBelongsTo(e.mac.cmd, e.mac.apps)) {
    spawn(e.mac.cmd, [dir], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  // 归属不明 / 无 CLI：用 app bundle 兜底，至少打开正确的编辑器本体
  const app = e.mac.apps.find((a) => MAC_APP_DIRS.some((d) => existsSync(join(d, a))))
  spawn('open', ['-a', app || e.name, dir], { detached: true, stdio: 'ignore' }).unref()
}

function openWin(e, dir) {
  // 优先用 .exe 显式路径（同样避免 PATH 里 code.cmd 被其它 VS Code 系编辑器劫持），
  // 其次 CLI 命令，最后用资源管理器兜底
  const exe = winExePath(e)
  if (exe) {
    spawn(exe, [dir], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (e.win.cmd && cmdExists(e.win.cmd)) {
    spawn(e.win.cmd, [dir], { detached: true, stdio: 'ignore', shell: true }).unref()
    return
  }
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
}

function openLinux(e, dir) {
  if (cmdExists(e.linux.cmd)) {
    spawn(e.linux.cmd, [dir], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
}

/* ---------------- 在终端执行命令 ---------------- */

/** 支持在其集成终端自动注入命令的编辑器（VS Code 系，新建终端快捷键一致；仅 macOS 注入）。 */
const TERMINAL_EDITORS = new Set(['vscode', 'cursor', 'trae', 'trae-cn'])

/** AppleScript 字符串转义（双引号 / 反斜杠）。 */
function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** app 是否在运行（AppleScript 字典查询，用于等待冷启动的编辑器就绪）。 */
function isAppRunning(appName) {
  try {
    const r = execFileSync(
      'osascript',
      ['-e', `application "${escapeAppleScript(appName)}" is running`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return String(r).trim() === 'true'
  } catch {
    return false
  }
}

/** 轮询等待 app 就绪（冷启动可能数秒~十几秒），超时返回 false。 */
function waitAppRunning(appName, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isAppRunning(appName)) return true
    spawnSync('sleep', ['0.3'], { stdio: 'ignore' })
  }
  return false
}

/**
 * 在 VS Code / Cursor / Trae 集成终端执行命令：activate → 新建终端(Ctrl+Shift+`) → 粘贴 → 回车。
 * 命令先写入剪贴板再粘贴，避免长命令 keystroke 丢字。需「辅助功能」权限（首次会弹授权）。
 */
function injectEditorTerminal(editorId, command) {
  const e = EDITORS.find((x) => x.id === editorId)
  const appName = e?.name || editorId
  // 等编辑器进程就绪再注入：openInEditor 刚把它拉起，首次冷启动可能数秒~十几秒，
  // 太早 activate / 发快捷键会被丢弃，表现为「命令没填进去」。
  waitAppRunning(appName, 15000)
  clipboard.writeText(command)
  const script = [
    `tell application "${escapeAppleScript(appName)}" to activate`,
    'delay 0.8',
    'tell application "System Events"',
    '  keystroke "`" using {control down, shift down}',
    '  delay 0.5',
    '  keystroke "v" using command down',
    '  delay 0.2',
    '  key code 36',
    'end tell',
  ].join('\n')
  execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 6000 })
}

/** 用系统终端执行命令（跨平台）。 */
function openSystemTerminal(command) {
  if (MAC) openMacTerminal(command)
  else if (WIN) openWinTerminal(command)
  else openLinuxTerminal(command)
}

/** macOS：Terminal.app 新窗口（AppleScript 字典，无需辅助功能权限）。 */
function openMacTerminal(command) {
  const script = `tell application "Terminal"
  do script "${escapeAppleScript(command)}"
  activate
end tell`
  spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref()
}

/**
 * Windows：把命令写入临时 .bat，用 `start cmd /k` 开独立 cmd 窗口执行（bat 自删）。
 * 走 .bat 是为规避命令行里大量双引号 / && 的转义地狱。
 */
function openWinTerminal(command) {
  const bat = join(tmpdir(), `shopify-cli-run-${Date.now()}.bat`)
  writeFileSync(bat, `${command}\r\ndel "%~f0"\r\n`)
  spawn('cmd.exe', ['/c', 'start', '"Shopify"', 'cmd.exe', '/k', `"${bat}"`], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

/** Linux：尝试常见终端模拟器，在其新窗口用 bash 跑命令后保留 shell。 */
function openLinuxTerminal(command) {
  const holders = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']
  for (const term of holders) {
    if (!cmdExists(term)) continue
    const args = ['gnome-terminal', 'xfce4-terminal', 'xterm'].includes(term)
      ? ['-e', 'bash', '-c', `${command}; exec bash`]
      : ['--', 'bash', '-c', `${command}; exec bash`]
    spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
    return
  }
}

/**
 * 在「编辑器集成终端」执行命令；仅 macOS 对 VS Code 系编辑器自动注入，
 * 其余平台 / 不支持的编辑器 / 注入失败，一律回退到系统终端。
 * @param {{ command: string, editorId?: string }} opts command 已含 cd 到仓库目录
 * @returns {'editor' | 'system'} 实际执行位置
 */
export function runInTerminal({ command, editorId }) {
  if (MAC && editorId && TERMINAL_EDITORS.has(editorId)) {
    try {
      injectEditorTerminal(editorId, command)
      return 'editor'
    } catch {
      /* 权限不足 / 快捷键被改 / 超时 → 回退系统终端 */
    }
  }
  openSystemTerminal(command)
  return 'system'
}
