import { ipcMain } from 'electron'

const load = () => import('@shopify-cli-tool/core')

/**
 * contacts 域 IPC handlers：人员配置增删改查（存 userDataDir()/contacts.json）。
 * 供桌面端「与人有关」的下拉（负责人姓名、提测 @手机号）使用。
 */
export function registerContactsIpc() {
  // 列出全部人员
  ipcMain.handle('contacts:ls', async () => {
    const { loadContacts } = await load()
    try {
      return { ok: true, data: loadContacts() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 新增/更新人员（无 id=新增，有 id=更新）
  ipcMain.handle('contacts:upsert', async (_evt, { id, name, phone }) => {
    const { upsertContact } = await load()
    try {
      return { ok: true, data: upsertContact({ id, name, phone }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除人员
  ipcMain.handle('contacts:remove', async (_evt, id) => {
    const { removeContact } = await load()
    try {
      removeContact(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
