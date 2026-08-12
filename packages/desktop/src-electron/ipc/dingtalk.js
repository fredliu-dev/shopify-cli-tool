import { ipcMain } from 'electron'

const load = () => import('@shopify-cli-tool/core')

/**
 * dingtalk 域 IPC handlers：通知群 + 消息模板 CRUD，以及提测发送。
 * 数据落 userDataDir()/dingtalk.json（{ groups, templates }）；模板的 defaults 字段透传保留。
 * gotest 复用 core 的 fillTemplate + sendText（headless，与 CLI shop gotest 同源）。
 */
export function registerDingtalkIpc() {
  // 读取 { groups, templates }（管理 Modal 与提测下拉共用）
  ipcMain.handle('dingtalk:load', async () => {
    const { loadDingtalkConfig } = await load()
    try {
      return { ok: true, data: loadDingtalkConfig() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 新增/更新通知群（无 id=新增，有 id=更新）
  ipcMain.handle('dingtalk:upsertGroup', async (_evt, { id, name, webhook, secret }) => {
    const { upsertDingtalkGroup } = await load()
    try {
      return { ok: true, data: upsertDingtalkGroup({ id, name, webhook, secret }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除通知群
  ipcMain.handle('dingtalk:removeGroup', async (_evt, id) => {
    const { removeDingtalkGroup } = await load()
    try {
      removeDingtalkGroup(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 新增/更新消息模板（透传保留 defaults）
  ipcMain.handle('dingtalk:upsertTemplate', async (_evt, { id, name, content, defaults }) => {
    const { upsertDingtalkTemplate } = await load()
    try {
      return { ok: true, data: upsertDingtalkTemplate({ id, name, content, defaults }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除消息模板
  ipcMain.handle('dingtalk:removeTemplate', async (_evt, id) => {
    const { removeDingtalkTemplate } = await load()
    try {
      removeDingtalkTemplate(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 设置模板的占位符默认值（@person 手机号）；defaults 为空对象则清除
  ipcMain.handle('dingtalk:saveDefaults', async (_evt, { templateId, defaults }) => {
    const { setDingtalkTemplateDefaults } = await load()
    try {
      const tpl = setDingtalkTemplateDefaults(templateId, defaults)
      if (!tpl) return { ok: false, error: '未找到该消息模板' }
      return { ok: true, data: tpl }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 解析某模板的占位符，返回渲染提测表单所需的字段列表
  ipcMain.handle('dingtalk:parsePlaceholders', async (_evt, templateId) => {
    const { loadDingtalkConfig, parsePlaceholders } = await load()
    try {
      const cfg = loadDingtalkConfig()
      const tpl = cfg.templates.find((t) => t.id === templateId)
      if (!tpl) return { ok: false, error: '未找到该消息模板' }
      const { persons, urls, titles, contents, tapds, hasAll } = parsePlaceholders(tpl.content)
      const fields = [
        ...persons.map((p) => ({ kind: 'person', ...p })),
        ...urls.map((u) => ({ kind: 'url', ...u })),
        ...titles.map((t) => ({ kind: 'title', ...t })),
        ...tapds.map((d) => ({ kind: 'tapd', ...d })),
        ...contents.map((c) => ({ kind: 'content', ...c })),
      ]
      return { ok: true, data: { fields, hasAll } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 提测：用选定的群+模板+占位符值发送钉钉消息（values 为按 token 存的扁平对象）
  ipcMain.handle('dingtalk:gotest', async (_evt, { groupId, templateId, values }) => {
    const { loadDingtalkConfig, fillTemplate, sendText } = await load()
    try {
      const cfg = loadDingtalkConfig()
      const group = cfg.groups.find((g) => g.id === groupId)
      const tpl = cfg.templates.find((t) => t.id === templateId)
      if (!group) return { ok: false, error: '未找到该通知群' }
      if (!tpl) return { ok: false, error: '未找到该消息模板' }
      const { text, atMobiles, isAtAll } = fillTemplate(tpl.content, values || {})
      const errmsg = await sendText(text, group, { atMobiles, isAtAll })
      return { ok: true, errmsg }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 第④步「获取合并提交信息」发送：前端已按每个项目渲染并拼接好最终文本，这里直接发。
  // text/atMobiles/isAtAll 均由前端算好传入（不再走 fillTemplate）。
  ipcMain.handle('dingtalk:notify', async (_evt, { groupId, text, atMobiles, isAtAll }) => {
    const { loadDingtalkConfig, sendText } = await load()
    try {
      const cfg = loadDingtalkConfig()
      const group = cfg.groups.find((g) => g.id === groupId)
      if (!group) return { ok: false, error: '未找到该通知群' }
      const errmsg = await sendText(text, group, { atMobiles: atMobiles || [], isAtAll: !!isAtAll })
      return { ok: true, errmsg }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
