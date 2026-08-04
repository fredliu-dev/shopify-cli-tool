import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

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
    const Table = (await import('cli-table3')).default
    const table = new Table({
      head: ['模板', '描述', 'theme', 'preview_key', 'port'],
      style: { head: ['cyan'] },
    })

    projects.forEach((p) => {
      table.push([
        p.templateName,
        p.description || '-',
        p.theme,
        p.previewKey,
        p.port,
      ])
    })

    console.log(table.toString())
  },
}