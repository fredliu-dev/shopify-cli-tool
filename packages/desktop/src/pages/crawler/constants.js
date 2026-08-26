// 爬虫模块元数据：10 种模块的类型、名称、图标（组件引用，非 JSX 元素，保持本文件纯 JS）、
// 主题色、默认 data。node.type 与主进程 crawler-runner.js 的 MODULE_TYPES 一一对应；
// data 结构与 crawler-scripts.js 注入脚本的参数约定一致。
import {
  GlobalOutlined,
  ClockCircleOutlined,
  AimOutlined,
  EditOutlined,
  TableOutlined,
  ImportOutlined,
  BranchesOutlined,
  FormOutlined,
  ExportOutlined,
  ApiOutlined,
} from '@ant-design/icons'

/** 选择器三种匹配模式（与注入脚本 findAll 的实现一致）。 */
export const SELECTOR_MODES = [
  { value: 'class', label: 'class 类名' },
  { value: 'id', label: 'id' },
  { value: 'classRegex', label: 'class 正则' },
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
    color: '#1677ff',
    desc: '打开要爬取的网址，作为流程起点',
    defaultData: () => ({ label: '打开网页', url: '' }),
    summary: (d) => d.url || '未配置网址',
  },
  wait: {
    type: 'wait',
    name: '等待',
    icon: ClockCircleOutlined,
    color: '#faad14',
    desc: '等待页面出现指定元素后再继续（id / class / 正则）',
    defaultData: () => ({ label: '等待元素', selector: defaultSelector(10000) }),
    summary: (d) => selectorDesc(d.selector) || '未配置元素',
  },
  click: {
    type: 'click',
    name: '点击',
    icon: AimOutlined,
    color: '#722ed1',
    desc: '点击指定元素（按钮、链接等）',
    defaultData: () => ({ label: '点击元素', selector: defaultSelector(5000) }),
    summary: (d) => selectorDesc(d.selector) || '未配置元素',
  },
  input: {
    type: 'input',
    name: '输入文本',
    icon: EditOutlined,
    color: '#13c2c2',
    desc: '向输入框填入文本（搜索框、表单）',
    defaultData: () => ({ label: '输入文本', selector: defaultSelector(5000), text: '' }),
    summary: (d) => `${selectorDesc(d.selector) || '未配置元素'}${d.text ? ` ← 「${d.text}」` : ''}`,
  },
  extract: {
    type: 'extract',
    name: '提取数据',
    icon: TableOutlined,
    color: '#52c41a',
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
    color: '#fa8c16',
    desc: '按接口地址+传参模糊匹配，把响应内容存入变量',
    defaultData: () => ({ label: '接口拦截', url: '', param: '', varName: '接口数据', timeoutMs: 15000 }),
    summary: (d) =>
      d.url ? `匹配「${d.url}${d.param ? `？${d.param}` : ''}」→ {{${d.varName || '变量'}}}` : '未配置接口地址',
  },
  importTable: {
    type: 'importTable',
    name: '导入表格',
    icon: ImportOutlined,
    color: '#eb2f96',
    desc: '读取 CSV/JSON 表格，每一行数据依次跑一遍后续流程',
    defaultData: () => ({ label: '导入表格', filePath: '', fileName: '', rowCount: 0, columns: [] }),
    summary: (d) => (d.filePath ? `${d.fileName || '表格'} · ${d.rowCount || '?'} 行` : '未选择表格文件'),
  },
  condition: {
    type: 'condition',
    name: '逻辑判断',
    icon: BranchesOutlined,
    color: '#fa541c',
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
    color: '#2f54eb',
    desc: '给表格当前行新增或覆盖一列（值可用 {{变量}}）',
    defaultData: () => ({ label: '表格编辑', column: '', value: '' }),
    summary: (d) => (d.column ? `${d.column} ← ${d.value || '空'}` : '未填写列名'),
  },
  exportTable: {
    type: 'exportTable',
    name: '表格导出',
    icon: ExportOutlined,
    color: '#7cb305',
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
  'extract',
  'intercept',
  'importTable',
  'condition',
  'tableEdit',
  'exportTable',
]

const isSelectorFilled = (s) => !!s && typeof s.value === 'string' && s.value.trim() !== ''

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
