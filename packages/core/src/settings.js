/**
 * 通用 GUI 偏好持久化（headless）：存到 userDataDir()/settings.json。
 * 当前用于桌面客户端「上次选择的工作区文件夹」(workspaceDir)，后续可扩展更多键。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, ensureDataDir } from './paths.js'

const DATA_DIR = userDataDir()
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

/**
 * 读取设置。文件缺失或解析失败返回 {}。
 * @returns {Record<string, any>}
 */
export function loadSettings() {
  ensureDataDir()
  if (!existsSync(SETTINGS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 合并写入设置（浅合并），返回合并后的完整对象。
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
export function saveSettings(patch) {
  ensureDataDir()
  const next = { ...loadSettings(), ...patch }
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 设置文件路径（供调试/提示使用） */
export function getSettingsFile() {
  return SETTINGS_FILE
}
