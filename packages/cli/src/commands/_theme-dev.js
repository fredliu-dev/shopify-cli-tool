import { existsSync } from 'node:fs'
import { join } from 'node:path'
import initCmd from './init.js'
import preCmd from './pre.js'
import { extractEnvironmentArg } from '@shopify-cli-tool/core'

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
 * @param {object} ctx 命令上下文（argv / log / banner / version / runShopify）
 * @param {string[]} [extraArgs] 插在 `theme dev` 与 `-e <env>` 之间的额外参数
 * @returns {Promise<number | void>}
 */
export async function runThemeDev(ctx, extraArgs = []) {
  if (!(await ensureInitialized(ctx))) {
    ctx.log.error('初始化未完成，已取消执行')
    return
  }

  // -e/--environment 传了就用传入的环境名，没传默认 dev
  const env = extractEnvironmentArg(ctx.argv) ?? 'dev'
  const args = ['theme', 'dev', ...extraArgs, '-e', env]
  ctx.banner(ctx.version)
  ctx.log.step(`执行：shopify ${args.join(' ')}`)

  // shopify theme dev 会长时间占用终端，启动前先把 pre 的预览链接输出出来，
  // 服务跑起来后即可直接取用（pre 会按 -e/--environment 解析对应环境）。
  await preCmd.run(ctx)

  const code = await ctx.runShopify(args)
  if (code === 0) {
    ctx.log.success('完成 ✅')
  } else {
    ctx.log.error(`命令失败，退出码 ${code}`)
    process.exit(code)
  }
}
