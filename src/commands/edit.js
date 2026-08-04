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

    let template, theme, previewKey, port, description
    try {
      const templates = getTemplates()
      template = await select({
        message: '选择模板：',
        choices: templates.map((t) => ({ name: t.name, value: t })),
        default: templates.find((t) => t.name === selectedProject.templateName),
      })

      theme = await input({
        message: '请输入 theme：',
        default: selectedProject.theme,
        validate: (v) => (v.trim() ? true : '不能为空'),
      })

      previewKey = await input({
        message: '请输入 preview_key：',
        default: selectedProject.previewKey,
        validate: (v) => (v.trim() ? true : '不能为空'),
      })

      port = await input({
        message: '请输入 port：',
        default: selectedProject.port,
        validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字'),
      })

      description = await input({
        message: '请输入描述：',
        default: selectedProject.description,
      })
    } catch (err) {
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // 更新项目
    const updatedProjects = projects.map((p) => {
      if (p.id === selectedProject.id) {
        return {
          ...p,
          templateName: template.name,
          theme: theme.trim(),
          previewKey: previewKey.trim(),
          port: port.trim(),
          description: description.trim(),
        }
      }
      return p
    })

    saveProjects(updatedProjects)
    log.success('项目配置已更新')
  },
}