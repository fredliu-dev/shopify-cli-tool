import { banner } from '../ui/banner.js'
import { log } from '../ui/logger.js'
import { resolveEnvironment } from '../config.js'
import { buildLinks } from '../links.js'

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

    const { devLink, previewLink, adminLink, editorLink } = buildLinks(env)
    log.warn(`开发链接：${devLink}`)
    log.info(`提测链接：${previewLink}`)
    log.info(`主题后台：${adminLink}`)
    log.info(`主题编辑：${editorLink}`)
  },
}
