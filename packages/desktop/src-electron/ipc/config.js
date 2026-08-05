import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

const THEME_FILE = 'shopify.theme.toml'

export function registerConfigIpc() {
  // 列出可用模板
  ipcMain.handle('config:templates', async () => {
    const { listTemplates } = await import('@shopify-cli-tool/core')
    return listTemplates()
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
