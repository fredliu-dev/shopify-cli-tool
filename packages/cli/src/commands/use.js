import { readFileSync, writeFileSync } from 'node:fs'
import { select, input } from '@inquirer/prompts'
import initCmd from './init.js'
import { loadThemeConfig, setEnvField, getPortPids, killPort, loadProjects } from '@shopify-cli-tool/core'
import { runThemeDev } from './_theme-dev.js'

/**
 * `shop use` —— 使用与当前配置匹配的项目并执行命令。
 * 流程：
 *   1. 读 shopify.theme.toml 的 theme/store（没配置文件先 init；缺了就补填并写回）
 *   2. 列出项目，只有 theme+store 与当前配置一致的可选，其余 disable
 *   3. 选中后把项目的 preview_key/port 同步进 dev 环境，再跑 dev/async
 */
export default {
  name: 'use',
  aliases: ['use'],
  description: '使用与当前配置匹配的项目并执行命令',
  usage: 'shop use',
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

    const dev = cfg.environments.dev
    if (!dev) {
      log.error('配置缺少 [environments.dev]')
      return
    }

    // ② 读 theme/store，缺了就补填并写回（后续要靠它们匹配项目）
    let content = readFileSync(cfg.path, 'utf8')
    const filled = {}
    for (const f of [
      { key: 'theme', message: '请输入 theme：' },
      { key: 'store', message: '请输入 store：' },
    ]) {
      const cur = dev[f.key]
      if (cur === undefined || String(cur).trim() === '') {
        let val
        try {
          val = await input({
            message: f.message,
            validate: (v) => (v.trim() ? true : '不能为空'),
          })
        } catch (err) {
          if (err?.name === 'ExitPromptError') {
            log.info('已取消')
            return
          }
          throw err
        }
        filled[f.key] = val.trim()
        content = setEnvField(content, 'dev', f.key, val.trim())
      }
    }
    if (Object.keys(filled).length) {
      writeFileSync(cfg.path, content, 'utf8')
      log.success('已将补填字段写回 shopify.theme.toml')
    }
    const configTheme = String(filled.theme ?? dev.theme)
    const configStore = String(filled.store ?? dev.store)

    // ③ 加载项目，按 theme+store 判断是否可选
    const projects = loadProjects()
    if (!projects.length) {
      log.error('暂无保存的项目配置，请先使用 shop add 添加')
      return
    }
    const isMatch = (p) => String(p.theme) === configTheme && String(p.store) === configStore
    if (!projects.some(isMatch)) {
      log.error(`没有与当前配置匹配的项目（theme=${configTheme}, store=${configStore}）`)
      return
    }

    // ④ 选择项目：不匹配的 disable 掉
    let selectedProject
    try {
      selectedProject = await select({
        message: '选择要使用的项目：',
        choices: projects.map((p) => ({
          name: `${p.templateName ?? p.store ?? '?'} - ${p.description || '无描述'}`,
          value: p,
          disabled: isMatch(p) ? false : 'theme/store 与当前配置不符',
        })),
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // ⑤ 把项目的全部配置属性同步进 dev 环境（用项目数据覆盖现有值）；
    //    theme/store 虽已是匹配条件（必然相等），一并写入，确保配置与项目完全一致
    content = readFileSync(cfg.path, 'utf8')
    for (const [key, val] of [
      ['domain', selectedProject.domain],
      ['project_desc', selectedProject.description],
      ['preview_key', selectedProject.previewKey],
      ['port', selectedProject.port],
      ['theme', selectedProject.theme],
      ['store', selectedProject.store],
    ]) {
      if (val !== undefined && val !== null) {
        content = setEnvField(content, 'dev', key, val)
      }
    }
    writeFileSync(cfg.path, content, 'utf8')
    log.success('配置文件已更新')

    // ⑥ 选择执行方式
    let commandType
    try {
      commandType = await select({
        message: '选择执行方式：',
        choices: [
          { name: 'shop dev (本地预览主题)', value: 'dev' },
          { name: 'shop async (异步模式)', value: 'async' },
        ],
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // 端口若被占用（通常是上一次未关闭的 dev server），先释放
    const port = Number(selectedProject.port)
    const heldBy = getPortPids(port)
    if (heldBy.length) {
      log.warn(`端口 ${port} 被占用（PID: ${heldBy.join(', ')}），正在关闭旧进程…`)
      const killed = killPort(port)
      log.info(`已关闭 ${killed} 个占用进程`)
    }

    // 执行对应的命令（复用 runThemeDev，与 shop dev / shop async 行为一致）
    const extraArgs = commandType === 'async' ? ['--theme-editor-sync'] : []
    await runThemeDev(ctx, extraArgs)
  },
}
