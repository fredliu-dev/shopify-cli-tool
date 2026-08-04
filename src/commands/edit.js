import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { select, input } from '@inquirer/prompts'
import { storeToTemplate } from '../config.js'

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

    let theme, previewKey, port, description
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
          templateName,
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