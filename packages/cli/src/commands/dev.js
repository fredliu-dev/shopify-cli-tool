import { runThemeDev } from './_theme-dev.js'

// `shop dev` → shopify theme dev -e <env>（本地预览主题；-e 缺省为 dev）
export default {
  name: 'dev',
  aliases: ['dev'],
  description: '本地预览主题（shopify theme dev -e dev，-e 可选）',
  usage: 'shop dev [-e <env>]',
  async run(ctx) {
    await runThemeDev(ctx)
  },
}
