import pc from 'picocolors'
import { buildLinks, loadProjects, getProjectsFile, loadTemplateEnv } from '@shopify-cli-tool/core'

/**
 * `shop ls` —— 列出所有保存的项目配置。
 */
export default {
  name: 'ls',
  aliases: ['ls'],
  description: '列出所有保存的项目配置',
  usage: 'shop ls',
  async run({ log }) {
    const projects = loadProjects()

    if (!projects.length) {
      log.info('暂无保存的项目配置')
      console.log(pc.gray(`数据文件：${getProjectsFile()}`))
      return
    }

    // 使用 cli-table3 创建表格
    const center = (content) => ({ content, hAlign: 'center', vAlign: 'center' })
    const Table = (await import('cli-table3')).default
    const table = new Table({
      head: [
        center('模板'),
        center('描述'),
        center('theme'),
        center('preview_key'),
        center('port'),
        '链接',
      ],
      style: { head: ['cyan'] },
      wordWrap: true,
    })

    projects.forEach((p) => {
      const tplEnv = loadTemplateEnv(p.templateName)
      const links = buildLinks({
        domain: p.domain ?? tplEnv.domain,
        store: p.store ?? tplEnv.store,
        theme: p.theme,
        preview_key: p.previewKey,
        port: p.port,
      })
      const linksCell = [
        pc.cyan(`开发：${links.devLink}`),
        pc.green(`提测：${links.previewLink}`),
        pc.yellow(`后台：${links.adminLink}`),
        pc.magenta(`编辑：${links.editorLink}`),
      ].join('\n')
      table.push([
        center(p.templateName),
        center(p.description || '-'),
        center(p.theme),
        center(p.previewKey),
        center(String(p.port)),
        linksCell,
      ])
    })

    console.log(table.toString())
    console.log(pc.gray(`数据文件：${getProjectsFile()}`))
  },
}