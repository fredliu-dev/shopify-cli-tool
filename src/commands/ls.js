import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { parse } from 'smol-toml'
import pc from 'picocolors'
import { buildLinks } from '../links.js'

const PROJECTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../projects')
const PROJECTS_FILE = join(PROJECTS_DIR, 'projects.json')

/**
 * 确保项目存储目录存在
 */
function ensureProjectsDir() {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true })
  }
}

/**
 * 读取所有保存的项目
 * @returns {Array}
 */
function loadProjects() {
  ensureProjectsDir()
  if (!existsSync(PROJECTS_FILE)) {
    return []
  }
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
  } catch {
    return []
  }
}

/**
 * 读取模板的 dev 环境配置（用于补 domain / store，projects.json 里没存这两个）。
 * @param {string} templateName
 * @returns {Record<string, string|number>}
 */
function loadTemplateEnv(templateName) {
  const configDir = join(dirname(fileURLToPath(import.meta.url)), '../config')
  let files = []
  try {
    files = readdirSync(configDir)
  } catch {
    return {}
  }
  const file = files.find((f) => f.endsWith('.toml') && f.split('.')[0] === templateName)
  if (!file) return {}
  try {
    return parse(readFileSync(join(configDir, file), 'utf8')).environments?.dev ?? {}
  } catch {
    return {}
  }
}

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
  },
}