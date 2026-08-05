import { runThemeDev } from './_theme-dev.js'

// `shop async` → shopify theme dev --theme-editor-sync -e <env>（本地预览 + 同步到主题编辑器；-e 缺省为 dev）
export default {
  name: 'async',
  aliases: ['async'],
  description: '同步主题到编辑器（shopify theme dev --theme-editor-sync -e dev，-e 可选）',
  usage: 'shop async [-e <env>]',
  async run(ctx) {
    await runThemeDev(ctx, ['--theme-editor-sync'])
  },
}
