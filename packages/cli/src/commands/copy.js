import { readFileSync, writeFileSync } from 'node:fs'
import { select, input, confirm } from '@inquirer/prompts'
import ora from 'ora'
import initCmd from './init.js'
import { loadThemeConfig, setEnvField, duplicateLiveTheme } from '@shopify-cli-tool/core'

/**
 * 复制指定环境的 live 主题为新草稿主题（CLI 交互壳，供 shop copy 与 shop add 复用）。
 * 核心逻辑（shopify 调用）在 core 的 duplicateLiveTheme；这里只负责提问 + 展示。
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

  // 输入关键值（主题名 = [env] 活动 | 负责人 | YYYYMMDD，日期由 core 拼接）
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

  // 复制 live 主题（获取 live id + duplicate 都在 core 里完成）
  const spinner = ora(`正在复制 ${envName} 的 live 主题 …`).start()
  const res = await duplicateLiveTheme({
    cwd: process.cwd(),
    envName,
    envConfig,
    activity,
    owner,
  })
  if (!res.ok) {
    spinner.fail(`复制主题失败（${res.stage}，退出码 ${res.code}）`)
    if (res.stderr) console.log(res.stderr.trim())
    if (res.stdout) console.log(res.stdout.trim())
    return null
  }
  spinner.succeed(`已复制主题：${res.name}（${res.id}）`)

  if (showLinks) {
    log.info(`主题后台：${res.links.adminLink}`)
    log.info(`主题编辑：${res.links.editorLink}`)
  }

  return { id: res.id, name: res.name }
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
