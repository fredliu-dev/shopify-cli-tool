import { app, ipcMain } from 'electron'
import { execSync } from 'node:child_process'

const load = () => import('@shopify-cli-tool/core')

/**
 * system 域 IPC：供「关于」弹窗展示版本信息。
 * - app：客户端版本（app.getVersion()，读 desktop package.json）
 * - shopify：实际调用的 @shopify/cli 版本（由 core 解析其 package.json，与 runner 同源）
 * - git：本机系统 git 版本（git --version）
 * - electron / node：运行时版本
 */
function gitVersion() {
  try {
    return execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .replace(/^git version\s*/i, '')
  } catch {
    return null
  }
}

export function registerSystemIpc() {
  ipcMain.handle('system:versions', async () => {
    const { SHOPIFY_CLI_VERSION } = await load()
    return {
      app: app.getVersion(),
      shopify: SHOPIFY_CLI_VERSION,
      git: gitVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    }
  })
}
