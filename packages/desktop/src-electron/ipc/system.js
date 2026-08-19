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
    // windowsHide：GUI 进程里 execSync 默认会闪黑色 cmd 窗口
    return execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .trim()
      .replace(/^git version\s*/i, '')
  } catch {
    return null
  }
}

export function registerSystemIpc() {
  ipcMain.handle('system:versions', async () => {
    const { SHOPIFY_CLI_VERSION, getShopifyNodeInfo } = await load()
    const nodeInfo = await getShopifyNodeInfo()
    return {
      app: app.getVersion(),
      shopify: SHOPIFY_CLI_VERSION,
      git: gitVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      // 跑 @shopify/cli 的系统 Node：fallback=true 表示未找到（Windows 分发给未装 Node 的用户时高发），
      // 渲染层据此提示安装 Node.js ≥22，否则 shopify 相关功能会静默失败
      systemNode: { path: nodeInfo.node, fallback: nodeInfo.fallback },
    }
  })
}
