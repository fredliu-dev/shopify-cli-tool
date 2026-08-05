import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { select, input } from '@inquirer/prompts'
import { listTemplates, buildThemeConfig, mergeDevEnv } from '@shopify-cli-tool/core'

/**
 * `shop init` —— 初始化 / 更新 shopify.theme.toml。
 * 如果文件不存在：选模板 → 输 theme → 输 port → 输 preview_key → 输 project_desc(选填) → 生成。
 * 如果文件已存在：若缺少 [environments.dev]，则把模板整个 dev 环境合并进去；
 *                 若已有 dev 环境但缺少 domain，则补入对应 domain。
 * 生成/合并的纯逻辑在 core（buildThemeConfig / mergeDevEnv），这里只负责交互。
 */
export default {
  name: 'init',
  aliases: ['init'],
  description: '初始化 shopify.theme.toml',
  usage: 'shop init',
  async run({ log }) {
    const templates = listTemplates()
    if (!templates.length) {
      log.error('未找到任何模板（core/src/config/*.toml）')
      return
    }

    const target = join(process.cwd(), 'shopify.theme.toml')

    if (existsSync(target)) {
      const raw = readFileSync(target, 'utf8')
      let parsed = {}
      try {
        parsed = parse(raw)
      } catch {}

      if (parsed.environments?.dev?.domain) {
        log.success('已初始化完毕（shopify.theme.toml 已存在且包含 [environments.dev].domain）')
        return
      }

      let tpl
      try {
        tpl = await select({
          message: '检测到已有 shopify.theme.toml，选择模板来补全 [environments.dev]：',
          choices: templates.map((t) => ({ name: t.name, value: t })),
        })
      } catch (err) {
        if (err?.name === 'ExitPromptError') {
          log.info('已取消')
          return
        }
        throw err
      }

      try {
        writeFileSync(target, mergeDevEnv(raw, tpl.name), 'utf8')
        log.success('已合并 [environments.dev] 到现有配置')
      } catch (err) {
        log.error(err.message)
      }
      return
    }

    let tpl, theme, port, previewKey, projectDesc
    try {
      tpl = await select({
        message: '选择模板：',
        choices: templates.map((t) => ({ name: t.name, value: t })),
      })
      theme = await input({ message: '请输入 theme：' })
      port = await input({
        message: '请输入 port：',
        default: '9292',
        validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字'),
      })
      previewKey = await input({ message: '请输入 preview_key（新页面需填）：' })
      projectDesc = await input({ message: '请输入 project_desc（选填）：' })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    try {
      const content = buildThemeConfig({
        templateName: tpl.name,
        theme,
        port,
        previewKey,
        projectDesc,
      })
      writeFileSync(target, content, 'utf8')
      log.success(`已创建 ${target}`)
    } catch (err) {
      log.error(err.message)
    }
  },
}
