import { existsSync } from 'node:fs'
import { join } from 'node:path'
import initCmd from './init.js'

/**
 * 确保 cwd 下已有 shopify.theme.toml；没有就先跑一遍 `shop init`（交互式）。
 * 用 cwd 而不是向上查找，和 init.js 的判定/落点保持一致。
 * @param {object} ctx 命令上下文（仅用 log）
 * @returns {Promise<boolean>} true=已就绪可直接执行；false=用户取消/未生成，应中止
 */
async function ensureInitialized(ctx) {
  const target = join(process.cwd(), 'shopify.theme.toml')
  if (existsSync(target)) return true

  ctx.log.warn('未找到 shopify.theme.toml，先执行 shop init …')
  // 复用 init 命令的 run：已存在它自己会提示「已初始化完毕」，这里走的是它缺文件的引导流
  await initCmd.run(ctx)
  return existsSync(target)
}

/**
 * 通用：跑 `shopify theme dev …`。
 * ① 没初始化就先 init；② 用 runShopify 透传执行；③ 按退出码收尾。
 * @param {object} ctx 命令上下文（log / banner / version / runShopify）
 * @param {string[]} [extraArgs] 插在 `theme dev` 与 `-e dev` 之间的额外参数
 * @returns {Promise<number | void>}
 */
export async function runThemeDev(ctx, extraArgs = []) {
  if (!(await ensureInitialized(ctx))) {
    ctx.log.error('初始化未完成，已取消执行')
    return
  }

  const args = ['theme', 'dev', ...extraArgs, '-e', 'dev']
  ctx.banner(ctx.version)
  ctx.log.step(`执行：shopify ${args.join(' ')}`)

  const code = await ctx.runShopify(args)
  if (code === 0) {
    ctx.log.success('完成 ✅')
  } else {
    ctx.log.error(`命令失败，退出码 ${code}`)
    process.exit(code)
  }
}
