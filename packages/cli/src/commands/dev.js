import { runThemeDev } from './_theme-dev.js'
import { pullChangedJson } from './_pull-changed-json.js'

/**
 * `shop dev` —— 先拉取当前分支改动过的 json 文件，再本地预览主题。
 * 流程：
 *   1. 解析环境（-e 优先；toml 单环境直接用，多环境让用户选）
 *   2. 读当前分支自创建以来改动的文件，筛出 json 文件
 *   3. 有则多选（首项「全选」）→ shopify theme pull -e <env> --only <file> …
 *   4. pull 无误后执行：shopify theme dev -e <env>（不带 --theme-editor-sync）
 */
export default {
  name: 'dev',
  aliases: ['dev'],
  description: '拉取当前分支改动的 json 文件后本地预览主题（pull → theme dev）',
  usage: 'shop dev [-e <env>]',
  async run(ctx) {
    if (!(await pullChangedJson(ctx))) return // 取消 / pull 失败，不继续
    await runThemeDev(ctx)
  },
}
