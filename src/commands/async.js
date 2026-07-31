import { runThemeDev } from './_theme-dev.js'

// `shop async` → shopify theme dev --theme-editor-sync -e dev（本地预览 + 同步到主题编辑器）
export default {
  name: 'async',
  aliases: ['async'],
  description: '同步主题到编辑器（shopify theme dev --theme-editor-sync -e dev）',
  usage: 'shop async',
  async run(ctx) {
    await runThemeDev(ctx, ['--theme-editor-sync'])
  },
}
