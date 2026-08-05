import { ipcMain, dialog } from 'electron'

export function registerDialogIpc() {
  // 选择项目目录（GUI 没有 cwd 概念，pre/init 都需要先选目录）
  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return { ok: true, dir: res.filePaths[0] }
  })
}
