import { ipcMain } from 'electron'

const load = () => import('@shopify-cli-tool/core')

/**
 * settings 域 IPC handlers：读写 userDataDir()/settings.json。
 */
export function registerSettingsIpc() {
  ipcMain.handle('settings:get', async () => {
    const { loadSettings } = await load()
    return loadSettings()
  })

  ipcMain.handle('settings:setWorkspace', async (_evt, dir) => {
    const { saveSettings } = await load()
    try {
      return { ok: true, data: saveSettings({ workspaceDir: dir }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 设置默认编辑器（运行仓库时用它打开目录）
  ipcMain.handle('settings:setEditor', async (_evt, editorId) => {
    const { saveSettings } = await load()
    try {
      return { ok: true, data: saveSettings({ defaultEditor: editorId }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 通用偏好写入（浅合并）：供渲染层持久化任意设置项，如仓库卡片的自定义排序 repoOrder
  ipcMain.handle('settings:set', async (_evt, patch) => {
    const { saveSettings } = await load()
    try {
      return { ok: true, data: saveSettings(patch || {}) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
