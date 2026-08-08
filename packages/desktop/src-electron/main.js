import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
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
import { registerSystemIpc } from './ipc/system.js'

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

  // dev：electron-vite 注入 ELECTRON_RENDERER_URL；prod：加载打包后的 index.html
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
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
  registerSystemIpc()
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

  // 自动更新：仅打包后检查（dev 下无 app-update.yml 会报错）
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
