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

  ipcMain.handle('shops:delete', async (_evt, payload) => {
    const { deleteProjects, deleteProjectSynced } = await load()
    try {
      // 兼容两种入参：
      //  - 数组（批量、无仓库上下文，如「删除项目」页）：仅删 projects.json
      //  - { ids, repoPath }（仓库卡片删除）：逐条同步删除，当前生效项会清掉该仓库 toml
      if (Array.isArray(payload)) {
        return { ok: true, deleted: deleteProjects(payload) }
      }
      const { ids, repoPath } = payload || {}
      if (repoPath && Array.isArray(ids) && ids.length) {
        let synced = 0
        let skippedReason = null
        for (const id of ids) {
          const r = await deleteProjectSynced(id, repoPath)
          if (r.synced) synced++
          else if (r.skipped && !skippedReason) skippedReason = r.skipped
        }
        return { ok: true, deleted: ids.length, synced, skipped: skippedReason }
      }
      return { ok: true, deleted: deleteProjects(ids || []) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shops:update', async (_evt, { id, fields, repoPath }) => {
    const { updateProject, updateProjectSynced, storeToTemplate } = await load()
    try {
      // 模板由 store 决定（与 CLI 的 edit 行为一致）
      let templateName = fields.templateName
      if (fields.store) templateName = storeToTemplate(fields.store) ?? templateName
      const payload = { ...fields, templateName }
      // 有仓库上下文时：若编辑的是该仓库「当前生效」项目，同步回写其 shopify.theme.toml；
      // 无仓库上下文（如通用编辑页）则只更 projects.json，行为与原先一致
      const data = repoPath
        ? await updateProjectSynced(id, payload, repoPath)
        : { project: updateProject(id, payload) }
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shops:storeToTemplate', async (_evt, store) => {
    const { storeToTemplate } = await load()
    return storeToTemplate(store)
  })
}
