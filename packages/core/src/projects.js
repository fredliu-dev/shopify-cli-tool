import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, ensureDataDir } from './paths.js'
import { storeToTemplate } from './config.js'

const DATA_DIR = userDataDir()
const PROJECTS_FILE = join(DATA_DIR, 'projects.json')

/**
 * 读取所有保存的项目。
 * 历史项目可能未记录 templateName（保存时模板库还反查不到对应 store 的模板），读取时按
 * store 反查回填，让各消费方（use/edit 列表、桌面端、切分支重建）统一拿到模板名，
 * 不必各自兜底「templateName 缺失降级显示域名」。仅内存回填不落盘；后续任意
 * saveProjects 会把回填值一并持久化（自愈）。反查不到仍为 null，消费方自行降级。
 * @returns {Array}
 */
export function loadProjects() {
  ensureDataDir()
  if (!existsSync(PROJECTS_FILE)) return []
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf8')).map((p) =>
      p && !p.templateName && p.store ? { ...p, templateName: storeToTemplate(p.store) ?? null } : p
    )
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
