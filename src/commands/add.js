import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { select, input } from '@inquirer/prompts'

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
 * 保存项目到文件
 * @param {Array} projects
 */
function saveProjects(projects) {
  ensureProjectsDir()
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8')
}

/**
 * 获取模板列表（从 src/config/ 目录）
 * @returns {{ file: string, name: string }[]}
 */
function getTemplates() {
  const configDir = join(dirname(fileURLToPath(import.meta.url)), '../config')
  return readdirSync(configDir)
    .filter((f) => f.endsWith('.toml'))
    .map((f) => ({ file: f, name: f.split('.')[0] }))
}

/**
 * `shop add` —— 添加项目配置到本地保存。
 */
export default {
  name: 'add',
  aliases: ['add'],
  description: '添加项目配置到本地保存',
  usage: 'shop add',
  async run({ log }) {
    const templates = getTemplates()
    if (!templates.length) {
      log.error('未找到任何模板（src/config/*.toml）')
      return
    }

    let template, theme, previewKey, port, description
    try {
      template = await select({
        message: '选择模板：',
        choices: templates.map((t) => ({ name: t.name, value: t })),
      })

      theme = await input({
        message: '请输入 theme：',
        validate: (v) => (v.trim() ? true : '不能为空'),
      })

      previewKey = await input({
        message: '请输入 preview_key：',
        validate: (v) => (v.trim() ? true : '不能为空'),
      })

      port = await input({
        message: '请输入 port：',
        default: '9292',
        validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字'),
      })

      description = await input({
        message: '请输入描述：',
        default: '',
      })
    } catch (err) {
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    const projects = loadProjects()
    const newProject = {
      id: Date.now().toString(),
      templateName: template.name,
      theme: theme.trim(),
      previewKey: previewKey.trim(),
      port: port.trim(),
      description: description.trim(),
    }

    projects.push(newProject)
    saveProjects(projects)

    log.success('项目配置已保存')
  },
}