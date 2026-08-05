import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, ensureDataDir } from './paths.js'

const DATA_DIR = userDataDir()
const PROJECTS_FILE = join(DATA_DIR, 'projects.json')

/**
 * 读取所有保存的项目。
 * @returns {Array}
 */
export function loadProjects() {
  ensureDataDir()
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
  ensureDataDir()
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8')
}

/** 数据文件路径（供调试/提示使用） */
export function getProjectsFile() {
  return PROJECTS_FILE
}
