import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'node:path'
import { registerShopsIpc } from './ipc/shops.js'
import { registerLinksIpc } from './ipc/links.js'
import { registerConfigIpc } from './ipc/config.js'
import { registerDialogIpc } from './ipc/dialog.js'

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Shopify 工具箱',
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
  createWindow()

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
