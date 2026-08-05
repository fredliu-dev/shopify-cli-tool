import { ipcMain } from 'electron'

const load = () => import('@shopify-cli-tool/core')

/**
 * shops 域 IPC handlers。core 是 ESM 包，CJS 主进程用动态 import 加载。
 */
export function registerShopsIpc() {
  ipcMain.handle('shops:ls', async () => {
    const { assembleProjects } = await load()
    try {
      return { ok: true, data: assembleProjects() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shops:delete', async (_evt, ids) => {
    const { deleteProjects } = await load()
    try {
      return { ok: true, deleted: deleteProjects(ids) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shops:update', async (_evt, { id, fields }) => {
    const { updateProject, storeToTemplate } = await load()
    try {
      // 模板由 store 决定（与 CLI 的 edit 行为一致）
      let templateName = fields.templateName
      if (fields.store) templateName = storeToTemplate(fields.store) ?? templateName
      const updated = updateProject(id, { ...fields, templateName })
      return { ok: true, data: updated }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shops:storeToTemplate', async (_evt, store) => {
    const { storeToTemplate } = await load()
    return storeToTemplate(store)
  })
}
