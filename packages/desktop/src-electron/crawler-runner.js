// 爬虫工作流执行引擎：隐藏 BrowserWindow 按连线解释执行节点，进度经 broadcast 四路推送
// （crawler:log / crawler:node / crawler:run / crawler:vars）给编辑器窗口。
// showWindow 选项：开跑后「打开网页」节点执行时把执行窗口显示出来（默认全程隐藏）。
//
// 执行模型（解释器而非静态序列）：
// - 从入度 0 的起点沿连线走（walkFrom），每次「走一遍」有自己的 visited 集合（分支合流不重复执行）
// - 变量系统：ctx.vars 里存表格当前行列 + 提取模块命中的字段，字符串里 {{变量名}} 会被替换；
//   整串恰好是一个 {{变量}} 时保留原始类型（条件模块的数值比较依赖它）；
//   {{变量.路径.0.子键}} 支持对象/数组嵌套取值（接口拦截存入的 JSON 靠它取内部字段）
// - 接口拦截 = 捕获节点：run 起跑即给隐藏窗口挂 CDP（webContents.debugger + Network 域），
//   地址+传参都模糊命中的响应体（JSON 自动解析）存入 ctx.captures；节点执行时取捕获
//   结果写入指定变量（已在跑的请求不要求节点先执行——先到的请求先缓存，节点后消费）
// - 等待/提取 = 主进程轮询（pollPage）：每 200ms 注入一次性检查脚本，页内不驻留等待——
//   登录校验等页面跳转只会杀死单轮检查，跳回后下一轮在新页面照常命中
// - 导入表格 = 整表读入：写入数组变量（默认「表格数据」，每行一个对象），不隐式循环——
//   要逐行走就把「数据循环」指到该变量上（当前项的字段即列名）
// - 数据循环 = 可重入循环节点：选一个数组变量（字符串可按分割符拆分）遍历后继循环体。
//   连线成环驱动：循环体末尾连回本模块=下一项（回到本模块时清空 visited 重跑循环体），
//   循环完则回连边不再走、改走末尾模块的其余出边（后续流程）；每项注入 {{当前项}}/
//   {{当前序号}}，对象项属性平铺成变量。状态存 ctx.loopStates，耗尽后重进即重新解析
//   。并发模式（并发进程数>1）：起 N 个隐藏进程轮转分摊数据项，各进程独立变量/表格行
//   走循环体（ctx 原型链继承父级），循环体出圈边被裁掉、后续模块等全部进程结束后统一走
// - 数据处理 = 主进程 vm 沙箱执行用户 JS：代码体即 async 函数体，value 是变量旧值、
//   vars 是全部变量，return 的结果写回该变量（深层路径如 a.b.0 写回原位置）
// - 逻辑判断 = 分支节点：结果为 是/否，分别沿 sourceHandle 为 yes/no 的连线走，未连接的分支结束本条
// - 表格编辑：写入一列（列不存在则创建），就地建表新起一行（数据循环每换一项新起一行），
//   表格实时推送到控制台；表格导出：统一在流程结束后导出一次整表
//
// 断点继续：
// - 每个节点成功执行后、loop 每消费一项后、并发 loop 每个 worker 每消费一项后保存 checkpoint。
// - 失败/停止时保存 checkpoint 并标记 resumable；用户可继续从失败节点重试。
// - 并发 loop：worker 独立 checkpoint；失败时只重跑失败的 worker，其他结果保留。
//
// 停止机制：模块级 current 单例，stop 置 stopped、signalStop 唤醒挂起操作并 destroy 隐藏窗口——
// 销毁后 executeJavaScript 的 promise 可能永不 settle，靠 stopPromise 赛道保证「停止」即时生效。
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { dlog, dmem } from './debuglog.js'
import { clickScript, diagnoseScript, extractScript, inputScript, selectorDesc, stableScript, waitScript } from './crawler-scripts.js'
import { exportTableFile, readTableFile } from './crawler-table.js'
import {
  finishCheckpoint,
  loadCheckpoint,
  listWorkerCheckpoints,
  newRunId,
  removeWorkerCheckpoint,
  saveCheckpoint,
  saveWorkerCheckpoint,
} from './crawler-checkpoint.js'

/** 支持的模块类型（与渲染层 constants.js 的模块面板保持一致；导入校验也用它）。 */
export const MODULE_TYPES = [
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

/** 元素事件模块的事件动词（与渲染层 constants.js 的 CLICK_EVENTS 镜像，摘要文案用）。 */
const CLICK_EVENTS = { click: '点击', dblclick: '双击', enter: '按下回车', focus: '聚焦', blur: '失焦', hover: '悬停' }
/** 可能引起页面跳转的事件（其余事件跳过导航等待，省 500ms）。 */
const NAV_EVENTS = ['click', 'dblclick', 'enter']

/** 推送给全部窗口（同 ipc/repos.js 的 broadcast：编辑器是独立窗口，不能只发首窗口）。 */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, payload)
    } catch {
      /* 窗口销毁瞬间：跳过 */
    }
  }
}

/** 诊断日志标签（落盘）：带上 runId，并发 worker 再带进程号——闪退后按运行串联日志。 */
const runTag = (ctx) => `crawler:${ctx.runId}${ctx.isWorker ? `:w${(ctx.workerIndex ?? 0) + 1}` : ''}`

/* -------- 运行前校验（权威校验在主进程，渲染层只做必填轻提示） -------- */

const isSelectorOk = (s) => s && typeof s.value === 'string' && s.value.trim() !== ''

/** 校验单个节点配置，返回错误文案（null = 通过）。 */
function validateNode(node) {
  const label = node.data?.label || node.type
  const checkRegex = (s) => {
    if (s.mode !== 'classRegex') return null
    try {
      new RegExp(s.value)
      return null
    } catch {
      return `${label}：class 正则「${s.value}」不合法`
    }
  }
  if (node.type === 'webpage') {
    const url = (node.data?.url || '').trim()
    if (!url) return `${label}：未填写网址`
    // 含 {{变量}} 的 URL（如 https://x.com/{{表格项.URL}}）运行时才插值，静态校验放行，
    // 最终形态在运行时校验（见执行处的 http 前缀兜底）
    if (/\{\{[^{}]+\}\}/.test(url)) return null
    if (!/^https?:\/\//i.test(url)) return `${label}：网址必须以 http:// 或 https:// 开头`
    return null
  }
  if (node.type === 'input') {
    if (!isSelectorOk(node.data?.selector)) return `${label}：未填写元素选择器`
    const re = checkRegex(node.data.selector)
    if (re) return re
    if (!node.data?.text) return `${label}：未填写要输入的文本`
    return null
  }
  if (node.type === 'keyboard') {
    // 键盘模块：按键必选；选择器可选（留空发给当前聚焦元素），填了才做 class 正则合法性检查
    if (!String(node.data?.key ?? '').trim()) return `${label}：未选择按键`
    const s = node.data?.selector
    if (isSelectorOk(s)) {
      const re = checkRegex(s)
      if (re) return re
    }
    return null
  }
  if (node.type === 'extract') {
    const fields = node.data?.fields || []
    if (fields.length === 0) return `${label}：至少配置一个提取字段`
    for (const f of fields) {
      if (!isSelectorOk(f.selector)) return `${label}：字段「${f.name || '未命名'}」未填写选择器`
      const re = checkRegex(f.selector)
      if (re) return re
    }
    return null
  }
  if (node.type === 'intercept') {
    if (!String(node.data?.url ?? '').trim()) return `${label}：未填写接口地址`
    if (!String(node.data?.varName ?? '').trim()) return `${label}：未填写写入变量名`
    return null
  }
  if (node.type === 'importTable') {
    if (!node.data?.filePath) return `${label}：未选择表格文件`
    return null
  }
  if (node.type === 'loop') {
    if (!String(node.data?.varName ?? '').trim()) return `${label}：未填写要循环的变量`
    const c = Number(node.data?.concurrency)
    if (Number.isFinite(c) && (c < 1 || c > 10)) return `${label}：并发进程数需在 1-10 之间`
    return null
  }
  if (node.type === 'dataProcess') {
    if (!String(node.data?.varName ?? '').trim()) return `${label}：未填写要处理的变量`
    if (!String(node.data?.code ?? '').trim()) return `${label}：未填写处理代码`
    return null
  }
  if (node.type === 'condition') {
    if (!node.data?.op) return `${label}：未选择比较方式`
    if (String(node.data?.left ?? '').trim() === '') return `${label}：未填写左值`
    if (!UNARY_OPS.includes(node.data.op) && String(node.data?.right ?? '').trim() === '') {
      return `${label}：未填写右值`
    }
    return null
  }
  if (node.type === 'tableEdit') {
    if (!String(node.data?.column ?? '').trim()) return `${label}：未填写列名`
    return null
  }
  if (node.type === 'exportTable') {
    if (!String(node.data?.savePath ?? '').trim()) return `${label}：未填写保存地址`
    return null
  }
  // wait / click
  if (!isSelectorOk(node.data?.selector)) return `${label}：未填写元素选择器`
  return checkRegex(node.data.selector)
}

/* -------- 变量插值与条件比较 -------- */

/**
 * 变量取值：先按整名直接命中（表格列名可能本身带点），否则按 . 逐级下钻
 * （对象键 / 数组下标均可，接口拦截存入的 JSON 靠这个取嵌套字段）。
 */
function lookupVar(vars, key) {
  if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]
  let cur = vars
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** 深层路径写回（数据处理模块用）：a.b.0 形式的变量名逐级下钻赋值，末级不存在则创建。 */
function setVar(vars, key, value) {
  const parts = key.split('.')
  if (parts.length === 1) {
    vars[key] = value
    return
  }
  let cur = vars
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(p) ? [] : {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * 主进程 vm 沙箱执行用户 JS（数据处理模块）：代码体作为 async 函数体运行，return 的值
 * 即变量新值。timeout 选项只能掐同步段（首个 await 前的死循环）；await 之后的挂起由外层
 * withTimeout 兜底。沙箱只给纯计算用的全局（JSON/Math/Date 等），不给 require/process——
 * 这是防呆而非安全边界（用户自己的机器跑自己的代码）。console.log 转投运行日志。
 */
async function runUserJs(ctx, code, value, vars, label) {
  // 深拷贝隔离：用户代码对 vars/value 的原地修改只落在副本上，真正生效的只有 return 的
  // 值（否则 vars.x=... 或 value.push() 的副作用会绕过写回逻辑污染别的变量）
  const copy = (v) => {
    try {
      return structuredClone(v)
    } catch {
      return v // 出现克隆不了的值类型（正常不会）：降级为引用，功能不受影响
    }
  }
  // 上下文按「一个执行流」复用（挂在 ctx 的自有属性上；断点序列化只挑字段不会带上它）。
  // 此前每次调用 vm.runInNewContext 新建 realm（含克隆的 value/vars 副本），
  // 嵌套数据循环数千次调用时旧 realm 被超时/停止反应链滞留无法回收，主进程堆
  // 以 ~120KB/次线性增长直至 V8 OOM → node::OnFatalError → abort，整个应用闪退。
  // 复用后每次调用只覆盖 value/vars/console 三个全局属性，旧副本即可回收。
  // 语义变化：同一执行流内不同模块的用户代码经 globalThis 遗留的全局变量互相可见
  //（正常代码均以 return 传递数据，不受影响）。
  // 并发 worker 用 Object.create(ctx) 原型继承——必须判「自有属性」而非真值：否则
  // 所有 worker 共享父 ctx 的同一个 realm，用户代码 await 恢复后 value/vars 可能已被
  // 别的 worker 覆盖（并发打标读写串流）。worker 各建各的，同流内顺序复用不变
  if (!Object.prototype.hasOwnProperty.call(ctx, 'userVm')) {
    ctx.userVm = vm.createContext({
      setTimeout, clearTimeout, setInterval, clearInterval, fetch,
      console: { log: () => {} },
    })
  }
  ctx.userVm.value = copy(value)
  ctx.userVm.vars = copy(vars)
  ctx.userVm.console = { log: (...args) => ctx.log('info', `[${label}] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`) }
  let pending
  try {
    pending = vm.runInContext(`(async () => {\n${code}\n})()`, ctx.userVm, { timeout: 5000 })
  } catch (err) {
    throw new Error(`「${label}」代码执行出错：${err.message}`)
  }
  try {
    return await withTimeout(ctx, Promise.resolve(pending), 5000, `「${label}」代码执行`)
  } catch (err) {
    throw new Error(`「${label}」${err.message}`)
  }
}

/** 循环聚合日志里「当前循环项」的预览：对象/数组 JSON 化，超长截断。 */
function fmtItemPreview(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/** 插值成字符串时对象的呈现方式（String(obj) 会是 [object Object]，没意义）。 */
const varToString = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

/** {{变量名}} 插值。整串恰好一个 {{变量}} 时返回原始值（数字/对象保留类型），否则做字符串替换。 */
export function interpolate(str, vars) {
  if (typeof str !== 'string') return str
  const full = /^\s*\{\{([^{}]+)\}\}\s*$/.exec(str)
  if (full) {
    const v = lookupVar(vars, full[1].trim())
    return v === undefined || v === null ? '' : v
  }
  return str.replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
    const v = lookupVar(vars, k.trim())
    return v === undefined || v === null ? '' : varToString(v)
  })
}

const CONDITION_OPS = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  includes: '包含',
  excludes: '不包含',
  empty: '为空',
  notEmpty: '不为空',
}
const UNARY_OPS = ['empty', 'notEmpty']
const isNumeric = (v) => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v ?? '').trim())

/**
 * 比较口径归一：对象/数组转 JSON 文本。String([]) 是 ''、对象是 [object Object]，
 * 没法与右值字面量比较；转 JSON 后，右值直接写 []（空数组）、["a","b"]、{"a":1}
 * 这类 JSON 写法即可与变量值（整串 {{变量}} 引用保留原始类型）对得上，不必非选现存变量。
 */
const normOperand = (v) => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * 语义空判断（仅「为空/不为空」用）：空串/纯空白/空数组/无键对象都算空——
 * 提取无结果时变量是 []，口径必须与旧版 String([]) === '' 一致；空对象同理按空算。
 */
const isSemanticallyEmpty = (v) => {
  if (v === undefined || v === null) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return String(v).trim() === ''
}

/** 条件比较：为空/不为空按语义空；双方均为数字（或数字字面量）按数值，数组/对象按 JSON 文本，其余按字符串。 */
function compare(l, op, r) {
  if (op === 'empty') return isSemanticallyEmpty(l)
  if (op === 'notEmpty') return !isSemanticallyEmpty(l)
  const ls = normOperand(l)
  const rs = normOperand(r)
  if (op === 'includes') return ls.includes(rs)
  if (op === 'excludes') return !ls.includes(rs)
  if (op === 'eq' || op === 'neq') {
    const eq = isNumeric(l) && isNumeric(r) ? Number(ls) === Number(rs) : ls === rs
    return op === 'eq' ? eq : !eq
  }
  let a = ls
  let b = rs
  if (isNumeric(l) && isNumeric(r)) {
    a = Number(ls)
    b = Number(rs)
  }
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
}

/* -------- 画布结构预处理 -------- */

/**
 * 找出连线形成的环（Tarjan 强连通分量，size≥2）：控制台「循环框」的聚合单位。
 * 用户流程里「点击翻页 → 接口拦截 → 数据循环 → 提取 → 判断 → 回到翻页」这类大回路
 * 是一个环——环内所有模块的日志都聚合到同一个循环框里，而不是只聚合数据循环节点。
 * @returns {Map<string, string>} 节点 id → 环 id（不在任何环里的节点无条目）。环 id
 *   用环内节点排序后的第一个 id（确定性：同一张图两次运行得到相同的框 key）
 */
function buildCycleMap(graph) {
  const nodes = graph.nodes || []
  const edges = (graph.edges || []).filter((e) => e.source !== e.target)
  const ids = nodes.map((n) => n.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const adj = ids.map(() => [])
  for (const e of edges) {
    const s = index.get(e.source)
    const t = index.get(e.target)
    if (s !== undefined && t !== undefined) adj[s].push(t)
  }
  // Tarjan 迭代实现（节点数千级以内，递归也安全，但迭代免栈深顾虑）
  const low = new Array(ids.length).fill(0)
  const num = new Array(ids.length).fill(0)
  const onStack = new Array(ids.length).fill(false)
  const stack = []
  const sccs = []
  let counter = 0
  for (let root = 0; root < ids.length; root++) {
    if (num[root]) continue
    const work = [[root, 0]]
    while (work.length) {
      const frame = work[work.length - 1]
      const v = frame[0]
      if (frame[1] === 0) {
        counter++
        num[v] = low[v] = counter
        stack.push(v)
        onStack[v] = true
      }
      let advanced = false
      while (frame[1] < adj[v].length) {
        const w = adj[v][frame[1]]
        frame[1]++
        if (!num[w]) {
          work.push([w, 0])
          advanced = true
          break
        }
        if (onStack[w] && num[w] < low[v]) low[v] = num[w]
      }
      if (advanced) continue
      if (low[v] === num[v]) {
        const comp = []
        for (;;) {
          const w = stack.pop()
          onStack[w] = false
          comp.push(w)
          if (w === v) break
        }
        if (comp.length >= 2) sccs.push(comp)
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        if (low[v] < low[parent]) low[parent] = low[v]
      }
    }
  }
  const cycleOf = new Map()
  for (const comp of sccs) {
    const key = 'cyc:' + comp.map((i) => ids[i]).sort()[0]
    for (const i of comp) cycleOf.set(ids[i], key)
  }
  return cycleOf
}

/**
 * 建邻接表与起点集合：出边按目标节点 y 排序（多分支时确定性），入度 0 为起点。
 * @returns {{ok: true, byId: Map, outEdges: Map, starts: Array} | {ok: false, error: string}}
 */
function prepareGraph(graph) {
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outEdges = new Map(nodes.map((n) => [n.id, []]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    outEdges.get(e.source).push(e)
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
  }
  for (const outs of outEdges.values()) {
    outs.sort((a, b) => (byId.get(a.target).position?.y ?? 0) - (byId.get(b.target).position?.y ?? 0))
  }
  const starts = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => byId.get(id))
  starts.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
  if (starts.length === 0) {
    return { ok: false, error: '流程缺少起点，或存在「数据循环」回连边以外的环，无法确定执行顺序（请检查连线）' }
  }
  return { ok: true, byId, outEdges, starts }
}

/* -------- 执行引擎 -------- */

/**
 * 执行窗口与登录窗口共用的会话分区。persist: 前缀让 Cookie/localStorage 落盘——
 * 不带前缀是内存会话，窗口销毁登录态就蒸发（每次跑都要重新登录的根因）。
 * 仍与 tapd 登录态/默认 jar 隔离（独立分区）。
 */
const CRAWLER_PARTITION = 'persist:crawler-sandbox'

let loginWin = null

/**
 * 打开登录窗口（与执行窗口同一持久会话）：在流程外先登录目标站（2FA/验证码不受
 * 等待节点超时逼迫），登录态落盘后执行窗口直接免登录。已开则聚焦并导航。
 */
export function openLoginWindow(url) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    if (/^https?:\/\//i.test(url || '')) loginWin.loadURL(url).catch(() => {})
    return { ok: true }
  }
  loginWin = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    title: '爬虫登录（登录一次即可，执行窗口共用登录态）',
    webPreferences: {
      partition: CRAWLER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 登录场景放开弹窗（第三方 SSO/验证码可能开新窗），与执行窗口的 deny 策略区分
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  loginWin.on('closed', () => {
    loginWin = null
  })
  if (/^https?:\/\//i.test(url || '')) loginWin.loadURL(url).catch(() => {})
  return { ok: true }
}

let current = null
let reusableWin = null // showWindow 运行结束后留下的执行窗口：下次运行直接复用

/** 是否有任务在执行。 */
export function isRunning() {
  return current !== null
}

/** 停止当前任务（无任务也返回 ok）。 */
export function stopRun() {
  if (!current) return { ok: true }
  dlog('crawler', `用户停止任务：run=${current.runId} project=${current.projectId}`)
  current.stopped = true
  current.signalStop?.() // 唤醒所有挂起的节点执行（销毁窗口后 executeJavaScript 可能永不 settle）
  // 停止即销毁执行窗口（用户主动叫停，保留窗口无意义）；顺手清掉复用指针防野引用
  reusableWin = null
  try {
    if (current.win && !current.win.isDestroyed()) current.win.destroy()
  } catch {
    /* 窗口已销毁：忽略 */
  }
  // 并发循环起的进程窗口一并销毁（正常收尾时 runConcurrentLoop 已自行清理，这里兜重复销毁）
  for (const w of current.workerWins || []) {
    try {
      if (!w.isDestroyed()) w.destroy()
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true }
}

/**
 * promise 外加硬超时兜底 + 停止信号（executeJavaScript 卡死/页面死循环/窗口销毁后
 * promise 永不 settle 时，靠这两个赛道推进，保证「停止」即时生效）。
 */
function withTimeout(ctx, promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时(${Math.round(ms / 1000)}s)`)), ms)
    }),
    ctx.stopPromise.then(() => {
      clearTimeout(timer)
      throw new Error('任务已停止')
    }),
  ])
}

/**
 * 点击后导航等待：click 同步返回，但可能触发跳转。500ms 内没导航就继续下一节点；
 * 导航了就等 did-finish-load（上限 timeoutMs）——不等的话后续节点会注入到旧页面。
 */
function waitPossibleNavigation(win, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (did) => {
      if (settled) return
      settled = true
      win.webContents.removeAllListeners('did-navigate')
      clearTimeout(noNavTimer)
      clearTimeout(hardTimer)
      resolve(did)
    }
    const noNavTimer = setTimeout(() => finish(false), 500)
    const hardTimer = setTimeout(() => finish(true), Math.max(timeoutMs || 5000, 1000))
    win.webContents.once('did-navigate', () => {
      win.webContents.once('did-finish-load', () => finish(true))
      win.webContents.once('did-fail-load', () => finish(true))
    })
  })
}

/**
 * 主进程侧轮询注入：每 200ms 注入一段一次性检查脚本，页内不再长驻轮询 Promise。
 * 登录校验等页面跳转会杀死页内脚本且 executeJavaScript 随之永不 settle——页内自轮询
 * 的等待就此僵死，跳回原页面后元素出现也永远等不到。改为单次检查后，跳转最多损失
 * 一轮（被销毁上下文的注入由内层 3s 硬超时兜底收回），新页面就绪后下一轮照常命中。
 * @param {() => string} makeScript 每轮生成检查脚本（求值 null/undefined = 本轮未命中）
 * @param {number} timeoutMs 总超时（没到超时就一直取，取到即通过——与节点语义一致）
 * @param {string} timeoutError 超时报错文案
 * @param {null | ((elapsedSec: number) => void)} slowLog 长等待进度回调：5s 后首次，
 *   之后间隔翻倍、上限 60s 一次——1000s 的超长等待控制台也看得到「还活着在等」
 * @returns {Promise<*>} 首个真值结果
 */
async function pollPage(ctx, makeScript, timeoutMs, timeoutError, slowLog = null) {
  const deadline = Date.now() + (Number(timeoutMs) || 10000)
  const startedAt = Date.now()
  let errs = 0 // 注入失败/单轮超时的轮数（页面跳转中属正常；全程 0 命中 + 全失败 = 检查根本没跑成）
  let clean = 0 // 正常执行（无论是否命中）的轮数
  let nextSlow = 5000
  for (;;) {
    // 终止信号：停止或并发 worker 被动取消（其他进程失败时的 failWatch 唤醒）。
    // 此前只查 ctx.stopped：worker 被取消时 stopPromise 已解析但 stopped=false，
    // withTimeout 每轮立即抛错被当「页面跳转」吞掉，且睡眠 race 被已解析的
    // stopPromise 瞬时跳过 → 零间隔死循环，每轮真实调一次 executeJavaScript，
    // 每秒上万次 IPC 洪水把事件循环饿死——应用卡死闪退（日志特征：12 万+轮页面检查）
    if (ctx.stopped || ctx.cancelled) throw new Error('任务已停止')
    let result = null
    try {
      result = await withTimeout(ctx, ctx.win.webContents.executeJavaScript(makeScript(), true), 3000, '页面检查')
      clean++
    } catch (err) {
      if (ctx.stopped || ctx.cancelled) throw new Error('任务已停止')
      errs++
      /* 页面正在跳转/上下文刚被销毁：当成本轮未命中，稍后在新页面重试 */
    }
    if (result) return result
    if (Date.now() >= deadline) {
      // 全部轮次都没跑成检查：元素可能早出现了，但检查脚本一直没执行成功——与「页面
      // 正常但没找到」分开说，前者查页面环境，后者查选择器
      if (errs > 0 && clean === 0) {
        throw new Error(`${timeoutError}；注意：${errs} 轮页面检查均未执行成功（页面持续跳转或脚本注入异常）`)
      }
      throw new Error(timeoutError)
    }
    if (slowLog && Date.now() - startedAt >= nextSlow) {
      slowLog(Math.round((Date.now() - startedAt) / 1000))
      nextSlow = Math.min(nextSlow * 2, 60000)
    }
    // 间隔与停止信号赛跑：「停止」立即生效，不等本轮 200ms 睡满
    await Promise.race([new Promise((r) => setTimeout(r, 200)), ctx.stopPromise])
  }
}

/**
 * 等页面渲染稳定（提取数据的前置等待）：点击翻页/回车跳转后，旧 DOM 还没卸载或新内容
 * 没渲染完，立刻提取会抓到上一页的数据。判据：readyState=complete 且连续两轮（间隔
 * ~350ms）DOM 签名一致；跳转中的 executeJavaScript 异常视为不稳定，下一轮重试。
 * 超过预算直接放行——提取本身还有 pollPage 轮询兜底，这里不硬性报错（动效多的页面
 * 可能永远「不稳定」，卡死比抓慢更糟）。
 */
async function waitPageStable(ctx, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    // 同 pollPage：取消（并发 worker 被动唤醒）也是终止信号，避免已解析的 stopPromise
    // 跳过睡眠 race 造成零间隔刷轮
    if (ctx.stopped || ctx.cancelled) return
    let sig = null
    try {
      sig = await withTimeout(ctx, ctx.win.webContents.executeJavaScript(stableScript(), true), 2000, '页面稳定检查')
    } catch {
      sig = null // 页面正在跳转/上下文刚销毁：当不稳定，稍后重试
    }
    if (sig && sig === last) return
    last = sig
    await Promise.race([new Promise((r) => setTimeout(r, 350)), ctx.stopPromise])
  }
}

/* -------- 接口拦截：CDP 网络捕获 -------- */

/**
 * 给执行窗口挂 CDP（Network 域）捕获接口响应：请求落地时按各 intercept 节点的
 * 「地址 + 传参」做模糊匹配（includes，忽略大小写；传参匹配 URL 查询串与 POST 体），
 * 双命中的响应体经 Network.getResponseBody 取回，JSON 自动解析后存入 ctx.captures
 * 并唤醒等待中的节点。捕获从 run 起跑就开始（不要求节点先执行），每个节点取首次命中。
 * @returns {Promise<void>} Network.enable 完成（起跑前 await，防错过页面首批请求）
 */
function setupNetworkCapture(ctx, interceptNodes) {
  const dbg = ctx.win.webContents.debugger
  const pending = new Map() // requestId → { url, urlLower, paramLower }

  /** 单个节点配置是否命中该请求（模式串参与变量插值，循环内可按行动态匹配）。 */
  const matches = (node, info) => {
    const d = node.data || {}
    const urlPat = String(interpolate(d.url ?? '', ctx.vars)).trim().toLowerCase()
    if (urlPat && !info.urlLower.includes(urlPat)) return false
    const paramPat = String(interpolate(d.param ?? '', ctx.vars)).trim().toLowerCase()
    if (paramPat && !info.paramLower.includes(paramPat)) return false
    return true
  }

  dbg.on('message', (_event, method, params) => {
    void (async () => {
      try {
        if (method === 'Network.requestWillBeSent') {
          const req = params.request || {}
          let postData = req.postData
          if (postData === undefined && req.hasPostData) {
            // 大请求体 CDP 不随事件附带，需单独取；取不到就当没有（只影响传参匹配）
            try {
              const r = await dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId })
              postData = r.postData
            } catch {
              /* 请求体已不可取：跳过 */
            }
          }
          const url = req.url || ''
          pending.set(params.requestId, {
            url,
            urlLower: url.toLowerCase(),
            paramLower: `${url.split('?')[1] || ''}\n${postData || ''}`.toLowerCase(),
          })
        } else if (method === 'Network.loadingFinished') {
          const info = pending.get(params.requestId)
          if (!info) return
          pending.delete(params.requestId)
          const targets = interceptNodes.filter((n) => !ctx.captures.has(n.id) && matches(n, info))
          if (!targets.length) return
          let bodyText = ''
          try {
            const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            bodyText = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
          } catch {
            return // 响应体已回收/非 http 等场景：静默跳过，等下一个命中的请求
          }
          // 诊断：响应体积与未收尾请求数（pending 只增不减 = 泄漏，长跑会把内存拖爆）
          dlog('crawler:cdp', `捕获响应：${bodyText.length}B 命中节点=${targets.length} 待回收请求=${pending.size} url=${info.url}`)
          let value
          try {
            value = JSON.parse(bodyText)
          } catch {
            value = bodyText
          }
          for (const node of targets) {
            ctx.captures.set(node.id, { url: info.url, value })
            ctx.log('info', `接口拦截「${node.data?.label || '接口拦截'}」命中：${info.url}`, node)
            const waiters = ctx.interceptWaiters.get(node.id)
            if (waiters) {
              for (const resolve of waiters) resolve()
              ctx.interceptWaiters.delete(node.id)
            }
          }
        }
      } catch {
        /* 单条 CDP 消息处理失败不影响捕获循环 */
      }
    })()
  })

  try {
    dbg.attach('1.3')
  } catch {
    /* 已附加（理论上不会发生）：复用会话 */
  }
  return dbg.sendCommand('Network.enable')
}

/* -------- 断点序列化辅助 -------- */

/** 序列化 loopStates（Map → 数组，items 可能很大，直接保留引用）。 */
function serializeLoopStates(loopStates) {
  const out = {}
  for (const [id, st] of loopStates.entries()) {
    out[id] = {
      items: st.items,
      index: st.index,
      gen: st.gen,
      totalItems: st.totalItems,
      gis: st.gis,
      outer: st.outer,
      tableBacked: st.tableBacked || false,
    }
  }
  return out
}

/** 反序列化 loopStates。 */
function deserializeLoopStates(raw) {
  const map = new Map()
  if (!raw) return map
  for (const id of Object.keys(raw)) {
    map.set(id, raw[id])
  }
  return map
}

/** 构造 checkpoint 快照。 */
function buildCheckpoint(ctx) {
  return {
    status: ctx.failed ? 'failed' : ctx.stopped ? 'stopped' : 'running',
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    runId: ctx.runId,
    startedAt: ctx.startedAt,
    graph: ctx.graph,
    failedAt: ctx.failedAt || null,
    execution: {
      queue: ctx.queue?.map((n) => n.id) || [],
      visited: ctx.visited ? [...ctx.visited] : [],
      walkGen: ctx.walkGen,
      loopStates: serializeLoopStates(ctx.loopStates),
      vars: ctx.vars,
      currentRow: ctx.currentRow,
      // 导入表格行循环的进度追踪（表格编辑写当前行所需）
      tableVarName: ctx.tableVarName || null,
      currentTableRowIndex: ctx.currentTableRowIndex ?? null,
      // 数据处理「结果另存为新变量」的声明记录：断点恢复后循环内重复执行不再误判为冲突
      declaredOutputs: ctx.declaredOutputs || null,
      loop: ctx.loop,
      forceSeqLoops: ctx.forceSeqLoops ? [...ctx.forceSeqLoops] : [],
      completedLoops: ctx.completedLoops ? [...ctx.completedLoops] : [],
      resumeNodeId: ctx.resumeNodeId || null,
      // 并发 loop 续跑的 worker 集合：失败=[失败的那个]；停止=[所有留有断点的]
      resumeWorkerIndexes: ctx.resumeWorkerIndexes || [],
      parentLoopState: ctx.parentLoopState || null,
    },
    data: {
      rows: ctx.rows,
      table: ctx.table,
      captures: Array.from(ctx.captures.entries()),
    },
  }
}

/** 立即写盘（吞错，不能影响主流程）。 */
async function writeCpNow(ctx) {
  const t0 = Date.now()
  try {
    const r = await saveCheckpoint(ctx.projectId, ctx.runId, buildCheckpoint(ctx))
    // 诊断：断点体积/耗时（历史上同步大 JSON 写盘曾把主进程拖死被系统杀掉闪退）
    dlog(runTag(ctx), `断点写盘：${r.bytes}B 耗时=${Date.now() - t0}ms`)
  } catch (err) {
    ctx.log?.('warn', `保存断点失败：${err.message}`)
    dlog(runTag(ctx), `断点写盘失败（耗时 ${Date.now() - t0}ms）：${err.stack || err.message}`)
  }
}

/* 断点写盘节流：循环里每项、每个节点成功都会保存，大画布（表格百行 × 接口大 JSON）时
   每秒数十次全量 stringify + 同步写盘会把主进程拖死（实测长流程因此被系统杀掉闪退）。
   运行中合并为至多每 300ms 一次（崩溃最多丢 300ms 进度）；终态（失败/停止）用 flush 立即
   落盘；正常完成后先取消挂起的定时器再清理断点，防止写回已删除的文件。 */
let cpThrottleTimer = null

/** 取消挂起的节流写盘（完成清理前调用，防止复活已删除的断点文件）。 */
function cancelPendingCp() {
  if (cpThrottleTimer) {
    clearTimeout(cpThrottleTimer)
    cpThrottleTimer = null
  }
}

/**
 * 保存主流程 checkpoint。并发 worker 不写主断点。
 * @param {{flush?: boolean}} opts flush=true 立即落盘（终态用）；默认 300ms 节流合并
 */
function saveCp(ctx, { flush = false } = {}) {
  if (ctx.isWorker) return Promise.resolve()
  if (flush) {
    cancelPendingCp()
    return writeCpNow(ctx)
  }
  if (cpThrottleTimer) return Promise.resolve()
  cpThrottleTimer = setTimeout(() => {
    cpThrottleTimer = null
    writeCpNow(ctx)
  }, 300)
  return Promise.resolve()
}

/** 保存并发 worker 断点：每消费一项后调用，崩溃/失败后可从该项继续。 */
async function saveWorkerCp(ctx, loopNodeId) {
  if (!ctx.isWorker) return
  const t0 = Date.now()
  try {
    const r = await saveWorkerCheckpoint(ctx.projectId, ctx.runId, ctx.workerIndex, {
      status: 'running',
      workerIndex: ctx.workerIndex,
      loopNodeId,
      loopState: ctx.loopStates.get(loopNodeId),
      data: { rows: ctx.rows, table: ctx.table, vars: ctx.vars },
    })
    dlog(runTag(ctx), `worker 断点写盘：${r.bytes}B 耗时=${Date.now() - t0}ms`)
  } catch (err) {
    dlog(runTag(ctx), `worker 断点写盘失败（耗时 ${Date.now() - t0}ms）：${err.stack || err.message}`)
  }
}

/* -------- 运行入口与断点恢复 -------- */

/**
 * 执行一次爬虫任务。
 * @param {{projectId: string, projectName?: string, graph: object, showWindow?: boolean, resumeRunId?: string}} opts
 * @returns {{ok: boolean, error?: string, data?: {runId: string}}}
 */
export async function runCrawler({ projectId, projectName, graph, showWindow, resumeRunId }) {
  if (current) return { ok: false, error: '已有爬虫任务在执行，请先停止' }
  // 断点续跑：先加载 checkpoint，优先用断点时的画布快照——运行期间改画布会造成状态错位
  const resuming = !!resumeRunId
  let cp = null
  if (resuming) {
    cp = await loadCheckpoint(projectId, resumeRunId)
    if (!cp || cp._broken) return { ok: false, error: '断点数据已损坏或不存在，无法继续' }
    // 优先用调用方传入的当前画布（用户可能已修复失败节点的配置）；没传才回退断点快照。
    // 状态按节点 id 对齐，未改画布时两者等价；删掉的节点在恢复 queue 时会被安全过滤
    if (!graph?.nodes?.length && cp.graph?.nodes?.length) graph = cp.graph
  }
  const nodes = graph?.nodes || []
  if (nodes.length === 0) return { ok: false, error: '画布为空，请先拖入模块节点' }
  for (const n of nodes) {
    const err = validateNode(n)
    if (err) return { ok: false, error: `${err}（点击画布节点可在右侧抽屉补全配置）` }
  }
  const prepared = prepareGraph(graph)
  if (!prepared.ok) return { ok: false, error: prepared.error }

  const runId = resumeRunId || newRunId()
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const tag = `crawler:${runId}`
  let seqCounter = 0

  const ctx = {
    projectId,
    projectName: projectName || 'crawler',
    runId,
    startedAt,
    graph,
    stopped: false,
    finished: false,
    failed: null,
    failedAt: null,
    rows: [],
    win: null,
    showWindow: !!showWindow,
    vars: {},
    captures: new Map(),
    interceptWaiters: new Map(),
    table: null,
    currentRow: null,
    // 导入表格的「行循环」追踪：tableVarName/tableRowsRef 由导入表格模块写入；
    // currentTableRowIndex 是当前循环项对应的表格行下标——循环内「表格编辑」据此
    // 把列写进原表格的当前行，而不是追加新行（没有导入表格时仍走新建行逻辑）
    tableVarName: null,
    tableRowsRef: null,
    currentTableRowIndex: null,
    loop: null,
    loopStates: new Map(),
    walkGen: 0,
    byId: prepared.byId,
    outEdges: prepared.outEdges,
    queue: [],
    visited: new Set(),
    forceSeqLoops: new Set(),
    completedLoops: new Set(),
    resumeNodeId: null,
    resumeWorkerIndexes: [],
    parentLoopState: null,
    activeLoopId: null, // 最内层活跃循环节点 id（嵌套循环换代同步用）
    cycleOf: buildCycleMap(graph), // 节点 id → 连线环 id（控制台循环框的聚合单位，见 buildCycleMap）
    workerWins: [],
    stopPromise: null,
    signalStop: null,
  }
  ctx.stopPromise = new Promise((resolve) => {
    ctx.signalStop = resolve
  })
  current = ctx

  const log = (level, message, node, srcCtx) => {
    const sc = srcCtx || ctx
    const base = {
      projectId, runId,
      seq: seqCounter++,
      ts: Date.now(),
      level,
      nodeId: node?.id,
      nodeType: node?.type,
      nodeLabel: node?.data?.label,
      message,
    }
    // 聚合单位 = 连线环（见 buildCycleMap）：模块间连线形成的回路（如 翻页点击 → 接口
    // 拦截 → 数据循环 → 提取 → 判断 → 回到翻页点击）里的所有日志都聚合到同一个循环框，
    // 覆盖更新不往下叠，明细留在条目里点击弹窗查看。环外模块照常逐条成行。
    // warn/error 重要事件仍额外发一条独立行——错误徽标与失败原因不被折叠进明细里。
    const cycKey = node?.id ? sc.cycleOf?.get(node.id) : null
    if (cycKey) {
      // 框的进度跟随环内最内层活跃数据循环；环里非循环段执行时（如点翻页、等接口）
      // 不带 label/iteration——前端覆盖合并不传的字段，框保持上一次的显示
      const activeLoopNode = sc.activeLoopId ? sc.byId?.get(sc.activeLoopId) : null
      broadcast('crawler:log', {
        ...base,
        aggKey: sc.isWorker ? `${cycKey}:w${sc.workerIndex}` : cycKey,
        agg: {
          ...(activeLoopNode ? { label: activeLoopNode.data?.label } : {}),
          ...(sc.loop ? { iteration: { ...sc.loop } } : {}),
          ...(sc.activeLoopId ? { item: fmtItemPreview(sc.vars?.['当前项']) } : {}),
          done: false,
        },
      })
      if (level === 'warn' || level === 'error') broadcast('crawler:log', { ...base, seq: seqCounter++ })
      return
    }
    broadcast('crawler:log', base)
  }
  // 循环结束（耗尽/跳过）：把聚合行标记为完成（前端停转圈、显示完成态）。
  // 仅作用于「不在连线环里」的数据循环——环内的循环耗尽只是本轮结束，外环还会
  // 继续转（如翻页后重新拦截再循环），环框的收口由运行结束时前端统一处理
  const endLoopAgg = (sc, loopNodeId) => {
    if (sc.cycleOf?.get(loopNodeId)) return
    const loopNode = sc.byId?.get(loopNodeId)
    broadcast('crawler:log', {
      projectId, runId,
      seq: seqCounter++,
      ts: Date.now(),
      level: 'success',
      nodeId: loopNodeId,
      nodeType: 'loop',
      nodeLabel: loopNode?.data?.label,
      message: '循环完成',
      aggKey: sc.isWorker ? `${loopNodeId}:w${sc.workerIndex}` : loopNodeId,
      agg: { label: loopNode?.data?.label || '数据循环', done: true },
    })
  }
  ctx.endLoopAgg = endLoopAgg
  // 循环框心跳：循环节点每消费一项就主动广播自己的聚合状态（bare 事件，前端不追加
  // 明细、只刷新框）。在连线环里的循环心跳刷新「环框」（进度/当前项跟着本循环走）；
  // 环外的循环刷自己的节点框——两种情况都保证从第一项起就必有框并随迭代跳动
  const loopHeartbeat = (sc, node) => {
    const key = sc.cycleOf?.get(node.id) || node.id
    broadcast('crawler:log', {
      projectId, runId,
      seq: seqCounter++,
      ts: Date.now(),
      level: 'info',
      nodeId: node.id,
      nodeType: 'loop',
      nodeLabel: node.data?.label,
      message: '',
      bare: true,
      aggKey: sc.isWorker ? `${key}:w${sc.workerIndex}` : key,
      agg: {
        label: node.data?.label || '数据循环',
        iteration: { ...sc.loop },
        item: fmtItemPreview(sc.vars?.['当前项']),
        done: false,
      },
    })
  }
  ctx.loopHeartbeat = loopHeartbeat
  const nodeState = (node, status, extra = {}) => {
    broadcast('crawler:node', {
      projectId, runId,
      nodeId: node.id,
      status,
      ...(ctx.loop ? { iteration: { ...ctx.loop } } : {}),
      ...extra,
    })
  }
  const runState = (status, extra = {}) => {
    broadcast('crawler:run', { projectId, runId, status, startedAt, finishedAt: new Date().toISOString(), ...extra })
  }
  ctx.log = log
  ctx.nodeState = nodeState
  ctx.pushVars = () => broadcast('crawler:vars', { projectId, runId, vars: { ...ctx.vars } })
  ctx.pushTable = () =>
    broadcast('crawler:table', {
      projectId,
      runId,
      table: ctx.table ? { columns: [...ctx.table.columns], rows: ctx.table.rows.map((r) => ({ ...r })) } : null,
    })

  // 断点恢复：从 checkpoint 恢复执行状态与数据（vars 存在 execution 段）
  if (resuming && cp) {
    ctx.startedAt = cp.startedAt || startedAt
    ctx.rows = cp.data?.rows || []
    ctx.vars = cp.execution?.vars || {}
    ctx.table = cp.data?.table || null
    ctx.currentRow = cp.execution?.currentRow || null
    // 恢复行循环追踪：tableRowsRef 指向恢复后的 vars 里的同源数组（引用判据，
    // 重解析循环时判定 items 是否就是导入表格的行）
    ctx.tableVarName = cp.execution?.tableVarName || null
    ctx.currentTableRowIndex = cp.execution?.currentTableRowIndex ?? null
    if (ctx.tableVarName && Array.isArray(ctx.vars[ctx.tableVarName])) {
      ctx.tableRowsRef = ctx.vars[ctx.tableVarName]
    }
    ctx.declaredOutputs = cp.execution?.declaredOutputs || null
    ctx.loop = cp.execution?.loop || null
    ctx.loopStates = deserializeLoopStates(cp.execution?.loopStates)
    ctx.walkGen = cp.execution?.walkGen || 0
    ctx.visited = new Set(cp.execution?.visited || [])
    ctx.queue = (cp.execution?.queue || []).map((id) => ctx.byId.get(id)).filter(Boolean)
    ctx.forceSeqLoops = new Set(cp.execution?.forceSeqLoops || [])
    ctx.completedLoops = new Set(cp.execution?.completedLoops || [])
    ctx.captures = new Map(cp.data?.captures || [])
    ctx.failedAt = cp.failedAt || null
    ctx.resumeNodeId = cp.execution?.resumeNodeId || null
    ctx.resumeWorkerIndexes = cp.execution?.resumeWorkerIndexes || []
    ctx.parentLoopState = cp.execution?.parentLoopState || null
    // 活跃循环取恢复状态里最后一个（Map 序=创建序，嵌套时最后创建=最内层）
    ctx.activeLoopId = [...ctx.loopStates.keys()].pop() || null
    // 恢复首轮不递增 walkGen：loopStates 里的 gen 与保存时一致，直接沿用不被重置
    ctx.resumeSkipGen = true
  }

  ctx.pushVars()

  // 复用上次 showWindow 结束后留下的执行窗口（用户还没手动关）：直接接着用，避免
  // 销毁重建的闪烁。上次的 closed 钩子随旧 ctx 失效（current 已换人），重新挂
  let win = null
  if (reusableWin && !reusableWin.isDestroyed()) {
    win = reusableWin
  } else {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: CRAWLER_PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
  reusableWin = null
  ctx.win = win
  win.on('closed', () => {
    if (current === ctx && !ctx.finished) {
      current.stopped = true
      current.signalStop?.()
    }
  })
  // 诊断：执行窗口渲染进程崩溃（reason=oom = 页面内存爆了）——closed 只能看出窗口没了
  win.webContents.on('render-process-gone', (_evt, details) => {
    dlog(tag, `执行窗口渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}`)
  })

  runState('running', { resumed: resuming })
  log('info', resuming ? `继续执行：从断点恢复` : `开始执行：共 ${nodes.length} 个节点`)
  if (resuming && ctx.failedAt) {
    log('info', `断点位置：节点 ${ctx.failedAt.nodeId}${ctx.failedAt.iteration ? `（第 ${ctx.failedAt.iteration.row}/${ctx.failedAt.iteration.total} 项）` : ''}，错误：${ctx.failedAt.message}`)
  }

  // 诊断：运行起跑信息 + 30s 内存采样（闪退排查——被系统 OOM 杀掉时 rss 增长趋势可见）
  dlog(
    tag,
    `开始执行：project=${projectId}(${ctx.projectName}) 续跑=${resuming} 节点=${nodes.length} 连线=${(graph.edges || []).length} 接口拦截=${nodes.filter((n) => n.type === 'intercept').length} 个`,
  )
  dmem(tag, '起跑 ')
  const memTimer = setInterval(() => {
    dmem(tag, '')
    let varsBytes = -1
    try {
      varsBytes = JSON.stringify(ctx.vars).length
    } catch {
      /* 变量不可序列化：跳过体积只记数量 */
    }
    dlog(
      tag,
      `采样：rows=${ctx.rows.length} 表格行=${ctx.table?.rows?.length ?? 0} 捕获=${ctx.captures.size} 变量数=${Object.keys(ctx.vars).length} 变量体积=${varsBytes}B`,
    )
  }, 30000)
  memTimer.unref?.()

  ;(async () => {
    try {
      if (nodes.some((n) => n.type === 'intercept')) {
        try {
          await win.loadURL('about:blank')
          await setupNetworkCapture(ctx, nodes.filter((n) => n.type === 'intercept'))
        } catch (err) {
          throw new Error(`接口拦截初始化失败：${err.message}`)
        }
      }

      let entries = prepared.starts
      // 断点恢复：并发 loop 失败优先重入 loop 节点（只重跑失败的 worker）；
      // 其次从保存的 queue 继续；queue 空则从失败节点重试
      if (resuming) {
        const resumeLoop =
          ctx.resumeWorkerIndexes.length > 0 && ctx.resumeNodeId && ctx.byId.has(ctx.resumeNodeId)
            ? ctx.byId.get(ctx.resumeNodeId)
            : null
        if (resumeLoop) {
          // 直接改写 ctx.queue：walkFrom 在 queue 非空时优先用它，不认 entries 里前置的节点
          ctx.queue = [resumeLoop, ...ctx.queue]
          entries = ctx.queue
          ctx.visited.delete(resumeLoop.id)
        } else if (ctx.queue.length) {
          entries = ctx.queue
        } else if (ctx.failedAt?.nodeId && ctx.byId.has(ctx.failedAt.nodeId)) {
          entries = [ctx.byId.get(ctx.failedAt.nodeId)]
          ctx.visited.delete(ctx.failedAt.nodeId)
        }
      }

      if (!ctx.stopped && !ctx.failed) await walkFrom(ctx, entries)
      if (!ctx.stopped) await runExportNodes(ctx, nodes)
    } catch (err) {
      if (!ctx.failed && !ctx.stopped) ctx.failed = err.message || String(err)
    }

    // 诊断：收尾行（闪退场景日志里没有这行 = 主流程未走完即被杀）+ 停掉内存采样
    clearInterval(memTimer)
    dlog(
      tag,
      `执行结束：${ctx.failed ? `失败：${ctx.failed}` : ctx.stopped ? '已停止' : '成功'} rows=${ctx.rows.length} 表格行=${ctx.table?.rows?.length ?? 0} 耗时=${Math.round((Date.now() - startMs) / 1000)}s`,
    )
    dmem(tag, '结束时 ')

    ctx.finished = true
    try {
      if (!win.isDestroyed()) {
        try {
          if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
        } catch {}
        // showWindow 开着时流程结束不关窗口：留着让用户核对页面/结果，关掉即销毁
        //（用户手动关窗在 finished 后不再触发停止）。下次运行会复用还开着的窗口
        if (!ctx.showWindow) win.destroy()
        else reusableWin = win
      }
    } catch {}

    // 保存最终状态
    if (current === ctx) {
      if (ctx.failed) {
        ctx.failedAt = ctx.failedAt || { nodeId: ctx.resumeNodeId || 'unknown', message: ctx.failed }
        await saveCp(ctx, { flush: true })
        runState('failed', { error: ctx.failed, rows: ctx.rows, table: ctx.table, resumable: true })
        log('error', `执行失败：${ctx.failed}`)
      } else if (ctx.stopped) {
        await saveCp(ctx, { flush: true })
        runState('stopped', { rows: ctx.rows, table: ctx.table, resumable: true })
        log('warn', '任务已停止')
      } else {
        // 先取消节流中挂起的写盘，防止在断点清理后又把 state.json 写回来
        cancelPendingCp()
        await finishCheckpoint(projectId, runId)
        runState('done', { rows: ctx.rows, table: ctx.table })
        const parts = []
        if (ctx.rows.length) parts.push(`提取 ${ctx.rows.length} 行`)
        if (ctx.table) parts.push(`表格 ${ctx.table.rows.length} 行`)
        log('success', `执行完成${parts.length ? `：共${parts.join('，')}` : ''}`)
      }
      current = null
    }
  })()

  return { ok: true, data: { runId } }
}

/**
 * 回退「刚耗尽」的活跃循环：最后一项循环体进行中被中断时消费指针已到末尾（正常完成会被
 * pickNext delete），回退一项让断点恢复时重试该项——否则恢复会误判「已耗尽」而从头重跑。
 */
function rollbackExhaustedLoops(ctx) {
  for (const st of ctx.loopStates.values()) {
    if (st.gen === ctx.walkGen && st.index === st.items.length && st.items.length > 0) {
      st.index = st.items.length - 1
    }
  }
}

/**
 * 从入口节点（单个或数组，数组=多个入口共享同一遍 visited，合流不重复执行）沿连线执行：
 * 条件节点按 是/否 结果选边；失败即停（ctx.failed 记录，上层循环据此中断）。
 * 数据循环例外可重入：回连边把 loop 节点再次入队时清空 visited，让循环体整轮重跑
 * （环外节点不会被重新入队，清空 visited 不会重跑循环之前的前置流程）。
 */
async function walkFrom(ctx, entries) {
  const visited = ctx.visited
  const queue = ctx.queue.length ? ctx.queue : (Array.isArray(entries) ? [...entries] : [entries])
  ctx.queue = queue
  if (ctx.resumeSkipGen) {
    ctx.resumeSkipGen = false // 恢复首轮沿用 checkpoint 里的 walkGen/loopStates
  } else {
    ctx.walkGen++
  }
  while (queue.length && !ctx.stopped && !ctx.failed && !ctx.cancelled) {
    const node = queue.shift()
    if (!node) continue
    if (node.type === 'loop' && visited.has(node.id)) {
      const own = ctx.loopStates.get(node.id)
      if (!own) {
        // 本代内已耗尽（状态被 pickNext/兜底删除）又重复入队——如 loop 节点自身出边直连
        // 其他循环、或多条边同时指回：再执行会重新解析从头重跑，形成死循环。跳过。
        // 外层换行重入内层不受影响：外层重入时 visited 已被 clear，内层不命中本分支
        continue
      }
      visited.clear()
      ctx.walkGen++
      own.gen = ctx.walkGen
      // 嵌套循环：内层换代会作废外层的代数标记，沿父链同步——否则内层结束后，
      // 外层循环体尾节点连向外层的回连边因代数不匹配被当普通边，外层被无限重跑
      let pid = own.outer?.parentLoopId
      while (pid) {
        const p = ctx.loopStates.get(pid)
        if (!p) break
        p.gen = ctx.walkGen
        pid = p.outer?.parentLoopId
      }
    }
    if (visited.has(node.id)) continue
    visited.add(node.id)
    const label = node.data?.label || node.type
    ctx.nodeState(node, 'running')
    if (!ctx.loop) ctx.log('info', `执行「${label}」`, node)
    // 诊断面包屑：闪退后日志最后一行「节点开始」= 崩溃发生在该节点执行中
    const nodeStart = Date.now()
    dlog(
      runTag(ctx),
      `节点开始 ${node.type}「${label}」id=${node.id}${ctx.loop ? ` 第${ctx.loop.row}/${ctx.loop.total}项` : ''}`,
    )
    let result
    try {
      result = await execNode(ctx, node)
    } catch (err) {
      if (ctx.stopped || ctx.cancelled) {
        dlog(runTag(ctx), `节点中断（停止/取消）${node.type}「${label}」耗时=${Date.now() - nodeStart}ms：${err.message}`)
        // 停止也记录中断点：恢复时从这里重试。不能只清场——循环中停止时 visited 已被
        // 回连逻辑清空过，从画布起点恢复会重跑前置模块（如重新导入表格覆盖已产出的行）。
        // cancelled（并发 worker 被其他 worker 的失败被动唤醒）只在 worker 上出现，
        // 不记 failedAt——它不是失败者，主进程按真失败的 worker 收集续跑集合
        if (!ctx.cancelled) ctx.failedAt = { nodeId: node.id, message: '已停止', stopped: true }
        rollbackExhaustedLoops(ctx)
        return
      }
      ctx.failed = err.message || String(err)
      ctx.failedAt = { nodeId: node.id, message: ctx.failed, iteration: ctx.loop ? { ...ctx.loop } : null }
      ctx.nodeState(node, 'failed', { error: ctx.failed })
      ctx.log('error', `「${label}」失败：${ctx.failed}`, node)
      dlog(runTag(ctx), `节点失败 ${node.type}「${label}」耗时=${Date.now() - nodeStart}ms：${err.stack || err.message}`)
      rollbackExhaustedLoops(ctx)
      await saveCp(ctx, { flush: true })
      return
    }
    ctx.nodeState(node, 'success', { summary: result.summary })
    ctx.log('success', result.summary, node)
    dlog(runTag(ctx), `节点结束 ${node.type}「${label}」耗时=${Date.now() - nodeStart}ms`)
    if (node.type === 'loop' && !result.skipNext) {
      // 循环消费了一项 = 进入新一轮：清空 visited 让循环体整轮重跑；换代作废旧的内层
      // 循环状态（外层换项后内层自动从头重跑）。skipNext（空跳过/已完成跳过）没消费不动。
      // 嵌套：换代沿父链同步外层代数——否则内层换代会作废外层的回连判定，外层被无限重跑
      visited.clear()
      ctx.walkGen++
      const own = ctx.loopStates.get(node.id)
      if (own) {
        own.gen = ctx.walkGen
        let pid = own.outer?.parentLoopId
        while (pid) {
          const p = ctx.loopStates.get(pid)
          if (!p) break
          p.gen = ctx.walkGen
          pid = p.outer?.parentLoopId
        }
      }
    }
    // 节点成功执行后保存断点（loop 节点在 execNode 内部消费一项后已保存）
    if (node.type !== 'loop') {
      await saveCp(ctx)
    }
    for (const next of pickNext(ctx, node, result)) {
      if (!visited.has(next.id) || next.type === 'loop') queue.push(next)
    }
  }
  // 停止/被取消退出（不走上面的 catch，如 pickNext 后恰好在 while 条件处停下）：回退进行中项
  if (ctx.stopped || ctx.cancelled) rollbackExhaustedLoops(ctx)
}

/**
 * 节点执行完选后继：条件节点按结果先选 是/否 边，其余沿全部出边（已按目标 y 排序）。
 * 数据循环的判断点：某节点出边里连回「活跃 loop 节点」= 它是循环体末尾——还有剩余项
 * 就只走回连边（下一轮），循环完则只走出边里的其余分支（循环后的后续模块）。
 * 顺序必须是「先选分支、再判回连」：回连边可能接在条件的任一分支上（是=连回循环继续、
 * 否=跳出很常见），若先按回连边短路，true 也会顺着回连边走成「否」的路线。
 * 数据循环的「结束」出口（sourceHandle=done）：loop 节点消费项时不走它（防提前/重复入队），
 * 循环耗尽时才从它连出到后续模块——嵌套时从内层的结束出口连到外层 = 换外层下一项。
 */
function pickNext(ctx, node, result) {
  let outs = ctx.outEdges.get(node.id) || []
  if (result.skipNext) return []
  if (result.nextOverride) return result.nextOverride
  if (node.type === 'loop') {
    // loop 自身消费一项后的出边不含「结束」出口：那属于循环完成后才走的边
    outs = outs.filter((e) => e.sourceHandle !== 'done')
  }
  if (node.type === 'condition') {
    const want = result.branch ? 'yes' : 'no'
    const chosen = outs.filter((e) => (e.sourceHandle || 'yes') === want)
    if (chosen.length === 0) {
      ctx.log('warn', `分支「${want === 'yes' ? '是' : '否'}」未连接，本条流程到此结束`, node)
      return []
    }
    outs = chosen
  }
  // 回连边逐层判定：节点的出边可能同时连回内外层多个循环（嵌套收口）。最内层还有剩余
  // 就只回它；某层耗尽则删它的状态、恢复上下文，并把该循环「结束」出口的边并入待判定
  // 队列——done 目标是活跃循环（嵌套：内层结束→外层）就回它换下一项，也是耗尽循环就
  // 级联展开其结束出口，全部走完才返回剩余普通出边
  const rest = [...outs]
  for (;;) {
    const backEdge = rest.find((e) => {
      const t = ctx.byId.get(e.target)
      if (t?.type !== 'loop') return false
      const st = ctx.loopStates.get(e.target)
      return st !== undefined && st.gen === ctx.walkGen
    })
    if (!backEdge) break
    const st = ctx.loopStates.get(backEdge.target)
    if (st.index < st.items.length) return [ctx.byId.get(backEdge.target)]
    ctx.loop = st.outer.loop
    ctx.currentRow = st.outer.currentRow
    ctx.currentTableRowIndex = st.outer.currentTableRowIndex ?? null
    ctx.loopStates.delete(backEdge.target)
    ctx.activeLoopId = st.outer.parentLoopId || null
    ctx.completedLoops.add(backEdge.target)
    // 本循环完成：聚合日志行标记完成态（前端停转圈）
    ctx.endLoopAgg?.(ctx, backEdge.target)
    rest.splice(rest.indexOf(backEdge), 1)
    // 耗尽循环的「结束」出口并入待判定（级联：done→耗尽循环→继续展开）
    rest.push(...(ctx.outEdges.get(backEdge.target) || []).filter((e) => e.sourceHandle === 'done'))
  }
  return rest.map((e) => ctx.byId.get(e.target)).filter(Boolean)
}

/**
 * 并发数据循环：起 N 个隐藏窗口（同 partition 共享登录态），数据项轮转分给各进程，
 * 每个进程在自己的 ctx 副本上用同一套 walkFrom 语义反复走循环体。循环体的「出圈边」
 * （体内节点 → 环外后续模块的连线）在各进程的出边视图里被裁掉——后续模块等全部进程
 * 跑完后由父流程统一走一遍；结束时合并提取行与表格。任一进程失败即唤醒其余尽快退出。
 */
async function runConcurrentLoop(ctx, node, name, st, concurrency) {
  const items = st.items
  const n = Math.min(concurrency, items.length)

  const bodyIds = new Set([node.id])
  const exitIds = new Set()
  const dfs = [node.id]
  while (dfs.length) {
    const id = dfs.pop()
    const outs = ctx.outEdges.get(id) || []
    const isTail = id !== node.id && ctx.byId.get(id)?.type !== 'condition' && outs.some((e) => e.target === node.id)
    for (const e of outs) {
      if (e.target === node.id) continue
      // 「结束」出口（done）：循环完成后的走向，不属于循环体——作为出口等全部进程结束后走
      if (e.sourceHandle === 'done') {
        exitIds.add(e.target)
        continue
      }
      if (isTail && !bodyIds.has(e.target)) {
        exitIds.add(e.target)
        continue
      }
      if (!bodyIds.has(e.target)) {
        bodyIds.add(e.target)
        dfs.push(e.target)
      }
    }
  }
  const workerOutEdges = new Map()
  for (const id of bodyIds) {
    workerOutEdges.set(id, (ctx.outEdges.get(id) || []).filter((e) => bodyIds.has(e.target)))
  }
  const exits = [...exitIds].map((id) => ctx.byId.get(id)).filter(Boolean)
  if (exits.length) {
    ctx.log('info', `并发模式：${exits.length} 条跳出循环体的连线，等全部进程结束后再统一走`, node)
  }

  // 是否处于断点续跑模式（失败=只续失败的 worker；停止=续所有留有断点的 worker）
  const resumeWorkerIndexes = ctx.resumeWorkerIndexes
  // 加载 worker 断点（断点续跑用）
  const workerCps = await listWorkerCheckpoints(ctx.projectId, ctx.runId)
  // 基准表 = 当前父表。续跑时它来自主断点（已含各 worker 已写行），重跑 worker 空表起步、
  // 新行直接追加——不重跑的 worker 行天然保留，重跑项的行不重复
  const baseTable = ctx.table
    ? { columns: [...ctx.table.columns], rows: ctx.table.rows.map((r) => ({ ...r })) }
    : null
  const tables = new Array(n).fill(null)
  const mergeTables = () => {
    const cols = baseTable ? [...baseTable.columns] : []
    const rows = baseTable ? [...baseTable.rows] : []
    for (const t of tables) {
      if (!t) continue
      for (const c of t.columns) if (!cols.includes(c)) cols.push(c)
      rows.push(...t.rows)
    }
    if (cols.length || rows.length) {
      ctx.table = { columns: cols, rows }
      ctx.pushTable()
    }
  }

  ctx.log('info', `并发数据循环「${name}」：${items.length} 项分给 ${n} 个进程同时执行`, node)
  dlog(runTag(ctx), `并发循环「${name}」启动：${items.length} 项 × ${n} 进程，续跑集合=[${resumeWorkerIndexes.join(',') || '无'}]`)
  const interceptNodes = [...bodyIds].map((id) => ctx.byId.get(id)).filter((nd) => nd.type === 'intercept')
  const workerCtxs = []
  ctx.workerWins = ctx.workerWins || []

  const spawn = async (i) => {
    // 断点续跑：只重跑断点集合内的 worker，其余 worker 的行/表已在失败/停止时合并进主断点，不重复恢复
    if (resumeWorkerIndexes.length > 0 && !resumeWorkerIndexes.includes(i)) return

    const share = items.filter((_, idx) => idx % n === i)
    const gis = share.map((_, idx) => i + idx * n)
    const cp = resumeWorkerIndexes.includes(i) ? workerCps.find((w) => w.workerIndex === i)?.checkpoint : null
    dlog(runTag(ctx), `并发进程 ${i + 1}/${n} 启动：份额 ${share.length} 项（断点=${cp ? '有' : '无'}）`)

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      title: `爬虫执行窗口 · 进程 ${i + 1}/${n}`,
      // 多窗口错开摆位，避免完全叠在一起看不出「开了多个」
      x: 60 + (i % 6) * 40,
      y: 60 + (i % 6) * 40,
      webPreferences: {
        partition: CRAWLER_PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    ctx.workerWins.push(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 诊断：worker 窗口渲染进程崩溃单独记录（closed 只能看出窗口没了）
    win.webContents.on('render-process-gone', (_evt, details) => {
      dlog(runTag(ctx), `并发进程 ${i + 1} 渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}`)
    })
    await win.loadURL('about:blank')

    const wc = Object.create(ctx)
    let wake
    const ownStop = new Promise((resolve) => {
      wake = resolve
    })
    Object.assign(wc, {
      win,
      finished: false,
      isWorker: true, // 不写主断点，只写自己的 worker 断点
      workerLoopNodeId: node.id,
      // 状态字段必须 own 初始化：原型链继承父 ctx，父.failed 被其他 worker 设置后
      // 本 worker 读 w.failed 会落到父值，被误判为失败者（收集续跑集合时出错）
      failed: null,
      cancelled: false,
      vars: structuredClone(ctx.vars),
      rows: cp?.data?.rows || [],
      rowsStartLen: cp?.data?.rows?.length || 0, // 续跑时之前已并入主断点的行数，结束时只追加新行
      captures: new Map(),
      interceptWaiters: new Map(),
      // 断点续跑不恢复 worker 表：已写行已在主断点的表里（baseTable），重跑空表起步新行追加即可
      table: null,
      currentRow: null,
      currentTableRowIndex: null,
      loop: null,
      loopStates: new Map(),
      visited: new Set(),
      queue: [],
      completedLoops: new Set(),
      walkGen: 0,
      outEdges: workerOutEdges,
      stopPromise: Promise.race([ownStop, ctx.stopPromise]),
      signalStop: wake,
      // 其他 worker 失败时被动唤醒退出：标 cancelled（不算失败，进度存 running 断点可续跑）
      failWatch: () => {
        wc.cancelled = true
        wake()
      },
      // worker 窗口跟随主开关显示：勾了「打开窗口」时每个进程一个窗口，各自在
      // 自己的窗口里跑（打开网页 = 同窗口路由跳转）；此前硬编码 false，勾了开关
      // 也只有主 ctx 的第一个窗口显示，worker 全程隐藏
      showWindow: !!ctx.showWindow,
      forceSeqLoops: new Set([node.id]),
      workerIndex: i,
      activeLoopId: node.id, // worker 的循环即最内层活跃循环
    })
    // worker 日志走父 ctx.log（裸 log 闭包只存在于 run 函数作用域，模块级函数里引用
    // 会 ReferenceError: log is not defined——多进程跑数据处理时 console.log 转发即触发）
    wc.log = (level, message, nd) => ctx.log(level, `[进程${i + 1}] ${message}`, nd, wc)
    // worker 变量实时推前端（推自己的快照，不碰主 ctx.vars）：控制台「变量」Tab 在并发
    // 期间照常随提取/接口拦截更新。循环结束后统一合并回主流程（见 finally 里的 mergeVars）
    wc.pushVars = () => broadcast('crawler:vars', { projectId: ctx.projectId, runId: ctx.runId, vars: { ...wc.vars } })
    wc.nodeState = (nd, status, extra = {}) =>
      broadcast('crawler:node', {
        projectId: ctx.projectId,
        runId: ctx.runId,
        nodeId: nd.id,
        status,
        ...(wc.loop ? { iteration: { ...wc.loop } } : {}),
        ...extra,
      })
    wc.pushTable = () => {
      tables[i] = wc.table ? { columns: [...wc.table.columns], rows: wc.table.rows } : null
      mergeTables()
    }
    win.on('closed', () => {
      if (!wc.finished) {
        // 窗口崩溃：标记本 worker 失败，不直接 stop 全部（父流程会处理断点）
        wc.failed = wc.failed || '窗口意外关闭'
        for (const other of workerCtxs) other.failWatch?.()
      }
    })

    const loopState = {
      items: cp?.loopState?.items || share,
      gis: cp?.loopState?.gis || gis,
      // running 快照可能停在「最后一项已消费、循环体未完成」（index=份额长度）：
      // 夹回最后一项重试，宁可该项重跑不可漏项
      index: Math.max(0, Math.min(cp?.loopState?.index ?? 0, share.length - 1)),
      gen: 1,
      totalItems: items.length,
      outer: { loop: null, currentRow: null },
    }
    wc.loopStates.set(node.id, loopState)
    workerCtxs.push(wc)

    if (interceptNodes.length) {
      try {
        await setupNetworkCapture(wc, interceptNodes)
      } catch {}
    }

    const startUrl = (() => {
      try {
        return ctx.win?.webContents?.getURL?.()
      } catch {
        return ''
      }
    })()
    if (startUrl && startUrl !== 'about:blank' && !/^devtools:/.test(startUrl)) {
      try {
        await withTimeout(wc, win.loadURL(startUrl), 45000, '并发进程起始页加载')
      } catch (err) {
        wc.log('warn', `进程起始页加载失败：${err.message}`)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: n }, (_, i) => spawn(i)))

    const drive = async (wc) => {
      if (wc.workerIndex === undefined) return // 未启动的 worker（断点续跑模式跳过的）
      try {
        await walkFrom(wc, [node])
      } catch (err) {
        if (!wc.cancelled) wc.failed = err.message || String(err)
      }
      const remain = wc.loopStates.get(node.id)
      if (remain && remain.index < remain.items.length && !ctx.stopped && !ctx.failed && !wc.failed && !wc.cancelled) {
        wc.log('warn', `循环体提前结束，剩余 ${remain.items.length - remain.index} 项未执行（循环体内的分支连线走出了循环体外）`)
      }
      if (wc.cancelled && !ctx.stopped && !wc.failed && wc.loopStates.get(node.id)) {
        // 被其他 worker 的失败被动打断且份额未跑完：不是失败者，把进行中的进度存成
        // running 断点并纳入续跑集合——否则它剩下的项永远没人跑（数据缺失）
        await saveWorkerCheckpoint(ctx.projectId, ctx.runId, wc.workerIndex, {
          status: 'running',
          workerIndex: wc.workerIndex,
          loopNodeId: node.id,
          loopState: wc.loopStates.get(node.id),
          data: { rows: wc.rows, table: wc.table, vars: wc.vars },
        })
      }
      if (!wc.failed && !wc.cancelled && !wc.loopStates.get(node.id)) {
        // 份额已正常跑完（循环状态被耗尽删除）：清掉自己的每项快照，
        // 停止/失败收集续跑集合时不会误含已完成者（否则会重跑最后一项造成重复行）
        await removeWorkerCheckpoint(ctx.projectId, ctx.runId, wc.workerIndex)
      }
      if (wc.failed && !ctx.stopped) {
        if (!ctx.failed) {
          ctx.failed = wc.failed
          for (const other of workerCtxs) other.failWatch?.()
        }
        // 保存失败 worker 的断点，续跑时恢复它（多个都失败时各自保存、一起续跑）
        await saveWorkerCheckpoint(ctx.projectId, ctx.runId, wc.workerIndex, {
          status: 'failed',
          workerIndex: wc.workerIndex,
          loopNodeId: node.id,
          loopState: wc.loopStates.get(node.id),
          data: { rows: wc.rows, table: wc.table, vars: wc.vars },
          failedAt: { message: wc.failed },
        })
      }
      // 续跑的 worker 只追加断点之后新产生的行（断点前的行已在失败时并入主断点）
      ctx.rows.push(...wc.rows.slice(wc.rowsStartLen || 0))
    }
    await Promise.all(workerCtxs.map(drive))
  } finally {
    dlog(runTag(ctx), `并发循环收尾：失败=${ctx.failed || '无'} 已停止=${!!ctx.stopped}`)
    mergeTables()
    // worker 变量合并回主流程再推一次：并发期间 worker 各自持有克隆的变量副本，循环
    // 里新写入的变量（如提取数据产出的 tag）只存在于 worker 上——不合并的话循环
    // 结束后主流程后续模块引用不到，控制台的最终变量快照里也看不到
    for (const wc of workerCtxs) {
      if (wc.vars) ctx.vars = { ...ctx.vars, ...wc.vars }
    }
    ctx.pushVars()
    for (const wc of workerCtxs) {
      wc.finished = true
      try {
        if (wc.win.webContents.debugger.isAttached()) wc.win.webContents.debugger.detach()
      } catch {}
      // showWindow 开着时 worker 窗口同样保留（与主窗口一致，供核对各进程最后的页面），
      // 用户手动关即销毁（finished 后 closed 钩子不再触发 failWatch）；没开开关照常收掉
      try {
        if (!wc.win.isDestroyed() && !ctx.showWindow) wc.win.destroy()
      } catch {}
    }
  }

  // 停止：标记所有留有断点的 worker，续跑时各自从自己的进度接着跑。
  // 重新读盘：workerCps 是起跑时的快照，跑动中的每项保存只有盘上是最新的
  if (ctx.stopped) {
    const stoppedIdx = (await listWorkerCheckpoints(ctx.projectId, ctx.runId)).map((w) => w.workerIndex)
    if (stoppedIdx.length) {
      ctx.resumeWorkerIndexes = stoppedIdx
      ctx.resumeNodeId = node.id
      ctx.parentLoopState = { nodeId: node.id, items, totalItems: items.length, concurrency: n }
    }
    return { summary: `并发循环已停止（${items.length} 项 × ${n} 进程）`, nextOverride: [] }
  }
  if (ctx.failed) {
    // 并发失败：续跑集合 = 真失败者们 + 被打断且份额未完的 worker（各自从自己的断点续），
    // 已正常完成的 worker 快照已被清除、不在集合（其余数据已在主断点里）
    const firstFailed = workerCtxs.find((w) => w.failed)
    const resumeIdx = workerCtxs
      .filter((w) => w.failed || (w.cancelled && w.loopStates.get(node.id)))
      .map((w) => w.workerIndex)
    if (firstFailed && resumeIdx.length) {
      ctx.resumeWorkerIndexes = [...new Set(resumeIdx)]
      ctx.resumeNodeId = node.id
      ctx.parentLoopState = {
        nodeId: node.id,
        items,
        index: firstFailed.loopStates.get(node.id)?.index || 0,
        totalItems: items.length,
        concurrency: n,
      }
      await saveCp(ctx, { flush: true })
    }
    throw new Error(ctx.failed)
  }

  // 成功完成：清理 worker 断点与续跑标记
  for (let i = 0; i < n; i++) await removeWorkerCheckpoint(ctx.projectId, ctx.runId, i)
  ctx.resumeWorkerIndexes = []
  ctx.resumeNodeId = null
  ctx.parentLoopState = null
  ctx.completedLoops.add(node.id)
  const tableNote = ctx.table ? `，表格 ${ctx.table.rows.length} 行` : ''
  return { summary: `循环完成：${items.length} 项 × ${n} 进程${tableNote}`, nextOverride: exits }
}

/** 表格导出收尾：每个导出节点各导出一次；失败仅告警，不影响整体结果（数据还在结果面板可手动导出）。 */
async function runExportNodes(ctx, nodes) {
  for (const node of nodes.filter((n) => n.type === 'exportTable')) {
    if (ctx.stopped) break
    ctx.nodeState(node, 'running')
    try {
      if (!ctx.table || !ctx.table.rows.length) {
        throw new Error('没有可导出的表格（流程里需要「导入表格」或「表格编辑」模块先执行）')
      }
      const r = await exportTableFile({
        savePath: node.data?.savePath,
        baseName: node.data?.baseName || ctx.projectName,
        format: node.data?.format === 'json' ? 'json' : 'csv',
        columns: ctx.table.columns,
        rows: ctx.table.rows,
      })
      if (!r.ok) throw new Error(r.error)
      ctx.nodeState(node, 'success', { summary: `已导出 ${ctx.table.rows.length} 行` })
      ctx.log('success', `表格已导出（${ctx.table.rows.length} 行）：${r.path}`, node)
    } catch (err) {
      ctx.nodeState(node, 'failed', { error: err.message })
      ctx.log('warn', `表格导出失败：${err.message}`, node)
    }
  }
}

/** 执行单个节点，返回 { summary, branch? }；循环/分支语义见文件头注释。 */
async function execNode(ctx, node) {
  const wc = ctx.win.webContents
  const data = node.data || {}
  const label = data.label || node.type
  const checkStopped = () => {
    if (ctx.stopped) throw new Error('任务已停止')
  }
  const sel = (s) => (s ? { ...s, value: String(interpolate(s.value ?? '', ctx.vars)) } : s)

  if (node.type === 'webpage') {
    const url = String(interpolate(data.url ?? '', ctx.vars))
    // 变量拼接的 URL 插值后兜底校验：变量为空/不存在时给出明确报错，而不是让
    // loadURL 抛难懂的底层错误
    if (!url) throw new Error(`网址为空：请检查 URL 里拼接的变量是否已赋值（当前配置：${data.url}）`)
    if (!/^https?:\/\//i.test(url)) throw new Error(`网址必须以 http:// 或 https:// 开头，实际得到：${url.slice(0, 120)}`)
    if (ctx.showWindow && !ctx.win.isVisible()) {
      ctx.win.show()
      ctx.win.moveTop()
      ctx.log('info', '已打开执行窗口（本选项勾选时，打开网址会显示浏览器窗口）')
    }
    ctx.log('info', `正在打开 ${url}`)
    await withTimeout(ctx, wc.loadURL(url), 45000, '页面加载')
    checkStopped()
    return { summary: `已打开 ${wc.getURL()}` }
  }

  if (node.type === 'wait') {
    const s = sel(data.selector)
    const timeoutMs = s?.timeoutMs || 10000
    // 等待模式：appear（默认）等元素出现；gone 等元素消失（loading 遮罩/保存中的
    // toast 关闭后再继续，避免后续提取/点击打到还在转圈的页面）
    const waitMode = data.waitMode === 'gone' ? 'gone' : 'appear'
    const labels = { id: 'id', class: 'class', classRegex: 'class 正则', css: 'CSS 选择器' }
    const curLabel = labels[s?.mode] || s?.mode
    ctx.log('info', `等待元素${waitMode === 'gone' ? '消失' : '出现'}：${selectorDesc(s)}（最多等 ${Math.round(timeoutMs / 1000)}s）`, node)
    const runDiag = async () => {
      try {
        const diag = await withTimeout(
          ctx,
          ctx.win.webContents.executeJavaScript(diagnoseScript(s.value), true),
          3000,
          '选择器诊断',
        )
        const counts = diag && typeof diag === 'object' ? diag : {}
        const alts = Object.entries(counts)
          .filter(([m, n]) => m !== s.mode && n > 0)
          .map(([m]) => labels[m] || m)
        return { alts, none: Object.values(counts).every((n) => n === 0) }
      } catch {
        return { alts: [], none: false }
      }
    }
    let hinted = false
    try {
      await pollPage(
        ctx,
        () => waitScript(s, waitMode),
        timeoutMs,
        `等待元素超时(${Math.round(timeoutMs / 1000)}s)：${selectorDesc(s)} 未${waitMode === 'gone' ? '消失' : '出现'}（已穿透 shadow DOM 与 iframe 查找）`,
        (sec) => {
          ctx.log('info', `仍在等待元素${waitMode === 'gone' ? '消失' : ''}：${selectorDesc(s)}（已等 ${sec}s）`, node)
          if (sec >= 5 && !hinted && waitMode === 'appear') {
            hinted = true
            runDiag().then(({ alts }) => {
              if (alts.length && !ctx.stopped) {
                ctx.log(
                  'warn',
                  `提示：页面上已有能被「${alts.join(' / ')}」命中的元素，当前配的是「${curLabel}」——多半模式选错了，继续等大概率超时`,
                  node,
                )
              }
            })
          }
        },
      )
    } catch (err) {
      // 等消失模式超时：提示是元素一直还在（选择器本身能命中，只是页面没关闭它），
      // 诊断建议和出现模式相反
      if (waitMode === 'gone') {
        if (ctx.stopped) throw err
        const { alts, none } = await runDiag()
        let hint = ''
        if (alts.length || (s?.mode && !none)) {
          hint = `。诊断：该元素仍能被当前选择器命中——页面迟迟没有关闭/隐藏它，可延长超时或确认等待目标`
        } else if (none) {
          hint = `。诊断：四种模式都匹配不到该值——选择器可能配错了（元素从未出现过，等消失等于瞬间达成不该超时）`
        }
        throw new Error(err.message + hint)
      }
      if (ctx.stopped || !s?.value || !String(err.message || '').startsWith('等待元素超时')) throw err
      const { alts, none } = await runDiag()
      let hint = ''
      if (alts.length) {
        hint = `。诊断：页面上有能被「${alts.join(' / ')}」模式命中的元素，当前配的是「${curLabel}」——改成能命中的那种即可`
      } else if (none) {
        hint = '。诊断：四种模式都匹配不到该值，元素确实不在当前页面上（注意是否在跨域 iframe / closed shadow root 里）'
      }
      throw new Error(err.message + hint)
    }
    checkStopped()
    return { summary: `元素已${waitMode === 'gone' ? '消失' : '出现'}：${s.value}` }
  }

  if (node.type === 'click') {
    const s = sel(data.selector)
    const timeoutMs = s?.timeoutMs || 5000
    const event = data.event || 'click'
    const target = data.target || 'first'
    // 逐个触发时的间隔：页面动画/请求要时间走完的场景调大（默认 0.12s）。总预算按
    //「元素数上限 × 间隔」放宽，否则间隔一大 withTimeout 会提前掐断还没点完的序列
    const gapMs = Math.max(0, Number(data.gapMs ?? 120))
    const verb = CLICK_EVENTS[event] || '点击'
    ctx.log('info', `正在${verb}元素：${selectorDesc(s)}${target === 'all' ? `（全部依次，间隔 ${(gapMs / 1000).toFixed(gapMs % 1000 ? 2 : 0)}s）` : ''}`, node)
    const budget = timeoutMs + 5000 + (target === 'all' ? 30000 + gapMs * 500 : 0)
    let navResolve
    const onNav = () => navResolve(null)
    const navRace = new Promise((resolve) => {
      navResolve = resolve
      ctx.win.webContents.once('did-navigate', onNav)
    })
    let count = null
    let didNav = false
    try {
      const fired = await withTimeout(
        ctx,
        Promise.race([wc.executeJavaScript(clickScript(s, event, target, timeoutMs, gapMs), true), navRace]),
        budget,
        `触发事件（${verb}）`,
      )
      if (fired === null) {
        didNav = true
        await withTimeout(
          ctx,
          new Promise((resolve) => {
            ctx.win.webContents.once('did-finish-load', resolve)
            ctx.win.webContents.once('did-fail-load', resolve)
            setTimeout(resolve, timeoutMs)
          }),
          timeoutMs,
          '等待跳转加载',
        )
      } else {
        count = fired
      }
    } finally {
      ctx.win.webContents.removeListener('did-navigate', onNav)
    }
    checkStopped()
    if (!didNav && NAV_EVENTS.includes(event)) didNav = await waitPossibleNavigation(ctx.win, timeoutMs)
    checkStopped()
    const scope = target === 'all' && count ? ` ${count} 个元素` : ''
    return { summary: didNav ? `已${verb}${scope}并跳转到 ${wc.getURL()}` : `已${verb}${scope} ${s.value}` }
  }

  if (node.type === 'input') {
    const s = sel(data.selector)
    const text = String(interpolate(data.text ?? '', ctx.vars))
    const timeoutMs = s?.timeoutMs || 5000
    await withTimeout(ctx, wc.executeJavaScript(inputScript(s, text, timeoutMs), true), timeoutMs + 5000, '输入文本')
    checkStopped()
    // 输入内容放前面：摘要只有一行放不下时，截断掉的是选择器尾部而不是输入值
    return { summary: `已输入「${text}」→ ${s.value}` }
  }

  if (node.type === 'keyboard') {
    const s = data.selector?.value ? sel(data.selector) : null
    const timeoutMs = s?.timeoutMs || 5000
    // 填了选择器先聚焦目标元素（复用元素事件的聚焦逻辑，穿透 shadow DOM/iframe），
    // 原生按键才会落在它身上；留空 = 发给当前聚焦元素（如上一步输入的输入框）
    if (s) {
      await withTimeout(ctx, wc.executeJavaScript(clickScript(s, 'focus', 'first', timeoutMs), true), timeoutMs + 5000, '键盘模块聚焦元素')
      checkStopped()
    }
    const key = String(data.key || 'Enter').trim()
    const mods = Array.isArray(data.modifiers) ? data.modifiers.filter(Boolean) : []
    const times = Math.min(Math.max(Number(data.repeat) || 1, 1), 20)
    // 原生键盘事件（sendInputEvent，渲染层收到的是受信任输入）：回车触发表单提交、
    // Backspace 删字符、Tab 移焦点等浏览器默认行为都生效——合成 KeyboardEvent 做不到
    const press = () => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
    }
    for (let i = 0; i < times; i += 1) {
      press()
      if (i < times - 1) await new Promise((r) => setTimeout(r, 80))
    }
    checkStopped()
    // 回车/空格可能提交表单引起跳转：留 500ms 导航窗口（无跳转 waitPossibleNavigation 只等 500ms）
    let navNote = ''
    if (key === 'Enter' || key === 'Space') {
      const didNav = await waitPossibleNavigation(ctx.win, timeoutMs)
      if (didNav) navNote = `，已跳转 ${wc.getURL()}`
    }
    const modLabel = mods.map((m) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' })[m] || m).join('+')
    const scope = s ? `→ ${s.value}` : '→ 当前聚焦元素'
    return { summary: `已按 ${modLabel ? `${modLabel}+` : ''}${key}${times > 1 ? ` ×${times}` : ''} ${scope}${navNote}` }
  }

  if (node.type === 'extract') {
    const fields = (data.fields || []).map((f) => ({ ...f, selector: sel(f.selector) }))
    const timeoutMs = data.timeoutMs || 5000
    // 翻页/跳转后先等 DOM 稳定再提取，避免抓到上一页还没卸载的旧数据
    await waitPageStable(ctx)
    // 超时不报错（软提取）：页面没有目标元素属正常业务分支（详情页无标签、空列表），
    // 返回空数组继续流程，下游 {{字段}} 拿到 []，数据处理可判 length 分流
    let res = null
    try {
      res = await pollPage(
        ctx,
        () => extractScript(fields),
        timeoutMs,
        '提取失败',
        (sec) => ctx.log('info', `字段尚未命中，继续等待提取（已等 ${sec}s）`, node),
      )
    } catch (err) {
      if (ctx.stopped || ctx.cancelled || !String(err.message || '').startsWith('提取失败')) throw err
      const names = fields.map((f) => f.name || f.selector?.value || '未命名')
      for (const n of names) ctx.vars[n] = []
      ctx.pushVars()
      ctx.log('warn', `未提取到数据（${Math.round(timeoutMs / 1000)}s 内无命中）：字段变量置为空数组`, node)
      return { summary: `提取到 0 行（字段：${names.join('、')} 均未命中，已返回空数组）` }
    }
    checkStopped()
    if (res.rows?.length) {
      ctx.rows.push(...res.rows)
      // 变量注入按字段全量命中：单命中 → 值本身；多命中 → 数组（页面挂多个标签/多条
      // 目时 {{tag}} 拿到全部，而不是只有首个）；0 命中 → null（与旧行为一致）
      const multi = []
      for (const c of res.cols || []) {
        ctx.vars[c.name] = c.hits.length > 1 ? c.hits : (c.hits[0] ?? null)
      }
      const fieldNames = []
      for (const c of res.cols || []) {
        fieldNames.push(c.name)
        if (c.hits.length > 1) multi.push(c.name)
      }
      ctx.pushVars()
      const suffix = multi.length ? `；多命中字段为数组：${multi.map((n) => `{{${n}}}`).join('、')}` : ''
      return { summary: `提取到 ${res.rows.length} 行（字段：${(res.fields || fieldNames).join('、')}）${suffix}` }
    }
    return { summary: `提取到 ${res.rows.length} 行（字段：${(res.fields || []).join('、')}）` }
  }

  if (node.type === 'intercept') {
    const varName = String(data.varName ?? '').trim()
    // 已捕获（请求先于节点执行到达）直接写变量；循环里逐行重写，行内后续模块都能用
    const captured = ctx.captures.get(node.id)
    if (captured) {
      // 消费即删：循环里下一行会等新命中的响应（逐行搜索/翻页场景各取各的，不重复拿旧的）
      ctx.captures.delete(node.id)
      ctx.vars[varName] = captured.value
      ctx.pushVars()
      return { summary: `已捕获 ${captured.url} → {{${varName}}}` }
    }
    const timeoutMs = data.timeoutMs || 15000
    ctx.log('info', `等待接口命中：地址含「${data.url}」${data.param ? `、传参含「${data.param}」` : ''}`, node)
    await withTimeout(
      ctx,
      new Promise((resolve) => {
        const set = ctx.interceptWaiters.get(node.id) || new Set()
        set.add(resolve)
        ctx.interceptWaiters.set(node.id, set)
      }),
      timeoutMs,
      '等待接口响应',
    )
    checkStopped()
    const hit = ctx.captures.get(node.id)
    if (!hit) throw new Error('任务已停止') // 正常只有停止/超时会走到这
    ctx.captures.delete(node.id)
    ctx.vars[varName] = hit.value
    ctx.pushVars()
    const size = typeof hit.value === 'string' ? hit.value.length : JSON.stringify(hit.value).length
    return { summary: `已捕获 ${hit.url}（约 ${size} 字符）→ {{${varName}}}` }
  }

  if (node.type === 'loop') {
    // 容错：从别处复制的变量名常带 {{}} 包裹，剥掉再解析
    const name = String(data.varName ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()
    let st = ctx.loopStates.get(node.id)
    // 首次进入、或状态属于更早的遍历代（外层循环换行/换轮）：重新解析变量取最新值。
    // 注意「index 已耗尽」不算重置条件——正常完成的 loop 在 pickNext 里被 delete，
    // 残留的耗尽状态只出现在断点恢复（最后一项循环体进行中被中断），要沿用进度接着跑
    // st.index 严格越界（> 长度）是异常残留，重新解析；恰好 === 长度且代数匹配是断点
    // 恢复的「最后一项循环体进行中」（消费指针已被回退逻辑处理），沿用进度
    if (!st || st.index > st.items.length || st.gen !== ctx.walkGen) {
      const raw = interpolate(`{{${name}}}`, ctx.vars)
      if (raw === '' || raw === null || raw === undefined) {
        throw new Error(`变量「${name}」不存在或为空，无法循环`)
      }
      let items
      let splitNote = ''
      if (Array.isArray(raw)) {
        items = raw
      } else if (typeof raw === 'string') {
        const sepRaw = String(data.split ?? '')
        if (!sepRaw) throw new Error(`变量「${name}」是字符串，请先在模块里填写分割符`)
        const sep = sepRaw.replace(/\\n/g, '\n').replace(/\\t/g, '\t') // 输入框里敲不进换行，\n 转义表示
        items = raw.split(sep).filter((s) => s !== '')
        splitNote = `（按「${sepRaw}」分割）`
      } else {
        throw new Error(`变量「${name}」不是数组也不是字符串（${typeof raw}），无法循环`)
      }
      // parentLoopId：进入本循环时最内层的活跃循环——嵌套场景换代沿父链同步外层代数
      // tableBacked：items 就是导入表格的行（引用判据）——本循环按行下标与表格行对齐，
      // 循环内「表格编辑」写当前行而非新建行
      st = {
        items,
        index: 0,
        gen: ctx.walkGen,
        tableBacked: !ctx.isWorker && Array.isArray(raw) && raw === ctx.tableRowsRef,
        outer: { loop: ctx.loop, currentRow: ctx.currentRow, currentTableRowIndex: ctx.currentTableRowIndex, parentLoopId: ctx.activeLoopId || null },
      }
      ctx.loopStates.set(node.id, st)
      ctx.log('info', `数据循环「${name}」共 ${items.length} 项${splitNote}`, node)
    }
    if (st.items.length === 0) {
      // 空数组/分割后为空：循环体整段跳过（循环后的模块只能经循环体末尾的出边到达）
      ctx.loopStates.delete(node.id)
      ctx.loop = st.outer.loop
      ctx.currentRow = st.outer.currentRow
      ctx.currentTableRowIndex = st.outer.currentTableRowIndex ?? null
      ctx.activeLoopId = st.outer.parentLoopId || null
      ctx.endLoopAgg?.(ctx, node.id)
      ctx.log('warn', `循环变量「${name}」为空，循环体已跳过`, node)
      return { summary: '变量为空，已跳过循环体', skipNext: true }
    }
    // 活跃代数下已耗尽的残留重入（pickNext 逐层判定之外的路径，如用户把后续模块直接
    // 连回已完成的循环）：该循环已完成——恢复上下文后跳过循环体，不重跑也不越界消费。
    // 断点恢复不受影响：保存前的回退已把 index 收回到最后一项以内
    if (st.gen === ctx.walkGen && st.items.length > 0 && st.index >= st.items.length) {
      ctx.loopStates.delete(node.id)
      ctx.loop = st.outer.loop
      ctx.currentRow = st.outer.currentRow
      ctx.currentTableRowIndex = st.outer.currentTableRowIndex ?? null
      ctx.activeLoopId = st.outer.parentLoopId || null
      ctx.endLoopAgg?.(ctx, node.id)
      ctx.log('warn', `循环「${name}」已完成，再次进入时跳过循环体`, node)
      return { summary: '循环已完成，跳过循环体', skipNext: true }
    }
    // 并发模式：分给 N 个隐藏进程各自走循环体（见 runConcurrentLoop）。进程内重入本模块
    // 按单进程语义走（forceSeqLoops 标记），否则每个进程里会再裂变一层进程
    const concurrency = Math.max(1, Math.min(10, Math.round(Number(data.concurrency) || 1)))
    if (concurrency > 1 && !ctx.forceSeqLoops?.has(node.id)) {
      return runConcurrentLoop(ctx, node, name, st, concurrency)
    }
    const item = st.items[st.index]
    const gi = st.gis ? st.gis[st.index] : st.index // 并发份额轮转分配，st.index 不再是全局位置
    st.index += 1
    ctx.currentRow = null // 新一项 = 表格编辑新起一行（在表格行循环内则恢复逻辑见 outer）
    // 本循环直接遍历导入表格的行：表格编辑对齐到当前项的表格行；否则沿用外层行循环
    // 的行下标（嵌套非表格循环不冲掉外层的行指向）
    ctx.currentTableRowIndex = st.tableBacked ? gi : (st.outer.currentTableRowIndex ?? null)
    // 变量合并而非替换：外层变量继续可见；对象项的属性直接平铺成
    // 变量（与表格行一致），任何项都可经 {{当前项}}/{{当前序号}} 引用。
    // itemVar：嵌套循环时 {{当前项}} 就近覆盖（只剩最内层的），各循环配了
    // 「当前项另存为变量」就把自己的项再写一份具名变量，内层体里两层都引用得到
    const itemVar = String(data.itemVar ?? '').trim()
    ctx.vars = {
      ...ctx.vars,
      ...(item !== null && typeof item === 'object' && !Array.isArray(item) ? item : {}),
      ...(itemVar ? { [itemVar]: item } : {}),
      当前项: item,
      当前序号: gi + 1,
    }
    ctx.loop = { row: gi + 1, total: st.totalItems ?? st.items.length }
    ctx.activeLoopId = node.id // 本循环成为最内层活跃循环（嵌套时内层又会在其上覆盖）
    ctx.loopHeartbeat?.(ctx, node) // 循环框心跳：确保本循环的框存在并随迭代刷新
    ctx.pushVars()
    // 断点：消费一项后立即保存（单进程存主断点；并发 worker 存自己的 worker 断点）
    if (ctx.isWorker) await saveWorkerCp(ctx, node.id)
    else await saveCp(ctx)
    return { summary: `第 ${gi + 1}/${st.totalItems ?? st.items.length} 项` }
  }

  if (node.type === 'dataProcess') {
    // 与 loop 一致的容错：变量名带 {{}} 包裹时剥掉
    const name = String(data.varName ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()
    const old = lookupVar(ctx.vars, name)
    if (old === undefined) throw new Error(`变量「${name}」不存在，请检查前面的模块是否已写入`)
    // 结果另存为新变量：填写后处理结果不覆盖原变量，写入这个新变量（留空走原覆盖逻辑）。
    // 声明校验：新变量不能与任何已有变量同名——避免悄悄覆盖别的模块的产出。同一模块
    // 在循环体里重复执行时只校验首次（自己上轮写入的变量不算冲突，断点恢复同样豁免）
    const outName = String(data.outputVar ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()
    if (outName) {
      if ((ctx.declaredOutputs?.[node.id] || null) !== outName) {
        if (lookupVar(ctx.vars, outName) !== undefined) {
          throw new Error(`结果变量「${outName}」已存在，请换一个名字（不能覆盖已有变量）`)
        }
        if (!ctx.declaredOutputs) ctx.declaredOutputs = {}
        ctx.declaredOutputs[node.id] = outName
      }
    }
    const result = await runUserJs(ctx, String(data.code ?? ''), old, ctx.vars, label)
    if (result === undefined) throw new Error(`「${label}」的代码没有 return 结果，变量保持原值`)
    // 摘要截断：大数组/大 JSON 不刷屏
    const shown = (result !== null && typeof result === 'object' ? JSON.stringify(result) : String(result ?? '')).slice(0, 60)
    if (outName) {
      ctx.vars = { ...ctx.vars, [outName]: result }
      ctx.pushVars()
      return { summary: `新变量 {{${outName}}} = ${shown}${shown.length >= 60 ? '…' : ''}` }
    }
    setVar(ctx.vars, name, result)
    ctx.pushVars()
    return { summary: `{{${name}}} = ${shown}${shown.length >= 60 ? '…' : ''}` }
  }

  if (node.type === 'importTable') {
    let parsed
    try {
      parsed = readTableFile(data.filePath) // 运行时重读文件：配置后更新过数据也能拿到最新
    } catch (err) {
      throw new Error(`读取表格失败：${err.message}`)
    }
    const { columns, rows } = parsed
    if (!rows.length) throw new Error('表格文件没有数据行')
    ctx.table = { columns: [...columns], rows }
    ctx.pushTable() // 读入即推：控制台「表格」Tab 先看到原始表，编辑列随后追加
    // 整表写入数组变量（每行一个对象），不隐式循环——要逐行走就把「数据循环」指到该变量
    const varName = String(data.varName ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim() || '表格数据'
    // 行对象拷贝一份：后续表格编辑改 ctx.table 的行不会污染循环数据源
    ctx.vars = { ...ctx.vars, [varName]: rows.map((r) => ({ ...r })) }
    // 记录「表格行源」：后续「数据循环」遍历该变量时（引用判据），循环内「表格编辑」
    // 把列写进当前项对应的原表格行，而不是追加新行
    ctx.tableVarName = varName
    ctx.tableRowsRef = ctx.vars[varName]
    ctx.pushVars()
    return { summary: `已导入 ${rows.length} 行 → {{${varName}}}` }
  }

  if (node.type === 'condition') {
    const lv = interpolate(data.left ?? '', ctx.vars)
    const rv = interpolate(data.right ?? '', ctx.vars)
    const branch = compare(lv, data.op, rv)
    const opLabel = CONDITION_OPS[data.op] || data.op
    // 日志里数组/对象显示 JSON 文本（String([]) 是空串，看不出比的是什么）
    const desc = UNARY_OPS.includes(data.op)
      ? `「${data.left}」${opLabel}`
      : `「${varToString(lv)}」${opLabel}「${varToString(rv)}」`
    return { summary: `${desc} → ${branch ? '是' : '否'}`, branch }
  }

  if (node.type === 'tableEdit') {
    const column = String(data.column ?? '').trim()
    // 整串 {{变量}} 可能取回对象（接口拦截的 JSON）：转 JSON 文本再入表，导出才不是 [object Object]
    const raw = interpolate(data.value ?? '', ctx.vars)
    const value = raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : (raw ?? '')
    // 就地建表、新起一行：直线流程里连续多个表格编辑写同一行；数据循环每换一项新起
    // 一行（loop 节点消费项时清空 currentRow）。例外：循环遍历的是导入表格的行时，
    // currentTableRowIndex 指向当前项的原表格行——编辑直接落到该行（不新建行）
    const tIdx = ctx.currentTableRowIndex
    if (tIdx != null && ctx.table?.rows[tIdx]) ctx.currentRow = ctx.table.rows[tIdx]
    if (!ctx.currentRow) {
      if (!ctx.table) ctx.table = { columns: [], rows: [] }
      ctx.currentRow = {}
      ctx.table.rows.push(ctx.currentRow)
    }
    const existed = ctx.table.columns.includes(column)
    if (!existed) ctx.table.columns.push(column)
    ctx.currentRow[column] = value
    ctx.pushTable()
    return { summary: `${existed ? '更新' : '新增'}列「${column}」= ${value === '' ? '空' : value}` }
  }

  if (node.type === 'exportTable') {
    // 真正的导出统一在流程收尾做（runExportNodes）：摆在循环里也只导一次整表
    return { summary: '已排期：流程结束后统一导出' }
  }

  return { summary: `「${label}」为未知模块类型，已跳过` }
}