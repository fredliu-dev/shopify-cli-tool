import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { select } from '@inquirer/prompts'
import { parse, stringify } from 'smol-toml'
import { runThemeDev } from './_theme-dev.js'
import { getPortPids, killPort } from './_port.js'

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
 * 读取模板文件
 * @param {string} templateName
 * @returns {string}
 */
function getTemplateContent(templateName) {
  const configDir = join(dirname(fileURLToPath(import.meta.url)), '../config')
  const templateFile = getTemplates().find((t) => t.name === templateName)
  if (!templateFile) {
    return ''
  }
  return readFileSync(join(configDir, templateFile.file), 'utf8')
}

/**
 * 替换模板中的值
 * @param {string} content
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function fillValue(content, key, value) {
  const re = new RegExp('^(\\s*' + key + '\\s*=\\s*)(?:"([^"]*)"|([^\\s"\\n]+))', 'm')
  const m = re.exec(content)
  if (!m) return content
  const prefix = m[1]
  const isQuoted = m[2] !== undefined
  const replacement = isQuoted
    ? '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : String(value)
  return content.slice(0, m.index) + prefix + replacement + content.slice(m.index + m[0].length)
}

/**
 * `shop use` —— 使用保存的项目配置并执行命令。
 */
export default {
  name: 'use',
  aliases: ['use'],
  description: '使用保存的项目配置并执行命令',
  usage: 'shop use',
  async run(ctx) {
    const { log } = ctx
    const projects = loadProjects()

    if (!projects.length) {
      log.error('暂无保存的项目配置，请先使用 shop add 添加')
      return
    }

    let selectedProject
    try {
      selectedProject = await select({
        message: '选择要使用的项目：',
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

    // 读取当前 shopify.theme.toml
    const configPath = join(process.cwd(), 'shopify.theme.toml')
    if (!existsSync(configPath)) {
      log.error('当前目录下未找到 shopify.theme.toml 文件')
      return
    }

    // 获取模板内容并填充值
    let content = getTemplateContent(selectedProject.templateName)
    if (!content) {
      log.error(`未找到模板：${selectedProject.templateName}`)
      return
    }

    content = fillValue(content, 'theme', selectedProject.theme)
    content = fillValue(content, 'preview_key', selectedProject.previewKey)
    content = fillValue(content, 'port', selectedProject.port)

    // 解析现有配置，保留其他环境配置
    const existingConfig = parse(readFileSync(configPath, 'utf8'))
    const newConfig = parse(content)
    
    // 合并配置，替换 dev 环境
    const mergedConfig = {
      ...existingConfig,
      environments: {
        ...existingConfig.environments,
        dev: newConfig.environments.dev,
      },
    }

    // 写入配置文件
    writeFileSync(configPath, stringify(mergedConfig), 'utf8')
    log.success('配置文件已更新')

    // 选择执行方式
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
      if (err && err.name === 'ExitPromptError') {
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