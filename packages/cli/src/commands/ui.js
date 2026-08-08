import pc from 'picocolors'
import { launchApp, APP_NAME } from './_desktop.js'

/**
 * `shop ui` —— 打开已安装的 Shopify Toolbox 桌面应用。
 * 未安装时提示先运行 `shop download`。
 */
export default {
  name: 'ui',
  aliases: ['ui'],
  description: '打开 Shopify Toolbox 桌面应用',
  usage: 'shop ui',
  async run({ log }) {
    const r = launchApp()
    if (r.ok) {
      log.success(`已打开「${APP_NAME}」${pc.gray(r.path)}`)
      return
    }
    log.error(`未找到已安装的「${APP_NAME}」桌面应用。`)
    log.info(`请先运行 ${pc.cyan('shop download')} 下载并安装。`)
    return 1
  },
}
