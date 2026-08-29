import { app, BrowserWindow, Menu, protocol, shell } from 'electron'
import { join } from 'node:path'
import { registerShopsIpc } from './ipc/shops.js'
import { registerLinksIpc } from './ipc/links.js'
import { registerConfigIpc } from './ipc/config.js'
import { registerDialogIpc } from './ipc/dialog.js'
import { registerGitIpc } from './ipc/git.js'
import { registerSettingsIpc } from './ipc/settings.js'
import { registerReposIpc } from './ipc/repos.js'
import { registerShellIpc } from './ipc/shell.js'
import { registerContactsIpc } from './ipc/contacts.js'
import { registerDingtalkIpc } from './ipc/dingtalk.js'
import { registerTapdIpc } from './ipc/tapd.js'
import { registerSystemIpc } from './ipc/system.js'
import { registerCrawlerIpc } from './ipc/crawler.js'
import { dlog, dmem } from './debuglog.js'

// macOS Dock 标签、菜单栏应用名都取自 app.getName()：dev 下裸 electron 进程默认名是 "Electron"，
// 打包后由 Info.plist 的 productName 改回 "Shopify Toolbox"。dev 下显式 setName 让两者一致；
// 副作用：userData 目录从 Application Support/Electron 变为 Shopify Toolbox（与打包态一致）。
app.setName('Shopify Toolbox')

/* -------- 闪退排查：进程级异常钩子（日志落盘见 debuglog.js，崩溃后仍可查） -------- */

dlog('app', `主进程启动：version=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform}`)

// 未捕获异常：记录后不退出（保留现场让用户截图/反馈；原生崩溃/被系统强杀仍会闪退，
// 那类情况日志里不会有任何收尾行，本身就是判据）
process.on('uncaughtException', (err) => {
  dmem('app', '未捕获异常时 ')
  dlog('app', `未捕获异常：${err.stack || `${err.name}: ${err.message}`}`)
})

process.on('unhandledRejection', (reason) => {
  dlog('app', `未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`)
})

// 渲染进程崩溃/被杀（reason=oom 说明渲染层内存爆了；clean-exit 则是页面自己退出）
app.on('render-process-gone', (_evt, webContents, details) => {
  let url = ''
  try {
    url = webContents.getURL()
  } catch {
    /* 已销毁 */
  }
  dlog('app', `渲染进程异常退出：url=${url} reason=${details.reason} exitCode=${details.exitCode}`)
})

// GPU/网络服务等子进程退出（Chromium 内部崩溃也可能连带整个应用闪退）
app.on('child-process-gone', (_evt, details) => {
  dlog('app', `子进程异常退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})

app.on('before-quit', () => {
  dlog('app', '应用正常退出（before-quit）')
})

// TAPD 富文本图片走自定义协议由主进程代理（见 ipc/tapd.js）。
// 必须在 app ready 前注册为特权 scheme，<img> 才能像 https 一样加载（standard 解析 host、stream 支持流式）。
protocol.registerSchemesAsPrivileged([
  { scheme: 'tapd-img', privileges: { standard: true, secure: true, stream: true } },
])

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: `Shopify 工具箱 v${app.getVersion()}`,
    // 开发态窗口图标；打包后由 .icns/.ico 应用图标接管
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 富文本（工单详情抽屉等）里 Ctrl/Cmd+点击链接会被 Chromium 当「新标签打开」走
  // window.open，不拦会弹出裸 Electron 窗口：拦下转系统浏览器（普通点击由渲染层处理）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // dev：electron-vite 注入 ELECTRON_RENDERER_URL；prod：加载打包后的 index.html
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Windows 用户双击 exe 多开很常见：两个实例并发读-改-写 settings.json / projects.json
  // 会互相覆盖（后写者冲掉先写者），故第二实例启动时只聚焦已有窗口。
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // 基础菜单：不设置时 Windows 会显示英文默认菜单（含开发者工具等无关项），
  // macOS 则完全没有菜单、复制粘贴快捷键失效；role 系菜单自带跨平台正确行为。
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
    ]),
  )

  registerShopsIpc()
  registerLinksIpc()
  registerConfigIpc()
  registerDialogIpc()
  registerGitIpc()
  registerSettingsIpc()
  registerReposIpc()
  registerShellIpc()
  registerContactsIpc()
  registerDingtalkIpc()
  registerTapdIpc()
  registerSystemIpc()
  registerCrawlerIpc()
  createWindow()

  // dev 模式下设置 Dock 图标：macOS 会忽略 BrowserWindow 的 icon 选项，
  // 裸 electron 进程的 Dock 默认是 Electron logo，必须用 dock.setIcon 覆盖。
  // （打包态由 .icns/.ico 应用图标接管，无需此步。）
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(join(__dirname, '../../build/icon.png'))
    } catch {
      /* dev 下图标缺失不应阻塞启动 */
    }
  }

  // 客户端更新统一引导到 GitHub Release 页面手动下载，不再由 electron-updater 自动检测/下载。

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
