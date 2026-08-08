import { ipcMain, shell, clipboard } from 'electron'

/**
 * 系统级操作 IPC：用默认浏览器打开链接、复制文本到剪贴板。
 * 渲染层在 contextIsolation 下无法直接调用这些 API，统一走这里。
 */
export function registerShellIpc() {
  // 用系统默认浏览器打开链接（而非在 Electron 窗口内打开）
  ipcMain.handle('shell:openExternal', async (_evt, url) => {
    try {
      if (typeof url === 'string' && url) await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 复制文本到系统剪贴板
  ipcMain.handle('shell:copy', async (_evt, text) => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : '')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 在系统文件管理器中打开文件夹（macOS Finder / Windows 资源管理器）
  // openPath 成功返回空字符串，失败返回错误描述
  ipcMain.handle('shell:openPath', async (_evt, dir) => {
    try {
      const err = await shell.openPath(String(dir || ''))
      if (err) return { ok: false, error: err }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
