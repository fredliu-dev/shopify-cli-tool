import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { select, confirm } from '@inquirer/prompts'

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

    let selectedProject
    try {
      selectedProject = await select({
        message: '选择要删除的项目：',
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

    // 确认删除
    let confirmed
    try {
      confirmed = await confirm({
        message: `确认删除项目 "${selectedProject.templateName} - ${selectedProject.description || '无描述'}"？`,
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

    // 删除项目
    const updatedProjects = projects.filter((p) => p.id !== selectedProject.id)
    saveProjects(updatedProjects)

    log.success('项目配置已删除')
  },
}