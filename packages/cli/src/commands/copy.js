import { readFileSync, writeFileSync } from 'node:fs'
import { select, input, confirm } from '@inquirer/prompts'
import ora from 'ora'
import initCmd from './init.js'
import { loadThemeConfig, setEnvField } from '../config.js'
import { captureShopify } from '../runner.js'
import { buildLinks } from '../links.js'

/**
 * 从 shopify -j 的 stdout 里解析 JSON。
 * -j 一般输出纯 JSON；做一点容错：整体解析失败时尝试截取最后一个 [...] / {...} 再解析。
 * @param {string} stdout
 * @returns {any | null}
 */
function parseJson(stdout) {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const matches = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/g)
    if (matches) {
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(matches[i])
        } catch {}
      }
    }
    return null
  }
}

/**
 * `shop copy` —— 把线上 live 主题复制成新主题（草稿），可选把新 id 回填到配置。
 * 流程：
 *   1. 确保 shopify.theme.toml 存在（没有则先 shop init）
 *   2. 读取并筛出配置了 store 的环境供选择；一个都没有就报错
 *   3. `shop theme list --role live -j -e <env>` → 取 live 主题 id
 *   4. 输入新主题名（必填）
 *   5. `shop theme duplicate --theme <id> --name <name> -e <env> -j` → 取新主题 id
 *   6. 展示主题后台 / 主题编辑链接（参考 shop pre）；询问是否把新 id 回填到对应环境的 theme 字段
 */
/**
 * 复制指定环境的 live 主题为新草稿主题（核心逻辑，供 shop copy 与 shop add 复用）。
 * 不做环境选择、不做 theme 回填——由调用方负责。
 * @param {object} ctx 命令上下文（取 log）
 * @param {object} opts
 * @param {string} opts.envName 环境名（如 'dev'）
 * @param {object} opts.envConfig 该环境参数对象（用于拼接链接）
 * @param {boolean} [opts.showLinks=true] 是否展示主题后台/编辑链接
 * @returns {Promise<{ id: string, name: string } | null>} 新主题信息；失败或取消返回 null
 */
export async function copyLiveTheme(ctx, { envName, envConfig, showLinks = true }) {
  const { log } = ctx

  // 拉 live 主题
  let liveId
  const listSpinner = ora(`正在获取 ${envName} 的 live 主题 …`).start()
  const listRes = await captureShopify(['theme', 'list', '--role', 'live', '-j', '-e', envName])
  if (listRes.code !== 0) {
    listSpinner.fail(`获取主题列表失败，退出码 ${listRes.code}`)
    if (listRes.stderr) console.log(listRes.stderr.trim())
    return null
  }
  const list = parseJson(listRes.stdout)
  const live = Array.isArray(list) ? list.find((t) => t.role === 'live') ?? list[0] : null
  if (!live || !live.id) {
    listSpinner.fail('未找到 live 主题')
    return null
  }
  liveId = live.id
  listSpinner.succeed(`已找到 live 主题：${live.name ?? ''}（${liveId}）`)

  // 输入关键值并拼接主题名：[<env>] <活动> | <负责人> | <YYYYMMDD>
  let activity, owner
  try {
    activity = await input({
      message: '请输入活动名称：',
      validate: (v) => (v.trim() ? true : '不能为空'),
    })
    owner = await input({
      message: '请输入负责人：',
      validate: (v) => (v.trim() ? true : '不能为空'),
    })
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return null
    }
    throw err
  }
  const now = new Date()
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const themeName = `[${envName}] ${activity.trim()} | ${owner.trim()} | ${dateStr}`
  log.info(`主题名：${themeName}`)

  // 复制主题
  const dupSpinner = ora(`正在复制主题「${themeName}」…`).start()
  const dupRes = await captureShopify([
    'theme',
    'duplicate',
    '--theme',
    String(liveId),
    '--name',
    themeName,
    '--force',
    '-e',
    envName,
    '-j',
  ])
  if (dupRes.code !== 0) {
    dupSpinner.fail(`复制主题失败，退出码 ${dupRes.code}`)
    if (dupRes.stderr) console.log(dupRes.stderr.trim())
    return null
  }
  const dup = parseJson(dupRes.stdout)
  const newTheme = dup?.theme
  if (!newTheme || !newTheme.id) {
    dupSpinner.fail('复制主题失败：未解析到新主题信息')
    if (dupRes.stdout) console.log(dupRes.stdout.trim())
    return null
  }
  dupSpinner.succeed(`已复制主题：${newTheme.name}（${newTheme.id}）`)

  if (showLinks) {
    const { adminLink, editorLink } = buildLinks({ ...envConfig, theme: String(newTheme.id) })
    log.info(`主题后台：${adminLink}`)
    log.info(`主题编辑：${editorLink}`)
  }

  return { id: String(newTheme.id), name: newTheme.name }
}

export default {
  name: 'copy',
  aliases: ['copy'],
  description: '复制 live 主题为新主题（草稿）',
  usage: 'shop copy',
  async run(ctx) {
    const { log } = ctx

    // ① 确保配置文件存在
    let cfg = loadThemeConfig()
    if (!cfg) {
      log.warn('未找到 shopify.theme.toml，先执行 shop init …')
      await initCmd.run(ctx)
      cfg = loadThemeConfig()
      if (!cfg) {
        log.error('初始化未完成，已取消执行')
        return
      }
    }

    // ② 筛选含 store 的环境
    const entries = Object.entries(cfg.environments).filter(([, e]) => e && e.store)
    if (entries.length === 0) {
      log.error('没有找到配置了 store 的环境，请先在 shopify.theme.toml 配置 [environments.*].store')
      return
    }

    // ③ 选择环境
    let envName
    try {
      envName = await select({
        message: '选择环境：',
        choices: entries.map(([name, e]) => ({ name: `${name}（${e.store}）`, value: name })),
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    const envConfig = cfg.environments[envName]

    // ④⑤⑥⑦ 复制 live 主题（核心逻辑复用 copyLiveTheme）
    const newTheme = await copyLiveTheme(ctx, { envName, envConfig })
    if (!newTheme) return

    // ⑧ 询问是否回填 theme id
    let backfill
    try {
      backfill = await confirm({
        message: `是否把新主题 id 回填到 [environments.${envName}].theme？`,
        default: true,
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    if (!backfill) {
      log.info('未回填，结束')
      return
    }

    const raw = readFileSync(cfg.path, 'utf8')
    const next = setEnvField(raw, envName, 'theme', String(newTheme.id))
    if (next === raw) {
      log.warn(`未在 [environments.${envName}] 中找到 theme 字段，已跳过回填`)
      return
    }
    writeFileSync(cfg.path, next, 'utf8')
    log.success(`已回填 theme = ${newTheme.id} 到 [environments.${envName}]`)
  },
}
