import { runThemeDev } from './_theme-dev.js'

// `shop dev` → shopify theme dev -e dev（本地预览主题）
export default {
  name: 'dev',
  aliases: ['dev'],
  description: '本地预览主题（shopify theme dev -e dev）',
  usage: 'shop dev',
  async run(ctx) {
    await runThemeDev(ctx)
  },
}
