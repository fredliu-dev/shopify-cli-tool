import { banner } from '../ui/banner.js'
import { log } from '../ui/logger.js'
import { resolveEnvironment } from '../config.js'

export default {
  name: 'pre',
  aliases: ['pre'],
  description: '提测获取预览链接',
  usage: 'shop pre [-e <env>]',
  async run(ctx) {
    const args = ctx.argv.slice(1)
    const env = resolveEnvironment(args.length > 0 ? args : ['-e', 'dev'])

    if (!env) {
      log.error('未找到环境配置，请检查 shopify.theme.toml')
      return 1
    }

    const previewLink = env.preview_key
      ? `${env.domain}/pages?preview_key=${env.preview_key}&preview_theme_id=${env.theme}`
      : `${env.domain}?_ab=0&_fd=0&_sc=1&preview_theme_id=${env.theme}`
    const adminLink = `https://admin.shopify.com/store/${env.store.split('.')[0]}/themes`
    const editorLink = `${adminLink}/${env.theme}/editor`
    log.warn(`开发链接：http://127.0.0.1:${env.port}/pages?preview_key=${env.preview_key}`)
    log.info(`提测链接：${previewLink}`)
    log.info(`主题后台：${adminLink}`)
    log.info(`主题编辑：${editorLink}`)
  },
}
