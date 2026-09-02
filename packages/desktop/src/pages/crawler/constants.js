// 爬虫模块元数据：11 种模块的类型、名称、图标（组件引用，非 JSX 元素，保持本文件纯 JS）、
// 主题色、默认 data。node.type 与主进程 crawler-runner.js 的 MODULE_TYPES 一一对应；
// data 结构与 crawler-scripts.js 注入脚本的参数约定一致。
import {
  GlobalOutlined,
  ClockCircleOutlined,
  AimOutlined,
  EditOutlined,
  KeyOutlined,
  TableOutlined,
  ImportOutlined,
  RetweetOutlined,
  CodeOutlined,
  BranchesOutlined,
  FormOutlined,
  ExportOutlined,
  ApiOutlined,
} from '@ant-design/icons'

/** 选择器四种匹配模式（与注入脚本 findAll 的实现一致）。 */
export const SELECTOR_MODES = [
  { value: 'class', label: 'class 类名' },
  { value: 'id', label: 'id' },
  { value: 'classRegex', label: 'class 正则' },
  { value: 'css', label: 'CSS 选择器' },
]

/** 元素事件模块可触发的事件（值与注入脚本 clickScript 的 fire 实现、主进程 CLICK_EVENTS 一一对应）。 */
export const CLICK_EVENTS = [
  { value: 'click', label: '点击' },
  { value: 'dblclick', label: '双击' },
  { value: 'enter', label: '回车' },
  { value: 'focus', label: '聚焦' },
  { value: 'blur', label: '失焦' },
  { value: 'hover', label: '悬停' },
]

/** 元素事件模块触发范围：仅第一个匹配元素 / 按页面顺序依次触发全部。 */
export const CLICK_TARGETS = [
  { value: 'first', label: '仅第一个' },
  { value: 'all', label: '全部依次' },
]

/**
 * 键盘模块可按的键：value 是 Electron sendInputEvent 的 keyCode（Chromium DomKey 口径，
 * 主进程原生下发）；下拉之外也允许手输任意键名（如 F5、a）。
 */
export const KEY_EVENTS = [
  { value: 'Enter', label: '回车 Enter' },
  { value: 'Tab', label: 'Tab' },
  { value: 'Escape', label: 'Esc' },
  { value: 'Backspace', label: '退格 Backspace' },
  { value: 'Delete', label: '删除 Delete' },
  { value: 'Space', label: '空格' },
  { value: 'ArrowUp', label: '↑ 上' },
  { value: 'ArrowDown', label: '↓ 下' },
  { value: 'ArrowLeft', label: '← 左' },
  { value: 'ArrowRight', label: '→ 右' },
  { value: 'Home', label: 'Home' },
  { value: 'End', label: 'End' },
  { value: 'PageUp', label: 'PageUp' },
  { value: 'PageDown', label: 'PageDown' },
]

/** 键盘模块修饰键（sendInputEvent 的 modifiers 字段口径，可组合）。 */
export const KEY_MODIFIERS = [
  { value: 'ctrl', label: 'Ctrl' },
  { value: 'alt', label: 'Alt' },
  { value: 'shift', label: 'Shift' },
  { value: 'meta', label: 'Cmd' },
]

/** 逻辑判断的比较方式（值与主进程 crawler-runner.js 的 CONDITION_OPS 一致；unary 表示无右值）。 */
export const CONDITION_OPS = [
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'includes', label: '包含' },
  { value: 'excludes', label: '不包含' },
  { value: 'empty', label: '为空' },
  { value: 'notEmpty', label: '不为空' },
]
export const isUnaryOp = (op) => op === 'empty' || op === 'notEmpty'

export const selectorDesc = (s) => {
  if (!s?.value) return null
  const mode = SELECTOR_MODES.find((m) => m.value === s.mode)?.label || s.mode
  return `${mode}：${s.value}`
}

/** 各模块默认 data（新拖入节点用）。 */
const defaultSelector = (timeoutMs) => ({ mode: 'class', value: '', timeoutMs })

export const MODULES = {
  webpage: {
    type: 'webpage',
    name: '网页',
    icon: GlobalOutlined,
    color: '#0a84ff',
    desc: '打开要爬取的网址，作为流程起点',
    defaultData: () => ({ label: '打开网页', url: '' }),
    summary: (d) => d.url || '未配置网址',
  },
  wait: {
    type: 'wait',
    name: '等待',
    icon: ClockCircleOutlined,
    color: '#ffd60a',
    desc: '等待页面出现指定元素后再继续（id / class / 正则 / CSS）',
    defaultData: () => ({ label: '等待元素', selector: defaultSelector(10000) }),
    summary: (d) => selectorDesc(d.selector) || '未配置元素',
  },
  click: {
    type: 'click',
    name: '元素事件',
    icon: AimOutlined,
    color: '#bf5af2',
    desc: '按选择器匹配元素触发事件（点击/双击/回车/聚焦/失焦/悬停），可选仅首个或全部依次',
    defaultData: () => ({ label: '元素事件', selector: defaultSelector(5000), event: 'click', target: 'first' }),
    summary: (d) => {
      const base = selectorDesc(d.selector) || '未配置元素'
      const ev = d.event && d.event !== 'click' ? CLICK_EVENTS.find((e) => e.value === d.event)?.label : null
      const all = d.target === 'all' ? '全部' : null
      return ev || all ? `${base}（${[ev, all].filter(Boolean).join('·')}）` : base
    },
  },
  input: {
    type: 'input',
    name: '输入文本',
    icon: EditOutlined,
    color: '#64d2ff',
    desc: '向输入框填入文本（搜索框、表单）',
    defaultData: () => ({ label: '输入文本', selector: defaultSelector(5000), text: '' }),
    summary: (d) => `${selectorDesc(d.selector) || '未配置元素'}${d.text ? ` ← 「${d.text}」` : ''}`,
  },
  keyboard: {
    type: 'keyboard',
    name: '键盘按键',
    icon: KeyOutlined,
    color: '#98989d',
    desc: '向页面发送原生键盘按键（回车/Tab/方向键…），可选先聚焦某元素，支持修饰键组合与连按',
    defaultData: () => ({ label: '键盘按键', key: 'Enter', modifiers: [], repeat: 1, delayMs: 0, selector: defaultSelector(5000) }),
    summary: (d) => {
      const mods = (Array.isArray(d.modifiers) ? d.modifiers : [])
        .map((m) => KEY_MODIFIERS.find((k) => k.value === m)?.label || m)
        .join('+')
      const rep = Number(d.repeat) > 1 ? ` ×${d.repeat}` : ''
      const target = d.selector?.value ? selectorDesc(d.selector) : '当前聚焦元素'
      return `${mods ? `${mods}+` : ''}${d.key || 'Enter'}${rep} → ${target}`
    },
  },
  extract: {
    type: 'extract',
    name: '提取数据',
    icon: TableOutlined,
    color: '#30d158',
    desc: '按字段提取页面内容（文本/链接/属性），支持多条',
    defaultData: () => ({
      label: '提取数据',
      timeoutMs: 5000,
      fields: [{ name: '字段1', selector: defaultSelector(5000), extract: { type: 'text' } }],
    }),
    summary: (d) => (d.fields?.length ? `${d.fields.length} 个字段` : '未配置字段'),
  },
  intercept: {
    type: 'intercept',
    name: '接口拦截',
    icon: ApiOutlined,
    color: '#ff9f0a',
    desc: '按接口地址+传参模糊匹配，把响应内容存入变量',
    defaultData: () => ({ label: '接口拦截', url: '', param: '', varName: '接口数据', timeoutMs: 15000 }),
    summary: (d) =>
      d.url ? `匹配「${d.url}${d.param ? `？${d.param}` : ''}」→ {{${d.varName || '变量'}}}` : '未配置接口地址',
  },
  importTable: {
    type: 'importTable',
    name: '导入表格',
    icon: ImportOutlined,
    color: '#ff375f',
    desc: '读取 CSV/JSON 表格整表写入变量（数组，每行一个对象），循环交给「数据循环」',
    defaultData: () => ({ label: '导入表格', filePath: '', fileName: '', rowCount: 0, columns: [], varName: '表格数据' }),
    summary: (d) => (d.filePath ? `${d.fileName || '表格'} · ${d.rowCount || '?'} 行 → {{${d.varName || '表格数据'}}}` : '未选择表格文件'),
  },
  loop: {
    type: 'loop',
    name: '数据循环',
    icon: RetweetOutlined,
    color: '#8e8eff',
    desc: '选一个数组变量遍历循环体（字符串可按分割符拆分），体末连回本模块成环；可多进程并发分摊数据',
    defaultData: () => ({ label: '数据循环', varName: '', split: '', concurrency: 1 }),
    summary: (d) =>
      d.varName
        ? `循环 {{${d.varName}}}${d.split ? `，按「${d.split}」分割` : ''}${d.concurrency > 1 ? `，${d.concurrency} 进程并发` : ''}`
        : '未选择变量',
  },
  dataProcess: {
    type: 'dataProcess',
    name: '数据处理',
    icon: CodeOutlined,
    color: '#00c7be',
    desc: '用一段 JS 代码处理变量：代码里 value 是旧值，return 的结果作为新值写回',
    defaultData: () => ({ label: '数据处理', varName: '', code: 'return value' }),
    summary: (d) => (d.varName ? `JS 处理 {{${d.varName}}}` : '未选择变量'),
  },
  condition: {
    type: 'condition',
    name: '逻辑判断',
    icon: BranchesOutlined,
    color: '#ff453a',
    desc: '按变量比较（等于/大于/包含…），是/否两个分支分别连线',
    defaultData: () => ({ label: '逻辑判断', left: '', op: 'eq', right: '' }),
    summary: (d) => {
      const op = CONDITION_OPS.find((o) => o.value === d.op)?.label || d.op || '…'
      const lhs = d.left ? d.left : '…'
      return isUnaryOp(d.op) ? `${lhs} ${op}` : `${lhs} ${op} ${d.right || '…'}`
    },
  },
  tableEdit: {
    type: 'tableEdit',
    name: '表格编辑',
    icon: FormOutlined,
    color: '#5e5ce6',
    desc: '写入一列数据（值可用 {{变量}}），自动建表新行，供表格导出',
    defaultData: () => ({ label: '表格编辑', column: '', value: '' }),
    summary: (d) => (d.column ? `${d.column} ← ${d.value || '空'}` : '未填写列名'),
  },
  exportTable: {
    type: 'exportTable',
    name: '表格导出',
    icon: ExportOutlined,
    color: '#63e6e2',
    desc: '流程跑完后把整张表格导出到指定地址（CSV/JSON）',
    defaultData: () => ({ label: '表格导出', savePath: '', baseName: '', format: 'csv' }),
    summary: (d) =>
      d.savePath
        ? `${d.baseName || '项目名'}.${d.format === 'json' ? 'json' : 'csv'} → ${d.savePath}`
        : '未填写保存地址',
  },
}

export const MODULE_ORDER = [
  'webpage',
  'wait',
  'click',
  'input',
  'keyboard',
  'extract',
  'intercept',
  'importTable',
  'loop',
  'dataProcess',
  'condition',
  'tableEdit',
  'exportTable',
]

const isSelectorFilled = (s) => !!s && typeof s.value === 'string' && s.value.trim() !== ''

/**
 * 汇总「已定义的变量」供配置抽屉下拉选择（VariableInput 的数据源）：
 * - 静态来源（不用跑就有）：接口拦截的写入变量、提取字段名、导入表格列名、数据循环的
 *   当前项/当前序号；
 * - 运行时来源（跑过一次后更准）：Editor 消费的变量快照下钻 3 层，对象按键、数组展开
 *   首个元素——接口拦截存的大 JSON 能直接选到 接口数据.list 这种真实路径。
 * @returns {{value: string, label: string}[]} 上限 200 条（超大 JSON 防爆）
 */
export function collectVariableOptions(nodes, runtimeVars) {
  const notes = new Map()
  const add = (path, note) => {
    const p = String(path).trim()
    if (p) notes.set(p, notes.get(p) || note || '')
  }
  for (const n of nodes || []) {
    const d = n.data || {}
    if (n.type === 'intercept' && d.varName) add(d.varName, '接口拦截')
    if (n.type === 'extract') for (const f of d.fields || []) if (f.name) add(f.name, '提取字段')
    // 变量名留空时运行时默认写「表格数据」（见 crawler-runner 的 importTable 分支），
    // 这里保持同样兜底——老项目没存 varName 字段时下拉框才不会漏掉表格变量
    if (n.type === 'importTable') add(String(d.varName || '').trim() || '表格数据', '导入表格·整表数组')
    if (n.type === 'loop') {
      add('当前项', '数据循环')
      add('当前序号', '数据循环')
      // 配了「当前项另存为变量」的循环：嵌套时用它区分内外层的当前项
      if (d.itemVar) add(d.itemVar, '数据循环·当前项')
    }
    // 数据处理配了「结果另存为新变量」：处理结果会写入它（原变量不变），下拉里可选
    if (n.type === 'dataProcess' && d.outputVar) add(String(d.outputVar).trim(), '数据处理·结果变量')
  }
  // 静态声明（画布上配出来的）先落 map，之后 runtime 快照新增的才是纯运行时条目
  const staticKeys = new Set(notes.keys())
  const walk = (path, val, depth) => {
    if (val === null || val === undefined || notes.size > 200) return
    if (Array.isArray(val)) {
      add(path, '数组')
      if (val.length > 0) walk(`${path}.0`, val[0], depth + 1)
      return
    }
    if (typeof val === 'object') {
      for (const k of Object.keys(val)) walk(`${path}.${k}`, val[k], depth + 1)
      return
    }
    add(path, typeof val === 'number' ? '数字' : '文本')
  }
  if (runtimeVars && typeof runtimeVars === 'object') {
    for (const [k, v] of Object.entries(runtimeVars)) walk(k, v, 0)
  }
  const opts = [...notes.entries()].map(([value, note]) => ({
    value,
    label: note ? `${value}（${note}）` : value,
    // runtime: true = 只在运行快照里出现（静态画布没声明过），同名校验时对本节点自己
    // 写入的结果变量不误报；nodeId = 声明该结果变量的数据处理节点（自己声明的不算冲突）
    runtime: staticKeys.has(value) ? undefined : true,
  }))
  for (const n of nodes || []) {
    if (n.type === 'dataProcess' && n.data?.outputVar) {
      const hit = opts.find((o) => o.value === String(n.data.outputVar).trim())
      if (hit && hit.nodeId === undefined) hit.nodeId = n.id
    }
  }
  return opts
}

/**
 * 渲染层必填轻校验（权威校验在主进程 crawler-runner.js 的 validateNode，规则保持镜像）：
 * 返回缺失项文案（null = 通过）。用于运行按钮禁用与画布节点红色闪烁提醒。
 */
export function requiredMissing(node) {
  const d = node.data || {}
  switch (node.type) {
    case 'webpage': {
      const url = (d.url || '').trim()
      if (!url) return '未填写网址'
      if (!/^https?:\/\//i.test(url)) return '网址必须以 http:// 或 https:// 开头'
      return null
    }
    case 'wait':
    case 'click':
      return isSelectorFilled(d.selector) ? null : '未填写元素选择器'
    case 'input':
      if (!isSelectorFilled(d.selector)) return '未填写元素选择器'
      if (!d.text) return '未填写要输入的文本'
      return null
    case 'keyboard':
      return String(d.key ?? '').trim() ? null : '未选择按键'
    case 'extract': {
      const fields = d.fields || []
      if (fields.length === 0) return '至少配置一个提取字段'
      for (const f of fields) {
        if (!isSelectorFilled(f.selector)) return `字段「${f.name || '未命名'}」未填写选择器`
      }
      return null
    }
    case 'intercept':
      if (!String(d.url ?? '').trim()) return '未填写接口地址'
      if (!String(d.varName ?? '').trim()) return '未填写写入变量名'
      return null
    case 'importTable':
      return d.filePath ? null : '未选择表格文件'
    case 'loop':
      return String(d.varName ?? '').trim() ? null : '未填写要循环的变量'
    case 'dataProcess':
      if (!String(d.varName ?? '').trim()) return '未填写要处理的变量'
      return String(d.code ?? '').trim() ? null : '未填写处理代码'
    case 'condition':
      if (!d.op) return '未选择比较方式'
      if (String(d.left ?? '').trim() === '') return '未填写左值'
      if (!isUnaryOp(d.op) && String(d.right ?? '').trim() === '') return '未填写右值'
      return null
    case 'tableEdit':
      return String(d.column ?? '').trim() ? null : '未填写列名'
    case 'exportTable':
      return String(d.savePath ?? '').trim() ? null : '未填写保存地址'
    default:
      return null
  }
}
