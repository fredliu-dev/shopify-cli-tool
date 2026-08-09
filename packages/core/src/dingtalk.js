import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import { userDataDir, ensureDataDir } from './paths.js'

const DATA_DIR = userDataDir()
const DINGTALK_FILE = join(DATA_DIR, 'dingtalk.json')

function emptyConfig() {
  return { groups: [], templates: [] }
}

/**
 * 读取钉钉配置（{ groups, templates }）。
 * 兼容旧版单群结构 { webhook, secret }：自动迁移成 groups[0]，不丢失已配的 webhook。
 * @returns {{ groups: Array, templates: Array }}
 */
export function loadDingtalkConfig() {
  ensureDataDir()
  if (!existsSync(DINGTALK_FILE)) return emptyConfig()
  let raw
  try {
    raw = JSON.parse(readFileSync(DINGTALK_FILE, 'utf8'))
  } catch {
    return emptyConfig()
  }
  if (!raw || typeof raw !== 'object') return emptyConfig()

  // 旧版单群结构 → 迁移为 groups[0]
  if (raw.webhook && !raw.groups) {
    return {
      groups: [{ id: 'migrated', name: '默认群', webhook: raw.webhook, secret: raw.secret ?? '' }],
      templates: [],
    }
  }
  return {
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    templates: Array.isArray(raw.templates) ? raw.templates : [],
  }
}

/**
 * 保存钉钉配置。
 * @param {{ groups: Array, templates: Array }} cfg
 */
export function saveDingtalkConfig(cfg) {
  ensureDataDir()
  writeFileSync(DINGTALK_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

/** 配置文件路径（供调试/提示使用） */
export function getDingtalkFile() {
  return DINGTALK_FILE
}

/**
 * 钉钉加签：sign = base64( hmacSHA256(secret, `${timestamp}\n${secret}`) )，再 URL 编码。
 * @param {string} secret
 * @param {number} timestamp 毫秒时间戳
 * @returns {string}
 */
function sign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return encodeURIComponent(hmac)
}

/**
 * 发送一条文本消息到钉钉群机器人。
 * @param {string} text 消息内容
 * @param {{ webhook: string, secret?: string }} cfg
 * @param {{ atMobiles?: string[], isAtAll?: boolean }} [at] @ 配置：手机号列表 / 是否 @ 所有人
 * @returns {Promise<string>} 成功返回钉钉的 errmsg（通常为 "ok"）
 * @throws {Error} 网络/HTTP 错误，或钉钉返回 errcode !== 0（带 errmsg）
 */
export async function sendText(text, { webhook, secret }, at = {}) {
  if (!webhook) throw new Error('未配置 webhook 地址')

  // 拼接最终请求地址（加签模式需附加 timestamp + sign）
  let url = webhook
  if (secret) {
    const timestamp = Date.now()
    url += `${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign(secret, timestamp)}`
  }

  // @ 处理：钉钉要求 text.content 里出现 @手机号 才会高亮/提醒。
  // 未出现在文本中的手机号，以 @<手机号> 追加到末尾。
  const atMobiles = (at.atMobiles ?? []).map((m) => String(m).trim()).filter(Boolean)
  const isAtAll = !!at.isAtAll
  let content = text
  for (const m of atMobiles) {
    const tag = `@${m}`
    if (!content.includes(tag)) content += ` ${tag}`
  }

  const payload = { msgtype: 'text', text: { content } }
  if (atMobiles.length || isAtAll) {
    payload.at = { atMobiles, isAtAll }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  let body = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应，下面按 HTTP 状态处理
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${body ? `：${JSON.stringify(body)}` : ''}`)
  }
  if (body && typeof body === 'object' && 'errcode' in body && body.errcode !== 0) {
    throw new Error(`钉钉返回错误 errcode=${body.errcode}：${body.errmsg ?? '未知错误'}`)
  }
  return body?.errmsg ?? 'ok'
}

/* ---------------- 单条 CRUD（供桌面端群/模板管理） ---------------- */

/**
 * 新增或更新一个通知群（无 id=新增，有 id=更新）。
 * @param {{ id?: string, name: string, webhook: string, secret?: string }} data
 * @returns {object} 新增/更新后的完整群实体
 */
export function upsertDingtalkGroup(data) {
  const cfg = loadDingtalkConfig()
  const now = {
    name: (data.name ?? '').trim(),
    webhook: (data.webhook ?? '').trim(),
    secret: (data.secret ?? '').trim(),
  }
  if (data.id) {
    const idx = cfg.groups.findIndex((g) => g.id === data.id)
    if (idx >= 0) {
      cfg.groups[idx] = { ...cfg.groups[idx], ...now }
      saveDingtalkConfig(cfg)
      return cfg.groups[idx]
    }
  }
  const created = { id: randomUUID(), ...now }
  cfg.groups.push(created)
  saveDingtalkConfig(cfg)
  return created
}

/**
 * 按 id 删除一个通知群。
 * @param {string} id
 */
export function removeDingtalkGroup(id) {
  const cfg = loadDingtalkConfig()
  cfg.groups = cfg.groups.filter((g) => g.id !== id)
  saveDingtalkConfig(cfg)
}

/**
 * 新增或更新一条消息模板（无 id=新增，有 id=更新）。
 * 桌面端只编辑 name/content，**务必透传保留模板已有的 defaults**（CLI gotest 占位符默认值），
 * 避免编辑模板后 defaults 被清空。
 * @param {{ id?: string, name: string, content: string, defaults?: object }} data
 * @returns {object} 新增/更新后的完整模板实体
 */
export function upsertDingtalkTemplate(data) {
  const cfg = loadDingtalkConfig()
  const now = { name: (data.name ?? '').trim(), content: data.content ?? '' }
  if (data.defaults !== undefined) now.defaults = data.defaults
  if (data.id) {
    const idx = cfg.templates.findIndex((t) => t.id === data.id)
    if (idx >= 0) {
      const prev = cfg.templates[idx]
      const merged = { ...prev, ...now }
      // 本次未提供 defaults 时，保留旧值（不被 undefined 覆盖）
      if (data.defaults === undefined && prev.defaults !== undefined) merged.defaults = prev.defaults
      cfg.templates[idx] = merged
      saveDingtalkConfig(cfg)
      return cfg.templates[idx]
    }
  }
  const created = { id: randomUUID(), ...now }
  cfg.templates.push(created)
  saveDingtalkConfig(cfg)
  return created
}

/**
 * 按 id 删除一条消息模板。
 * @param {string} id
 */
export function removeDingtalkTemplate(id) {
  const cfg = loadDingtalkConfig()
  cfg.templates = cfg.templates.filter((t) => t.id !== id)
  saveDingtalkConfig(cfg)
}

/**
 * 设置某模板的占位符默认值（CLI gotest 的 @person 默认手机号）。
 * defaults 为非空对象时写入，否则删除该键（用于清除）。桌面端「保存/清除默认值」共用。
 * @param {string} id 模板 id
 * @param {Record<string, string>} defaults token -> 值（@person 存手机号，兼容 CLI 的「手机号（姓名）」）
 * @returns {object|null} 更新后的模板，找不到返回 null
 */
export function setDingtalkTemplateDefaults(id, defaults) {
  const cfg = loadDingtalkConfig()
  const idx = cfg.templates.findIndex((t) => t.id === id)
  if (idx < 0) return null
  if (defaults && Object.keys(defaults).length) cfg.templates[idx].defaults = defaults
  else delete cfg.templates[idx].defaults
  saveDingtalkConfig(cfg)
  return cfg.templates[idx]
}
