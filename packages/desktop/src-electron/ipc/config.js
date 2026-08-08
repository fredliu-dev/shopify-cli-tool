import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

const THEME_FILE = 'shopify.theme.toml'

export function registerConfigIpc() {
  // 列出可用模板（内置 + 用户自建，core 的 listTemplates 已合并两个目录）
  ipcMain.handle('config:templates', async () => {
    const { listTemplates } = await import('@shopify-cli-tool/core')
    return listTemplates()
  })

  // 本地数据目录（projects.json / templates 所在），供「本地配置」按钮打开
  ipcMain.handle('config:dataDir', async () => {
    const { userDataDir } = await import('@shopify-cli-tool/core')
    try {
      return { ok: true, data: userDataDir() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 新建用户模板：写字段到 userDataDir/templates/<name>.shopify.theme.toml
  ipcMain.handle('config:createTemplate', async (_evt, { name, fields }) => {
    const { saveTemplate } = await import('@shopify-cli-tool/core')
    try {
      await saveTemplate({ name, fields })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取某模板的 [environments.dev] 字段（编辑表单预填；含 _github/_branch 等只读元数据）
  ipcMain.handle('config:templateEnv', async (_evt, name) => {
    const { loadTemplateEnv } = await import('@shopify-cli-tool/core')
    try {
      return { ok: true, data: loadTemplateEnv(name) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 改写用户自建模板字段（内置模板 core 层已拒绝）
  ipcMain.handle('config:updateTemplate', async (_evt, { name, fields }) => {
    const { updateTemplate } = await import('@shopify-cli-tool/core')
    try {
      await updateTemplate({ name, fields })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除用户自建模板（内置模板 core 层已拒绝）
  ipcMain.handle('config:deleteTemplate', async (_evt, name) => {
    const { deleteTemplate } = await import('@shopify-cli-tool/core')
    try {
      deleteTemplate(name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取目标目录的 init 状态
  ipcMain.handle('config:initStatus', async (_evt, dir) => {
    const target = join(dir, THEME_FILE)
    if (!existsSync(target)) return { exists: false }
    let hasDevDomain = false
    try {
      const parsed = parse(readFileSync(target, 'utf8'))
      hasDevDomain = !!parsed.environments?.dev?.domain
    } catch {}
    return { exists: true, hasDevDomain }
  })

  // 新建 shopify.theme.toml（文件不存在分支）
  ipcMain.handle(
    'config:initCreate',
    async (_evt, { dir, templateName, theme, port, previewKey, projectDesc }) => {
      const { buildThemeConfig } = await import('@shopify-cli-tool/core')
      try {
        const content = buildThemeConfig({ templateName, theme, port, previewKey, projectDesc })
        writeFileSync(join(dir, THEME_FILE), content, 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  )

  // 合并 dev 环境到已有 shopify.theme.toml（文件已存在分支）
  ipcMain.handle('config:initMerge', async (_evt, { dir, templateName }) => {
    const { mergeDevEnv } = await import('@shopify-cli-tool/core')
    try {
      const target = join(dir, THEME_FILE)
      const raw = readFileSync(target, 'utf8')
      writeFileSync(target, mergeDevEnv(raw, templateName), 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
