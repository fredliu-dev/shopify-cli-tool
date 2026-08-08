/**
 * 人员配置持久化（headless）：存到 userDataDir()/contacts.json。
 * 实体 { id, name, phone }。用于把桌面端所有「与人有关」的输入位（主题命名的「负责人」
 * 取姓名、提测消息 {{@person}} 取手机号）变成下拉。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { userDataDir, ensureDataDir } from './paths.js'

const DATA_DIR = userDataDir()
const CONTACTS_FILE = join(DATA_DIR, 'contacts.json')

/**
 * 读取全部人员。文件缺失或解析失败返回 []。
 * @returns {{ id: string, name: string, phone: string }[]}
 */
export function loadContacts() {
  ensureDataDir()
  if (!existsSync(CONTACTS_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * 整表写入人员列表。
 * @param {Array} contacts
 */
export function saveContacts(contacts) {
  ensureDataDir()
  writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8')
}

/** 配置文件路径（供调试/提示使用） */
export function getContactsFile() {
  return CONTACTS_FILE
}

/**
 * 新增或更新一名人员（无 id=新增，有 id=更新）。
 * @param {{ id?: string, name: string, phone: string }} data
 * @returns {{ id: string, name: string, phone: string }} 新增/更新后的完整实体
 */
export function upsertContact(data) {
  const contacts = loadContacts()
  const now = { name: (data.name ?? '').trim(), phone: (data.phone ?? '').trim() }
  if (data.id) {
    const idx = contacts.findIndex((c) => c.id === data.id)
    if (idx >= 0) {
      contacts[idx] = { ...contacts[idx], ...now }
      saveContacts(contacts)
      return contacts[idx]
    }
  }
  const created = { id: randomUUID(), ...now }
  contacts.push(created)
  saveContacts(contacts)
  return created
}

/**
 * 按 id 删除一名人员。
 * @param {string} id
 */
export function removeContact(id) {
  const contacts = loadContacts().filter((c) => c.id !== id)
  saveContacts(contacts)
}
