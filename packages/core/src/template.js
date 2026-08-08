/**
 * 模板占位符解析与填充。
 *
 * 占位符语法：{{@类型[数字] as 显示名}}
 *   {{@person as 张三}}     → @ 张三（输入其钉钉手机号；可在模板 defaults 里设默认值）
 *   {{@url as 预览链接}}    → 替换成链接（提测本地项目时自动用项目提测链接）
 *   {{@title as 活动名称}}  → 替换成标题（提测本地项目时自动用项目描述）
 *   {{@content as 备注}}   → 替换成自由文本（工单号/备注/需求等，提测时手输）
 *   {{@all}}                → @ 所有人
 * 规则：
 *   - 花括号内空格数量任意，不影响匹配：{{ @person1  as  复审 }} 等价于 {{@person1 as 复审}}。
 *   - `as` 后的「显示名」仅用于命令行提示展示，不参与匹配；省略时用 token 本身。
 *   - 数字后缀区分多个同类：@person / @person1 / @url1 …
 */

const PLACEHOLDER_RE = /\{\{\s*@(person|url|title|content|all)(\d*)\s*(?:as\s+(.+?))?\s*\}\}/g

/**
 * 收集模板里去重且保序的占位符。
 * @param {string} content
 * @returns {{ persons: {token:string,label:string}[], urls: {token:string,label:string}[], titles: {token:string,label:string}[], contents: {token:string,label:string}[], hasAll: boolean }}
 */
export function parsePlaceholders(content) {
  const push = (arr, token, label) => {
    if (!arr.some((p) => p.token === token)) arr.push({ token, label: label || token })
  }
  const persons = []
  const urls = []
  const titles = []
  const contents = []
  let hasAll = false
  for (const m of content.matchAll(PLACEHOLDER_RE)) {
    const type = m[1]
    const token = `@${type}${m[2] ?? ''}`
    const label = (m[3] ?? '').trim()
    if (type === 'person') push(persons, token, label)
    else if (type === 'url') push(urls, token, label)
    else if (type === 'title') push(titles, token, label)
    else if (type === 'content') push(contents, token, label)
    else hasAll = true
  }
  return { persons, urls, titles, contents, hasAll }
}

/**
 * 用运行时填入的值替换模板占位符。
 * @param {string} content 模板原文
 * @param {Record<string, string>} values 按 token 存的值（@person 存手机号，会被前置 @ 并收集到 atMobiles）
 * @returns {{ text: string, atMobiles: string[], isAtAll: boolean }}
 */
export function fillTemplate(content, values) {
  const atMobiles = []
  let isAtAll = false
  const text = content.replace(PLACEHOLDER_RE, (full, type, num) => {
    const token = `@${type}${num ?? ''}`
    if (type === 'person') {
      const phone = (values?.[token] ?? '').trim()
      if (phone) atMobiles.push(phone)
      return phone ? `@${phone}` : full
    }
    if (type === 'url' || type === 'title' || type === 'content') {
      return (values?.[token] ?? '').trim() || full
    }
    // all
    isAtAll = true
    return ''
  })
  return { text, atMobiles, isAtAll }
}
