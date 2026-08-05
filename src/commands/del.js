import { checkbox, confirm } from '@inquirer/prompts'
import { loadProjects, saveProjects } from '../projects.js'

/**
 * `shop del` —— 删除保存的项目配置。
 */
export default {
  name: 'del',
  aliases: ['del'],
  description: '删除保存的项目配置',
  usage: 'shop del',
  async run({ log }) {
    const projects = loadProjects()

    if (!projects.length) {
      log.info('暂无保存的项目配置')
      return
    }

    // 多选要删除的项目
    let selected
    try {
      selected = await checkbox({
        message: '选择要删除的项目（可多选）：',
        choices: projects.map((p) => ({
          name: `${p.templateName} - ${p.description || '无描述'}`,
          value: p,
        })),
      })
    } catch (err) {
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    if (!selected.length) {
      log.info('未选择任何项目')
      return
    }

    // 二次确认：逐条列出待删除项目，避免误删
    const summary = selected
      .map((p) => `  · ${p.templateName} - ${p.description || '无描述'}`)
      .join('\n')
    let confirmed
    try {
      confirmed = await confirm({
        message: `确认删除以下 ${selected.length} 个项目？\n${summary}`,
        default: false,
      })
    } catch (err) {
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    if (!confirmed) {
      log.info('已取消删除')
      return
    }

    // 删除选中的项目
    const selectedIds = new Set(selected.map((p) => p.id))
    const updatedProjects = projects.filter((p) => !selectedIds.has(p.id))
    saveProjects(updatedProjects)

    log.success(`已删除 ${selected.length} 个项目配置`)
  },
}