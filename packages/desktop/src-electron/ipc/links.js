import { ipcMain } from 'electron'

export function registerLinksIpc() {
  // 取某项目目录 dev 环境的提测链接（对应 shop pre）
  ipcMain.handle('links:get', async (_evt, { startDir, envName = 'dev' } = {}) => {
    const { getDevLinks } = await import('@shopify-cli-tool/core')
    try {
      const links = getDevLinks({ startDir, envName })
      if (!links) return { ok: false, error: '未找到环境配置，请检查 shopify.theme.toml' }
      return { ok: true, data: links }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
