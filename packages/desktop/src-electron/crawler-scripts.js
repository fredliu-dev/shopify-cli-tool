// 注入目标页面的 executeJavaScript 脚本模板：每导出一个函数返回一段 IIFE 字符串，
// 参数用 JSON.stringify 拼进脚本（目标页 contextIsolation，无法直接传函数）。
// 四种选择器模式（与渲染层 SelectorInput 的约定一致）：
//   id         → el.id === value
//   class      → el.classList.contains(value)（精确 token，classList 对 SVG 也安全）
//   classRegex → new RegExp(value).test(el.getAttribute('class'))
//   css        → root.querySelectorAll(value)（标准 CSS 语法，含 #id/.class/[属性] 模糊匹配）
// 查找穿透 open 型 shadow root 与同源 iframe（DFS 全树）：新版 Polaris（s-* 自定义
// 元素）大量使用 shadow DOM，主文档的 getElementById/querySelector 看不见里面的元素
// ——「页面上明明有却等不到」多半是它。closed shadow root 外部无法访问，仍不可见。

/** 页内共用工具：四种模式的查找 + shadow DOM/iframe 穿透（注入脚本里的字符串常量，供各脚本内联）。 */
const HELPERS = `
  const matchEl = (el, spec) => {
    if (spec.mode === 'id') return el.id === spec.value
    if (spec.mode === 'class') return !!el.classList && el.classList.contains(spec.value)
    return spec.re.test(el.getAttribute('class') || '')
  }
  const findAll = (spec) => {
    if (!spec || !spec.value) return []
    const s = spec.mode === 'classRegex' ? { ...spec, re: new RegExp(spec.value) } : spec
    const css = spec.mode === 'css'
    const out = []
    const seen = new Set()
    const collect = (root) => {
      if (!root || seen.has(root)) return
      seen.add(root)
      let hits
      let els
      try {
        // css 模式两个查询都做：querySelectorAll 取命中，'*' 保证仍遍历每个元素下钻
        // shadow root / iframe（否则未命中的 shadow 宿主会被跳过，漏掉里面的匹配）
        hits = css ? new Set(root.querySelectorAll(spec.value)) : null
        els = root.querySelectorAll('*')
      } catch { return }
      for (const el of els) {
        if (css ? hits.has(el) : matchEl(el, s)) out.push(el)
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
  const MODE_LABELS = { id: 'id', class: 'class', classRegex: 'class 正则', css: 'CSS 选择器' }
  const specDesc = (spec) => (MODE_LABELS[spec.mode] || spec.mode) + ' "' + spec.value + '"'
`

/**
 * 等待元素出现：一次性检查（同步返回布尔，页内不等待）。轮询由主进程 pollPage 驱动——
 * 登录校验等页面跳转会杀死页内长驻脚本（executeJavaScript 随之永不 settle，整段等待僵死），
 * 改成单次检查后跳转最多损失一轮，跳回原页面后下一轮照常命中。
 */
export function waitScript(selector) {
  return `(() => {${HELPERS}
    const spec = ${JSON.stringify(selector)}
    return !!findEl(spec)
  })()`
}

/**
 * 页面稳定性签名（提取数据前的稳定等待用）：null = 文档还在加载；否则返回 DOM 规模
 * 签名（元素数 + HTML 字符量）。主进程连续两轮签名一致即认为渲染稳定——翻页/跳转后
 * 新内容没渲染完时签名会持续变化，旧页卸载中拿到的签名下一轮也会对不上。
 */
export function stableScript() {
  return `(() => {
    if (document.readyState !== 'complete') return null
    return document.getElementsByTagName('*').length + ':' + document.documentElement.outerHTML.length
  })()`
}

/**
 * 选择器诊断（等待元素超时时用同一个值把四种模式各试一遍）：返回 { id, class,
 * classRegex, css } 各模式命中数（-1 = 表达式非法）。元素明明在页面上却等不到，
 * 多半是模式选错了（id 写成 class 正则这类）——报错里直接告诉用户换哪种模式能命中。
 */
export function diagnoseScript(value) {
  return `(() => {${HELPERS}
    const v = ${JSON.stringify(value)}
    const count = (mode) => { try { return findAll({ mode, value: v }).length } catch { return -1 } }
    return { id: count('id'), class: count('class'), classRegex: count('classRegex'), css: count('css') }
  })()`
}

/** 选择器描述文案（主进程侧超时报错用，与页内 specDesc 保持一致）。 */
export function selectorDesc(spec) {
  const labels = { id: 'id', class: 'class', classRegex: 'class 正则', css: 'CSS 选择器' }
  return `${labels[spec?.mode] || spec?.mode || 'class'} "${spec?.value ?? ''}"`
}

/**
 * 触发元素事件：短轮询查找（复用 timeoutMs 上限）后按 event 逐个触发。
 * event 与渲染层 CLICK_EVENTS 对应：click/dblclick/enter/focus/blur/hover。
 * target：first 仅第一个命中；all 按页面顺序全部依次（间隔 ~120ms 让页面来得及响应）。
 * 解析为触发的元素个数（主进程摘要用）。兼容旧数据：event 缺省 click、target 缺省 first。
 */
export function clickScript(selector, event, target, timeoutMs) {
  return `(() => {${HELPERS}
    const spec = ${JSON.stringify(selector)}
    const event = ${JSON.stringify(event || 'click')}
    const target = ${JSON.stringify(target || 'first')}
    const timeoutMs = ${Number(timeoutMs) || 5000}
    const mouse = { bubbles: true, cancelable: true, view: window }
    const fire = (el) => {
      if (event === 'focus') { el.scrollIntoView?.({ block: 'center' }); el.focus?.(); return }
      if (event === 'blur') { el.blur?.(); return }
      if (event === 'hover') {
        el.scrollIntoView?.({ block: 'center' })
        el.dispatchEvent(new MouseEvent('mouseover', mouse))
        el.dispatchEvent(new MouseEvent('mouseenter', { cancelable: true }))
        return
      }
      if (event === 'enter') {
        el.scrollIntoView?.({ block: 'center' }); el.focus?.()
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
        el.dispatchEvent(new KeyboardEvent('keydown', key))
        el.dispatchEvent(new KeyboardEvent('keypress', key))
        el.dispatchEvent(new KeyboardEvent('keyup', key))
        return
      }
      // click / dblclick：pointer+mouse 序列铺路（框架常监听 mousedown/pointerdown），最后
      // 用原生 el.click() 收尾——派发的合成 click 不会触发 a 链接跳转/表单提交，原生才行
      el.scrollIntoView?.({ block: 'center' })
      const press = () => {
        el.dispatchEvent(new PointerEvent('pointerdown', mouse))
        el.dispatchEvent(new MouseEvent('mousedown', mouse))
        el.dispatchEvent(new PointerEvent('pointerup', mouse))
        el.dispatchEvent(new MouseEvent('mouseup', mouse))
        el.click()
      }
      press()
      if (event === 'dblclick') {
        press()
        el.dispatchEvent(new MouseEvent('dblclick', mouse))
      }
    }
    if (spec.mode === 'css') {
      try { document.querySelectorAll(spec.value) } catch {
        return Promise.reject(new Error('CSS 选择器语法错误：' + spec.value))
      }
    }
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const run = async (els) => {
        for (let i = 0; i < els.length; i++) {
          fire(els[i])
          if (i < els.length - 1) await new Promise((r) => setTimeout(r, 120))
        }
        resolve(els.length)
      }
      const tick = () => {
        const hits = findAll(spec)
        if (hits.length) {
          run(target === 'all' ? hits : [hits[0]])
          return
        }
        if (Date.now() > deadline) return reject(new Error('触发失败：未找到元素 ' + specDesc(spec)))
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
 * 提取数据（一次性，页内不等待）：每个字段独立 findAll，行数取各字段命中最大值，第 i 行
 * 取各字段第 i 个命中（缺失 null）——同一选择器命中 N 个元素自然产出 N 行。全部字段
 * 0 命中返回 null（主进程 pollPage 在超时内反复注入重试，页面跳转后新页面同样能提取）。
 * @returns {string} 脚本：求值为 {rows: Array<Object>, fields: string[]} | null
 */
export function extractScript(fields) {
  return `(() => {${HELPERS}
    const fields = ${JSON.stringify(fields)}
    const cols = fields.map((f) => {
      const hits = findAll(f.selector).map((el) => {
        if (f.extract?.type === 'text') return (el.innerText || '').trim()
        if (f.extract?.type === 'href') return el.href ?? ''
        return el.getAttribute(f.extract?.attr || '') ?? ''
      })
      return { name: f.name || f.selector.value, hits }
    })
    if (cols.every((c) => c.hits.length === 0)) return null
    const rowCount = Math.max(1, ...cols.map((c) => c.hits.length))
    const rows = Array.from({ length: rowCount }, (_, i) =>
      Object.fromEntries(cols.map((c) => [c.name, c.hits[i] ?? null])))
    return { rows, fields: cols.map((c) => c.name) }
  })()`
}
