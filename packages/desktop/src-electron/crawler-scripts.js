// 注入目标页面的 executeJavaScript 脚本模板：每导出一个函数返回一段 IIFE 字符串，
// 参数用 JSON.stringify 拼进脚本（目标页 contextIsolation，无法直接传函数）。
// 三种选择器模式（与渲染层 SelectorInput 的约定一致）：
//   id         → el.id === value
//   class      → el.classList.contains(value)（精确 token，classList 对 SVG 也安全）
//   classRegex → new RegExp(value).test(el.getAttribute('class'))
// 查找穿透 open 型 shadow root 与同源 iframe（DFS 全树）：新版 Polaris（s-* 自定义
// 元素）大量使用 shadow DOM，主文档的 getElementById/querySelector 看不见里面的元素
// ——「页面上明明有却等不到」多半是它。closed shadow root 外部无法访问，仍不可见。

/** 页内共用工具：三种模式的查找 + shadow DOM/iframe 穿透（注入脚本里的字符串常量，供各脚本内联）。 */
const HELPERS = `
  const matchEl = (el, spec) => {
    if (spec.mode === 'id') return el.id === spec.value
    if (spec.mode === 'class') return !!el.classList && el.classList.contains(spec.value)
    return spec.re.test(el.getAttribute('class') || '')
  }
  const findAll = (spec) => {
    if (!spec || !spec.value) return []
    const s = spec.mode === 'classRegex' ? { ...spec, re: new RegExp(spec.value) } : spec
    const out = []
    const seen = new Set()
    const collect = (root) => {
      if (!root || seen.has(root)) return
      seen.add(root)
      let els
      try { els = root.querySelectorAll('*') } catch { return }
      for (const el of els) {
        if (matchEl(el, s)) out.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
        if (el.tagName === 'IFRAME') {
          try { if (el.contentDocument) collect(el.contentDocument) } catch { /* 跨域 iframe 不可访问 */ }
        }
      }
    }
    collect(document)
    return out
  }
  const findEl = (spec) => findAll(spec)[0] || null
  const specDesc = (spec) => (spec.mode === 'classRegex' ? 'class 正则' : spec.mode) + ' "' + spec.value + '"'
`

/** 等待元素出现：200ms 轮询，超时 reject。 */
export function waitScript(selector, timeoutMs) {
  return `(() => {${HELPERS}
    const spec = ${JSON.stringify(selector)}
    const timeoutMs = ${Number(timeoutMs) || 10000}
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        const el = findEl(spec)
        if (el) return resolve(true)
        if (Date.now() > deadline) return reject(new Error('等待元素超时(' + Math.round(timeoutMs / 1000) + 's)：' + specDesc(spec) + ' 未出现（已穿透 shadow DOM 与 iframe 查找）'))
        setTimeout(tick, 200)
      }
      tick()
    })
  })()`
}

/** 点击元素：短轮询查找（复用 timeoutMs 上限）→ 滚入视口 → click，同步返回。 */
export function clickScript(selector, timeoutMs) {
  return `(() => {${HELPERS}
    const spec = ${JSON.stringify(selector)}
    const timeoutMs = ${Number(timeoutMs) || 5000}
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        const el = findEl(spec)
        if (el) {
          el.scrollIntoView({ block: 'center' })
          el.click()
          return resolve(true)
        }
        if (Date.now() > deadline) return reject(new Error('点击失败：未找到元素 ' + specDesc(spec)))
        setTimeout(tick, 200)
      }
      tick()
    })
  })()`
}

/** 输入文本：React/Vue 受控组件兼容——原生 setter 赋值 + 派发 input/change 事件。 */
export function inputScript(selector, text, timeoutMs) {
  return `(() => {${HELPERS}
    const spec = ${JSON.stringify(selector)}
    const text = ${JSON.stringify(text ?? '')}
    const timeoutMs = ${Number(timeoutMs) || 5000}
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        const el = findEl(spec)
        if (el) {
          if (el.isContentEditable) {
            el.textContent = text
            el.dispatchEvent(new Event('input', { bubbles: true }))
          } else {
            const proto = el.__proto__?.constructor?.prototype
            const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set
            if (setter) setter.call(el, text)
            else el.value = text
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
          return resolve(true)
        }
        if (Date.now() > deadline) return reject(new Error('输入失败：未找到元素 ' + specDesc(spec)))
        setTimeout(tick, 200)
      }
      tick()
    })
  })()`
}

/**
 * 提取数据：每个字段独立 findAll，行数取各字段命中最大值，第 i 行取各字段第 i 个命中
 * （缺失 null）——同一选择器命中 N 个元素自然产出 N 行。全部字段 0 命中 reject（防垃圾行）。
 * @returns {Promise<{rows: Array<Object>, fields: string[]}>}
 */
export function extractScript(fields, timeoutMs) {
  return `(() => {${HELPERS}
    const fields = ${JSON.stringify(fields)}
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ${Number(timeoutMs) || 5000}
      const run = () => {
        const cols = fields.map((f) => {
          const hits = findAll(f.selector).map((el) => {
            if (f.extract?.type === 'text') return (el.innerText || '').trim()
            if (f.extract?.type === 'href') return el.href ?? ''
            return el.getAttribute(f.extract?.attr || '') ?? ''
          })
          return { name: f.name || f.selector.value, hits }
        })
        const total = cols.reduce((s, c) => s + c.hits.length, 0)
        if (total === 0) {
          if (Date.now() > deadline) return reject(new Error('提取失败：所有字段的选择器均未命中元素'))
          return setTimeout(run, 200)
        }
        const rowCount = Math.max(1, ...cols.map((c) => c.hits.length))
        const rows = Array.from({ length: rowCount }, (_, i) =>
          Object.fromEntries(cols.map((c) => [c.name, c.hits[i] ?? null])))
        resolve({ rows, fields: cols.map((c) => c.name) })
      }
      run()
    })
  })()`
}
