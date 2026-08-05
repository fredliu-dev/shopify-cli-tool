import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'shopify-cli-tool'

/**
 * 用户数据目录（位于包之外，更新/重装包都不会丢失）。
 *   Windows: %APPDATA%/shopify-cli-tool
 *   其它:    ${XDG_CONFIG_HOME:-~/.config}/shopify-cli-tool
 */
function userDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_NAME)
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_NAME)
}

const DATA_DIR = userDataDir()
const PROJECTS_FILE = join(DATA_DIR, 'projects.json')

/** 确保数据目录存在 */
function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * 读取所有保存的项目。
 * @returns {Array}
 */
export function loadProjects() {
  ensureDir()
  if (!existsSync(PROJECTS_FILE)) return []
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
  } catch {
    return []
  }
}

/**
 * 保存项目到文件。
 * @param {Array} projects
 */
export function saveProjects(projects) {
  ensureDir()
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8')
}

/** 数据文件路径（供调试/提示使用） */
export function getProjectsFile() {
  return PROJECTS_FILE
}
