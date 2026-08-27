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
// 停止机制：模块级 current 单例，stop 置 stopped、signalStop 唤醒挂起操作并 destroy 隐藏窗口——
// 销毁后 executeJavaScript 的 promise 可能永不 settle，靠 stopPromise 赛道保证「停止」即时生效。
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { clickScript, diagnoseScript, extractScript, inputScript, selectorDesc, stableScript, waitScript } from './crawler-scripts.js'
import { exportTableFile, readTableFile } from './crawler-table.js'

/** 支持的模块类型（与渲染层 constants.js 的模块面板保持一致；导入校验也用它）。 */
export const MODULE_TYPES = [
  'webpage',
  'wait',
  'click',
  'input',
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
  const sandbox = {
    value: copy(value),
    vars: copy(vars),
    // vm 新 realm 自带全部 ECMAScript 内建（Promise/JSON/Math…），缺的是 Node 宿主全局：
    // 定时器（await sleep 类代码）与 fetch 补进来，console 转投运行日志
    setTimeout, clearTimeout, setInterval, clearInterval, fetch,
    console: { log: (...args) => ctx.log('info', `[${label}] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`) },
  }
  let pending
  try {
    pending = vm.runInNewContext(`(async () => {\n${code}\n})()`, sandbox, { timeout: 5000 })
  } catch (err) {
    throw new Error(`「${label}」代码执行出错：${err.message}`)
  }
  try {
    return await withTimeout(ctx, Promise.resolve(pending), 5000, `「${label}」代码执行`)
  } catch (err) {
    throw new Error(`「${label}」${err.message}`)
  }
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

/** 条件比较：双方均为数字（或数字字面量）时按数值比较，否则按字符串。 */
function compare(l, op, r) {
  const ls = l === undefined || l === null ? '' : String(l)
  const rs = r === undefined || r === null ? '' : String(r)
  if (op === 'empty') return ls.trim() === ''
  if (op === 'notEmpty') return ls.trim() !== ''
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

/** 是否有任务在执行。 */
export function isRunning() {
  return current !== null
}

/** 停止当前任务（无任务也返回 ok）。 */
export function stopRun() {
  if (!current) return { ok: true }
  current.stopped = true
  current.signalStop?.() // 唤醒所有挂起的节点执行（销毁窗口后 executeJavaScript 可能永不 settle）
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
    if (ctx.stopped) throw new Error('任务已停止')
    let result = null
    try {
      result = await withTimeout(ctx, ctx.win.webContents.executeJavaScript(makeScript(), true), 3000, '页面检查')
      clean++
    } catch (err) {
      if (ctx.stopped) throw new Error('任务已停止')
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
    if (ctx.stopped) return
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

/**
 * 执行一次爬虫任务。
 * @param {{projectId: string, projectName?: string, graph: object, showWindow?: boolean}} opts
 * @returns {{ok: boolean, error?: string, data?: {runId: string}}}
 */
export function runCrawler({ projectId, projectName, graph, showWindow }) {
  if (current) return { ok: false, error: '已有爬虫任务在执行，请先停止' }
  const nodes = graph?.nodes || []
  if (nodes.length === 0) return { ok: false, error: '画布为空，请先拖入模块节点' }
  for (const n of nodes) {
    const err = validateNode(n)
    if (err) return { ok: false, error: `${err}（点击画布节点可在右侧抽屉补全配置）` }
  }
  const prepared = prepareGraph(graph)
  if (!prepared.ok) return { ok: false, error: prepared.error }

  const runId = randomUUID().slice(0, 8)
  const startedAt = new Date().toISOString()
  let seqCounter = 0

  // rows 挂在 ctx 上：多个 extract 节点的结果顺序拼接，execNode 里也要写入。
  // stopPromise/signalStop：stop 置位后唤醒所有挂起的 withTimeout（见 stopRun 注释）。
  const ctx = {
    projectId,
    projectName: projectName || 'crawler',
    runId,
    stopped: false,
    finished: false,
    failed: null,
    rows: [],
    win: null,
    showWindow: !!showWindow, // 「打开窗口」选项：webpage 节点打开网址时显示执行窗口（默认隐藏跑）
    vars: {}, // 变量作用域：表格当前行 + 提取模块命中的字段
    captures: new Map(), // intercept 节点 id → { url, value }（CDP 捕获的接口响应）
    interceptWaiters: new Map(), // intercept 节点 id → Set<resolve>（执行中等待命中的节点）
    table: null, // { columns: string[], rows: object[] }
    currentRow: null, // 表格编辑的当前写入行（数据循环每换一项重置、就地建表新起一行）
    loop: null, // { row, total } 在循环内时随节点状态推送（画布角标）
    loopStates: new Map(), // loop 节点 id → { items, index, gen, outer: { loop } }（数据循环跨重入的迭代状态）
    walkGen: 0, // 遍历「代数」：新 walk / 循环重入时 +1，旧代的 loop 状态视为过期（重进即重新解析变量）
    byId: prepared.byId,
    outEdges: prepared.outEdges,
    stopPromise: null,
    signalStop: null,
  }
  ctx.stopPromise = new Promise((resolve) => {
    ctx.signalStop = resolve
  })
  current = ctx

  const log = (level, message, node) => {
    broadcast('crawler:log', {
      projectId, runId,
      seq: seqCounter++,
      ts: Date.now(),
      level,
      nodeId: node?.id,
      nodeType: node?.type,
      nodeLabel: node?.data?.label, // 控制台日志行的模块徽标显示节点名（用户改过名比类型名好认）
      message,
    })
  }
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
  // 变量快照推送：每次 vars 变化（提取/拦截/表格换行）广播一次，控制台「变量」Tab 实时跟进
  ctx.pushVars = () => broadcast('crawler:vars', { projectId, runId, vars: { ...ctx.vars } })
  // 表格实时快照推送：导入表格读入、表格编辑每次写入后广播，控制台「表格」Tab 随跑随看
  ctx.pushTable = () =>
    broadcast('crawler:table', {
      projectId,
      runId,
      table: ctx.table ? { columns: [...ctx.table.columns], rows: ctx.table.rows.map((r) => ({ ...r })) } : null,
    })
  ctx.pushVars() // 起跑先推一份空表，控制台立即进入「实时」状态

  // 隐藏执行窗口：backgroundThrottling:false 关键（隐藏窗口的定时器会被 Chromium 节流，
  // 注入脚本的轮询等待依赖它）；partition 见 CRAWLER_PARTITION 注释（持久化登录态）。
  const win = new BrowserWindow({
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
  ctx.win = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })) // 拦 target=_blank 弹窗
  // 隐藏窗口意外销毁（崩溃/外部 kill）时中止任务；finished 标志防止循环正常收尾时的
  // destroy() 反向误标 stopped（destroy 触发的 closed 与收尾代码存在时序竞争）
  win.on('closed', () => {
    if (current === ctx && !ctx.finished) {
      current.stopped = true
      current.signalStop?.() // 窗口意外销毁同样要唤醒挂起的执行
    }
  })

  runState('running')
  log('info', `开始执行：共 ${nodes.length} 个节点`)

  ;(async () => {
    try {
      // 有接口拦截模块才挂 CDP：先 about:blank 把渲染进程拉起来（未导航的隐藏窗口其
      // 渲染进程是惰性创建的，直接挂调试器命令无处投递，~25s 后 target 自毁），且
      // Network.enable 完成后再开跑，防错过页面加载的首批请求
      if (nodes.some((n) => n.type === 'intercept')) {
        try {
          await win.loadURL('about:blank')
          await setupNetworkCapture(ctx, nodes.filter((n) => n.type === 'intercept'))
        } catch (err) {
          throw new Error(`接口拦截初始化失败：${err.message}`)
        }
      }
      if (!ctx.stopped && !ctx.failed) await walkFrom(ctx, prepared.starts)
      // 表格导出统一收尾：无论画布上摆在哪、分支是否走到，跑完（或失败）后各导出一次整表
      if (!ctx.stopped) await runExportNodes(ctx, nodes)
    } catch (err) {
      if (!ctx.failed && !ctx.stopped) ctx.failed = err.message || String(err)
    }
    // 先置 finished 再销毁窗口：closed 事件处理器据此区分「正常收尾」与「意外销毁」
    ctx.finished = true
    try {
      if (!win.isDestroyed()) {
        try {
          if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
        } catch {
          /* detach 失败不影响收尾 */
        }
        win.destroy()
      }
    } catch {
      /* 忽略 */
    }
    if (current === ctx) current = null
    const tablePayload = ctx.table ? { columns: ctx.table.columns, rows: ctx.table.rows } : undefined
    if (ctx.stopped) {
      runState('stopped', { rows: ctx.rows, table: tablePayload })
      log('warn', '任务已停止')
    } else if (ctx.failed) {
      runState('failed', { error: ctx.failed, rows: ctx.rows, table: tablePayload })
    } else {
      runState('done', { rows: ctx.rows, table: tablePayload })
      const parts = []
      if (ctx.rows.length) parts.push(`提取 ${ctx.rows.length} 行`)
      if (ctx.table) parts.push(`表格 ${ctx.table.rows.length} 行`)
      log('success', `执行完成${parts.length ? `：共${parts.join('，')}` : ''}`)
    }
  })()

  return { ok: true, data: { runId } }
}

/**
 * 从入口节点（单个或数组，数组=多个入口共享同一遍 visited，合流不重复执行）沿连线执行：
 * 条件节点按 是/否 结果选边；失败即停（ctx.failed 记录，上层循环据此中断）。
 * 数据循环例外可重入：回连边把 loop 节点再次入队时清空 visited，让循环体整轮重跑
 * （环外节点不会被重新入队，清空 visited 不会重跑循环之前的前置流程）。
 */
async function walkFrom(ctx, entries) {
  const visited = new Set()
  const queue = Array.isArray(entries) ? [...entries] : [entries]
  ctx.walkGen++ // 新一遍 walk（含表格换行）：内层数据循环若残留上一遍的状态，重进时重新解析
  while (queue.length && !ctx.stopped && !ctx.failed) {
    const node = queue.shift()
    if (!node) continue
    if (node.type === 'loop' && visited.has(node.id)) {
      visited.clear()
      ctx.walkGen++ // 循环重入换代：作废嵌套在内层、没跑完就跳出循环体的其他 loop 状态
      const own = ctx.loopStates.get(node.id)
      if (own) own.gen = ctx.walkGen // 本循环自己的迭代进度要延续，不能被换代作废
    }
    if (visited.has(node.id)) continue
    visited.add(node.id)
    const label = node.data?.label || node.type
    ctx.nodeState(node, 'running')
    if (!ctx.loop) ctx.log('info', `执行「${label}」`, node) // 循环内省略开场日志，避免刷屏
    let result
    try {
      result = await execNode(ctx, node)
    } catch (err) {
      if (ctx.stopped) return
      ctx.failed = err.message || String(err)
      ctx.nodeState(node, 'failed', { error: ctx.failed })
      ctx.log('error', `「${label}」失败：${ctx.failed}`, node)
      return
    }
    ctx.nodeState(node, 'success', { summary: result.summary })
    ctx.log('success', result.summary, node)
    for (const next of pickNext(ctx, node, result)) {
      // loop 节点放行重入（回连边目标）；其余节点仍按 visited 去重
      if (!visited.has(next.id) || next.type === 'loop') queue.push(next)
    }
  }
}

/**
 * 节点执行完选后继：条件节点按结果先选 是/否 边，其余沿全部出边（已按目标 y 排序）。
 * 数据循环的判断点：某节点出边里连回「活跃 loop 节点」= 它是循环体末尾——还有剩余项
 * 就只走回连边（下一轮），循环完则只走出边里的其余分支（循环后的后续模块）。
 * 顺序必须是「先选分支、再判回连」：回连边可能接在条件的任一分支上（是=连回循环继续、
 * 否=跳出很常见），若先按回连边短路，true 也会顺着回连边走成「否」的路线。
 */
function pickNext(ctx, node, result) {
  let outs = ctx.outEdges.get(node.id) || []
  if (result.skipNext) return [] // 数据循环变量为空：循环体与后续模块都不走
  if (result.nextOverride) return result.nextOverride // 并发循环收尾：父流程直接续走循环后的模块
  if (node.type === 'condition') {
    const want = result.branch ? 'yes' : 'no'
    const chosen = outs.filter((e) => (e.sourceHandle || 'yes') === want)
    if (chosen.length === 0) {
      ctx.log('warn', `分支「${want === 'yes' ? '是' : '否'}」未连接，本条流程到此结束`, node)
      return []
    }
    outs = chosen
  }
  const backEdge = outs.find((e) => {
    const t = ctx.byId.get(e.target)
    if (t?.type !== 'loop') return false
    const st = ctx.loopStates.get(e.target)
    return st !== undefined && st.gen === ctx.walkGen // 过期状态不算活跃回连边（重进时重新解析）
  })
  if (backEdge) {
    const st = ctx.loopStates.get(backEdge.target)
    if (st.index < st.items.length) return [ctx.byId.get(backEdge.target)]
    ctx.loop = st.outer.loop // 徽标切回外层循环（表格循环/外层数据循环）
    ctx.currentRow = st.outer.currentRow // 表格行上下文也一并还原（循环后置的表格编辑写回当前行）
    ctx.loopStates.delete(backEdge.target)
    return outs.filter((e) => e !== backEdge).map((e) => ctx.byId.get(e.target)).filter(Boolean)
  }
  return outs.map((e) => ctx.byId.get(e.target)).filter(Boolean)
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

  // 循环体集合：从本模块出边 DFS。条件节点不裁边（是/否都可能逐项走——分支走出循环体
  // 属「提前结束」，与单进程语义一致：剩余项放弃，见 drive 的提示）；「尾节点」（非条件、
  // 且回连本模块）在单进程语义里其余出边只有循环耗尽后才走（pickNext 回连短路），这些边
  // 裁出各进程视图，目标收集为循环结束后父流程统一走一遍的入口
  const bodyIds = new Set([node.id])
  const exitIds = new Set()
  const dfs = [node.id]
  while (dfs.length) {
    const id = dfs.pop()
    const outs = ctx.outEdges.get(id) || []
    const isTail = id !== node.id && ctx.byId.get(id)?.type !== 'condition' && outs.some((e) => e.target === node.id)
    for (const e of outs) {
      if (e.target === node.id) continue // 回连边：目标（本模块）已在集合内，不穿过
      if (isTail && !bodyIds.has(e.target)) {
        exitIds.add(e.target) // 尾节点的出圈边：耗尽后才走，进程内裁掉
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

  // 各进程表格实时合并的基准 = 起循环时的父表快照（如导入表格的源行），之上叠各进程的行
  const baseTable = ctx.table ? { columns: [...ctx.table.columns], rows: ctx.table.rows.map((r) => ({ ...r })) } : null
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
  const interceptNodes = [...bodyIds].map((id) => ctx.byId.get(id)).filter((nd) => nd.type === 'intercept')
  const workerCtxs = []
  ctx.workerWins = ctx.workerWins || []

  const spawn = async (i) => {
    // 轮转分配：第 i 进程拿第 i, i+n, i+2n… 项（比整块切分均衡，慢项不堵在队尾）
    const share = items.filter((_, idx) => idx % n === i)
    const gis = share.map((_, idx) => i + idx * n)
    const win = new BrowserWindow({
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
    ctx.workerWins.push(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadURL('about:blank') // 先拉起渲染进程：未导航的隐藏窗口挂 CDP 会自毁
    // 进程 ctx：原型链继承父 ctx（项目信息/broadcast 共享），执行态字段全部自持
    const wc = Object.create(ctx)
    let wake
    const ownStop = new Promise((resolve) => {
      wake = resolve
    })
    Object.assign(wc, {
      win,
      finished: false,
      vars: structuredClone(ctx.vars), // 各进程独立变量作用域（起点 = 起循环时的快照）
      rows: [], // 提取行独立累积，结束时合并
      captures: new Map(),
      interceptWaiters: new Map(),
      table: null,
      currentRow: null,
      loop: null,
      loopStates: new Map(),
      walkGen: 0,
      outEdges: workerOutEdges, // 裁掉出圈边的出边视图
      stopPromise: Promise.race([ownStop, ctx.stopPromise]),
      signalStop: wake,
      failWatch: wake, // 兄弟进程失败时被调用：唤醒本进程挂起中的操作尽快退出
      showWindow: false, // 并发进程一律隐藏
      forceSeqLoops: new Set([node.id]), // 本循环在进程内必须按单进程语义走，否则逐进程再裂变
    })
    wc.log = (level, message, nd) => ctx.log(level, `[进程${i + 1}] ${message}`, nd)
    // 各进程变量互不相同：快照不推送（控制台保持主流程视角），节点状态带本进程的迭代角标
    wc.pushVars = () => {}
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
        ctx.stopped = true
        ctx.signalStop?.()
        for (const other of workerCtxs) other.failWatch?.()
      }
    })
    // 种子循环状态：gen=1 对上 walkFrom 进门的第一代；totalItems/gis 保留全局总数与序号
    wc.loopStates.set(node.id, {
      items: share,
      gis,
      index: 0,
      gen: 1,
      totalItems: items.length,
      outer: { loop: null, currentRow: null },
    })
    workerCtxs.push(wc)
    if (interceptNodes.length) {
      try {
        await setupNetworkCapture(wc, interceptNodes) // 各进程独立捕获：写各自 captures/waiters
      } catch {
        /* 本进程拦截初始化失败不致命：intercept 节点执行时会按超时报错 */
      }
    }
    // 起始页对齐父窗口：循环体一般不含「打开网页」，不导航的话进程一直停在 about:blank，
    // 体内的等待/点击/提取全在空白页上跑（元素永远等不到）。同 partition 共享登录态
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
      try {
        await walkFrom(wc, [node]) // 与单进程同一套语义：回连边驱动逐项
      } catch (err) {
        wc.failed = err.message || String(err)
      }
      const remain = wc.loopStates.get(node.id)
      if (remain && remain.index < remain.items.length && !ctx.stopped && !ctx.failed && !wc.failed) {
        wc.log('warn', `循环体提前结束，剩余 ${remain.items.length - remain.index} 项未执行（循环体内的分支连线走出了循环体外）`)
      }
      if (wc.failed && !ctx.failed && !ctx.stopped) {
        ctx.failed = wc.failed // fail-fast：置父级失败并唤醒兄弟进程
        for (const other of workerCtxs) other.failWatch?.()
      }
      ctx.rows.push(...wc.rows)
    }
    await Promise.all(workerCtxs.map(drive))
  } finally {
    mergeTables()
    for (const wc of workerCtxs) {
      wc.finished = true
      try {
        if (wc.win.webContents.debugger.isAttached()) wc.win.webContents.debugger.detach()
      } catch {
        /* detach 失败不影响收尾 */
      }
      try {
        if (!wc.win.isDestroyed()) wc.win.destroy()
      } catch {
        /* 忽略 */
      }
    }
  }
  if (ctx.stopped) return { summary: `并发循环已停止（${items.length} 项 × ${n} 进程）`, nextOverride: [] }
  if (ctx.failed) throw new Error(ctx.failed)
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
        savePath: node.data?.savePath, // 必填已由 validateNode 保证；目录不存在由 exportTableFile 创建
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
  // 选择器值参与变量插值（循环里按行换关键词搜索这类场景）
  const sel = (s) => (s ? { ...s, value: String(interpolate(s.value ?? '', ctx.vars)) } : s)

  if (node.type === 'webpage') {
    const url = String(interpolate(data.url ?? '', ctx.vars))
    // 「打开窗口」选项：首次打开网址时把执行窗口显示出来（此前含 about:blank 拦截初始化都保持隐藏）
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
    const labels = { id: 'id', class: 'class', classRegex: 'class 正则', css: 'CSS 选择器' }
    const curLabel = labels[s?.mode] || s?.mode
    ctx.log('info', `等待元素出现：${selectorDesc(s)}（最多等 ${Math.round(timeoutMs / 1000)}s）`, node)
    // 选择器诊断：同一值把四种模式各试一遍，返回 { alts: 能命中的其他模式, none: 四种全空 }。
    // 元素明明在页面上却等不到，多半是模式选错（id 写成 class 正则这类）——直说别让人猜
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
        return { alts: [], none: false } // 诊断失败不影响原流程
      }
    }
    let hinted = false
    try {
      await pollPage(
        ctx,
        () => waitScript(s),
        timeoutMs,
        `等待元素超时(${Math.round(timeoutMs / 1000)}s)：${selectorDesc(s)} 未出现（已穿透 shadow DOM 与 iframe 查找）`,
        (sec) => {
          ctx.log('info', `仍在等待元素：${selectorDesc(s)}（已等 ${sec}s）`, node)
          // 等 5s 还没命中就提前探一次：模式选错的话立刻提示，不必干等到超时
          if (sec >= 5 && !hinted) {
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
    return { summary: `元素已出现：${s.value}` }
  }

  if (node.type === 'click') {
    const s = sel(data.selector)
    const timeoutMs = s?.timeoutMs || 5000
    const event = data.event || 'click'
    const target = data.target || 'first'
    const verb = CLICK_EVENTS[event] || '点击'
    ctx.log('info', `正在${verb}元素：${selectorDesc(s)}${target === 'all' ? '（全部依次）' : ''}`, node)
    // 全部依次 = 命中数 × 120ms 间隔，硬超时放宽 30s 余量，避免批量触发被误判超时
    const budget = timeoutMs + 5000 + (target === 'all' ? 30000 : 0)
    // 批量触发中途可能引起跳转：脚本上下文随导航销毁后 executeJavaScript 永不 settle，
    // 与 did-navigate 赛跑——跳转先到就按「已触发并跳转」处理，等加载完继续，不干等超时报错
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
        Promise.race([wc.executeJavaScript(clickScript(s, event, target, timeoutMs), true), navRace]),
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
    return { summary: `已在 ${s.value} 输入「${text}」` }
  }

  if (node.type === 'extract') {
    const fields = (data.fields || []).map((f) => ({ ...f, selector: sel(f.selector) }))
    const timeoutMs = data.timeoutMs || 5000
    // 翻页/跳转后先等 DOM 稳定再提取，避免抓到上一页还没卸载的旧数据
    await waitPageStable(ctx)
    const res = await pollPage(
      ctx,
      () => extractScript(fields),
      timeoutMs,
      `提取失败：所有字段的选择器在 ${Math.round(timeoutMs / 1000)}s 内均未命中元素`,
      (sec) => ctx.log('info', `字段尚未命中，继续等待提取（已等 ${sec}s）`, node),
    )
    checkStopped()
    if (res.rows?.length) {
      ctx.rows.push(...res.rows)
      // 首条命中的字段注入变量作用域，供后续 逻辑判断/表格编辑/网址 引用
      Object.assign(ctx.vars, res.rows[0])
      ctx.pushVars()
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
    // 首次进入、上一轮已耗尽又重进、或状态属于更早的遍历代（外层循环换行/换轮）：
    // 一律重新解析变量取最新值
    if (!st || st.index >= st.items.length || st.gen !== ctx.walkGen) {
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
      st = { items, index: 0, gen: ctx.walkGen, outer: { loop: ctx.loop, currentRow: ctx.currentRow } }
      ctx.loopStates.set(node.id, st)
      ctx.log('info', `数据循环「${name}」共 ${items.length} 项${splitNote}`, node)
    }
    if (st.index >= st.items.length) {
      // 空数组/分割后为空：循环体整段跳过（循环后的模块只能经循环体末尾的出边到达）
      ctx.loopStates.delete(node.id)
      ctx.loop = st.outer.loop
      ctx.currentRow = st.outer.currentRow
      ctx.log('warn', `循环变量「${name}」为空，循环体已跳过`, node)
      return { summary: '变量为空，已跳过循环体', skipNext: true }
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
    // 变量合并而非替换：外层变量继续可见；对象项的属性直接平铺成
    // 变量（与表格行一致），任何项都可经 {{当前项}}/{{当前序号}} 引用
    ctx.vars = {
      ...ctx.vars,
      ...(item !== null && typeof item === 'object' && !Array.isArray(item) ? item : {}),
      当前项: item,
      当前序号: gi + 1,
    }
    ctx.loop = { row: gi + 1, total: st.totalItems ?? st.items.length }
    ctx.pushVars()
    return { summary: `第 ${gi + 1}/${st.totalItems ?? st.items.length} 项` }
  }

  if (node.type === 'dataProcess') {
    // 与 loop 一致的容错：变量名带 {{}} 包裹时剥掉
    const name = String(data.varName ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()
    const old = lookupVar(ctx.vars, name)
    if (old === undefined) throw new Error(`变量「${name}」不存在，请检查前面的模块是否已写入`)
    const result = await runUserJs(ctx, String(data.code ?? ''), old, ctx.vars, label)
    if (result === undefined) throw new Error(`「${label}」的代码没有 return 结果，变量保持原值`)
    setVar(ctx.vars, name, result)
    ctx.pushVars()
    // 摘要截断：大数组/大 JSON 不刷屏
    const shown = (result !== null && typeof result === 'object' ? JSON.stringify(result) : String(result ?? '')).slice(0, 60)
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
    const varName = String(data.varName ?? '').trim() || '表格数据'
    // 行对象拷贝一份：后续表格编辑改 ctx.table 的行不会污染循环数据源
    ctx.vars = { ...ctx.vars, [varName]: rows.map((r) => ({ ...r })) }
    ctx.pushVars()
    return { summary: `已导入 ${rows.length} 行 → {{${varName}}}` }
  }

  if (node.type === 'condition') {
    const lv = interpolate(data.left ?? '', ctx.vars)
    const rv = interpolate(data.right ?? '', ctx.vars)
    const branch = compare(lv, data.op, rv)
    const opLabel = CONDITION_OPS[data.op] || data.op
    const desc = UNARY_OPS.includes(data.op)
      ? `「${data.left}」${opLabel}`
      : `「${lv}」${opLabel}「${rv}」`
    return { summary: `${desc} → ${branch ? '是' : '否'}`, branch }
  }

  if (node.type === 'tableEdit') {
    const column = String(data.column ?? '').trim()
    // 整串 {{变量}} 可能取回对象（接口拦截的 JSON）：转 JSON 文本再入表，导出才不是 [object Object]
    const raw = interpolate(data.value ?? '', ctx.vars)
    const value = raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : (raw ?? '')
    // 就地建表、新起一行：直线流程里连续多个表格编辑写同一行；数据循环每换一项新起
    // 一行（loop 节点消费项时清空 currentRow）
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
