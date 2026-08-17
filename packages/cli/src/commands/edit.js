import { select, input } from '@inquirer/prompts'
import { storeToTemplate, loadProjects, saveProjects, splitDesc } from '@shopify-cli-tool/core'

/**
 * `shop edit` —— 编辑保存的项目配置。
 */
export default {
  name: 'edit',
  aliases: ['edit'],
  description: '编辑保存的项目配置',
  usage: 'shop edit',
  async run({ log }) {
    const projects = loadProjects()

    if (!projects.length) {
      log.info('暂无保存的项目配置')
      return
    }

    let selectedProject
    try {
      selectedProject = await select({
        message: '选择要编辑的项目：',
        choices: projects.map((p) => ({
          name: `${p.templateName ?? p.store ?? '?'} - ${p.description || '无描述'}`,
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

    // 模板由 store 判断（只展示，不再让用户选）
    const templateName =
      (selectedProject.store ? storeToTemplate(selectedProject.store) : null) ?? selectedProject.templateName
    log.info(`模板（根据 store 判断）：${templateName ?? '未匹配'}`)

    let theme, previewKey, previewPath, port, description
    try {
      theme = await input({
        message: '请输入 theme：',
        default: selectedProject.theme,
        validate: (v) => (v.trim() ? true : '不能为空'),
      })

      previewKey = await input({
        message: '请输入 preview_key：',
        default: selectedProject.previewKey,
      })

      previewPath = await input({
        message: '请输入网页路径（选填，如 /pages/back-to-school-sale）：',
        default: selectedProject.previewPath ?? '',
      })

      port = await input({
        message: '请输入 port：',
        default: selectedProject.port,
        validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字'),
      })

      description = await input({
        message: '请输入描述（可含工单链接，自动拆为 _tapd）：',
        default: [selectedProject.description, selectedProject._tapd].filter(Boolean).join(' '),
      })
    } catch (err) {
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // 描述可能含工单链接：拆分出 _tapd（参照桌面端 splitDesc）
    const { desc, tapd } = splitDesc(description)
    const updatedProjects = projects.map((p) => {
      if (p.id === selectedProject.id) {
        return {
          ...p,
          templateName,
          theme: theme.trim(),
          previewKey: previewKey.trim(),
          previewPath: previewPath.trim(),
          port: port.trim(),
          description: desc,
          _tapd: tapd,
        }
      }
      return p
    })

    saveProjects(updatedProjects)
    log.success('项目配置已更新')
  },
}