import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/** 把消息推给渲染层（取首个窗口；与 repos.js 同模式）。 */
const send = (channel, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)

/**
 * 把任意 releaseNotes 归一化为纯文本字符串。GitHub provider 下通常是 release body（markdown 字符串），
 * 但 electron-updater 也可能给数组（[{version, note}]）；统一拍平成文本，前端按纯文本展示（不渲染 markdown）。
 */
function normalizeNotes(notes) {
  if (!notes) return ''
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n?.note || ''))
      .join('\n')
      .trim()
  }
  return String(notes).trim()
}

/**
 * 用 electron-updater 检查/下载/安装 GitHub release 新版本。检查结果与下载进度经 IPC 事件
 * （updater:*）推给渲染层，由更新弹窗驱动 UI。
 * dev 下无 app-update.yml，checkForUpdates 会抛错——checkForUpdates 按 isPackaged 提前拦截。
 * @returns {Promise<{ ok: true } | { ok: false, reason?: 'dev', error?: string }>}
 */
export async function checkForUpdates() {
  if (!app.isPackaged) return { ok: false, reason: 'dev' }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * updater 域 IPC：检查/下载/安装，外加把 autoUpdater 事件转发给渲染层。
 * autoDownload=false：不静默下载，等用户在弹窗点「立即更新」才下载（避免后台偷跑流量）。
 * autoInstallOnAppQuit=true：下载完成后退出 app 时自动安装（用户点「稍后」也能在下次退出时生效）。
 */
export function registerUpdaterIpc() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    send('updater:updateAvailable', {
      version: info?.version,
      releaseName: info?.releaseName,
      releaseNotes: normalizeNotes(info?.releaseNotes),
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    send('updater:updateNotAvailable', { version: info?.version })
  })
  autoUpdater.on('download-progress', (p) => {
    send('updater:progress', { percent: p?.percent ?? 0 })
  })
  autoUpdater.on('update-downloaded', (info) => {
    send('updater:downloaded', { version: info?.version })
  })
  autoUpdater.on('error', (err) => {
    send('updater:error', { message: err?.message || String(err) })
  })

  ipcMain.handle('updater:check', () => checkForUpdates())

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // 退出并安装：quitAndInstall 会触发 app.quit()，重启后装入已下载的新版本
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall()
    return { ok: true }
  })
}
