import { select, checkbox } from '@inquirer/prompts'
import { loadThemeConfig, extractEnvironmentArg, getChangedFiles } from '@shopify-cli-tool/core'

// 多选项里的「全选」哨兵值
const ALL = '__all__'

/** 路径是否为 json 文件（整个项目范围内，不限 templates/） */
function isJsonFile(p) {
  return /\.json$/i.test(p)
}

/**
 * 解析环境：-e/--environment 优先；否则读 shopify.theme.toml——单环境直接用，多环境让用户选。
 * 无 toml / 无环境时返回 null（跳过 pull，交由 runThemeDev 处理）。
 * @param {string[]} argv
 * @returns {Promise<string | null>}
 */
async function resolveEnv(argv) {
  const fromArg = extractEnvironmentArg(argv)
  if (fromArg) return fromArg
  const cfg = loadThemeConfig()
  const envs = cfg ? Object.keys(cfg.environments) : []
  if (envs.length === 0) return null
  if (envs.length === 1) return envs[0]
  return select({ message: '选择环境：', loop: false, choices: envs.map((e) => ({ name: e, value: e })) })
}

/**
 * 拉取当前分支改动过的 json 文件：读改动文件 → 筛 json → 多选（首项「全选」）
 * → shopify theme pull -e <env> --only <file> --only <file> …
 * @returns {Promise<boolean>} true=可继续后续逻辑（成功/跳过）；false=pull 失败应中止
 */
async function doPullChangedJson(ctx, env) {
  const { log, runShopify } = ctx
  const changed = await getChangedFiles(process.cwd())
  const jsonFiles = changed.filter(isJsonFile)
  if (!jsonFiles.length) {
    log.info('当前分支没有改动的 json 文件，跳过 pull')
    return true
  }

  // 默认勾选「全选」；若另外勾选了具体文件，则只拉取那些（具体选择优先于全选，
  // 等效于「选了其他项就取消全选」——inquirer 的 checkbox 无法实时联动，故在结果上处理）
  const choices = [{ name: '全选', value: ALL, checked: true }, ...jsonFiles.map((f) => ({ name: f, value: f }))]
  const ans = await checkbox({
    message: '选择要拉取的 json 文件（默认全选；勾选具体文件则只拉取这些；不选则跳过）：',
    loop: false,
    choices,
  })
  const specific = ans.filter((a) => a !== ALL)
  const files = specific.length ? specific : ans.includes(ALL) ? jsonFiles : []
  if (!files.length) {
    log.info('未选择任何文件，跳过 pull')
    return true
  }

  const args = ['theme', 'pull', '-e', env, ...files.flatMap((f) => ['--only', f])]
  log.step(`执行：shopify ${args.join(' ')}`)
  const code = await runShopify(args)
  if (code !== 0) {
    log.error(`theme pull 失败（退出码 ${code}），已中止`)
    return false
  }
  log.success('theme pull 完成')
  return true
}

/**
 * `shop dev` / `shop async` 共用的前置：解析环境并拉取当前分支改动过的 json 文件。
 * - 用户取消（Ctrl+C）或 pull 失败时返回 false，调用方应中止，不再进入 theme dev。
 * - 成功/跳过返回 true；并把解析或选出的环境注入 argv（用户没显式传 -e 时），
 *   供后续 runThemeDev 复用同一个环境。
 * @param {object} ctx 命令上下文（argv / log / runShopify）
 * @returns {Promise<boolean>} 是否可继续后续 theme dev
 */
export async function pullChangedJson(ctx) {
  const { log, argv } = ctx

  let env
  let pullOk = true
  try {
    env = await resolveEnv(argv)
    if (env) pullOk = await doPullChangedJson(ctx, env)
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return false
    }
    throw err
  }

  if (!pullOk) return false

  // 把解析/选出的环境注入 argv，供后续 runThemeDev 用同一个环境
  if (env && !extractEnvironmentArg(argv)) argv.push('-e', env)
  return true
}
