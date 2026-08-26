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
// - 导入表格 = 循环节点：每行数据走一遍后继子流程，ctx.loop 携带 {row,total} 随节点状态
//   推送到画布（节点角标显示 3/10），画布因此能看到逐行轮询
// - 逻辑判断 = 分支节点：结果为 是/否，分别沿 sourceHandle 为 yes/no 的连线走，未连接的分支结束本条
// - 表格编辑：给当前行赋值（列不存在则创建）；表格导出：统一在流程结束后导出一次整表
//
// 停止机制：模块级 current 单例，stop 置 stopped、signalStop 唤醒挂起操作并 destroy 隐藏窗口——
// 销毁后 executeJavaScript 的 promise 可能永不 settle，靠 stopPromise 赛道保证「停止」即时生效。
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { clickScript, extractScript, inputScript, waitScript } from './crawler-scripts.js'
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
  'condition',
  'tableEdit',
  'exportTable',
]

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
    return { ok: false, error: '流程存在环或缺少起点，无法确定执行顺序（请检查连线）' }
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
    currentRow: null, // 导入表格循环中的当前行（表格编辑写入目标）
    loop: null, // { row, total } 在循环内时随节点状态推送（画布角标）
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
 */
async function walkFrom(ctx, entries) {
  const visited = new Set()
  const queue = Array.isArray(entries) ? [...entries] : [entries]
  while (queue.length && !ctx.stopped && !ctx.failed) {
    const node = queue.shift()
    if (!node || visited.has(node.id)) continue
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
      if (!visited.has(next.id)) queue.push(next)
    }
  }
}

/** 节点执行完选后继：条件节点按结果选 是/否 边，其余沿全部出边（已按目标 y 排序）。 */
function pickNext(ctx, node, result) {
  const outs = ctx.outEdges.get(node.id) || []
  if (node.type === 'importTable') {
    // 出边属于循环体，execNode 里已按行走完；这里再走会脱离行上下文重跑一遍
    return []
  }
  if (node.type === 'condition') {
    const want = result.branch ? 'yes' : 'no'
    const edge = outs.find((e) => (e.sourceHandle || 'yes') === want)
    if (!edge) {
      ctx.log('warn', `分支「${want === 'yes' ? '是' : '否'}」未连接，本条流程到此结束`, node)
      return []
    }
    const t = ctx.byId.get(edge.target)
    return t ? [t] : []
  }
  return outs.map((e) => ctx.byId.get(e.target)).filter(Boolean)
}

/** 表格导出收尾：每个导出节点各导出一次；失败仅告警，不影响整体结果（数据还在结果面板可手动导出）。 */
async function runExportNodes(ctx, nodes) {
  for (const node of nodes.filter((n) => n.type === 'exportTable')) {
    if (ctx.stopped) break
    ctx.nodeState(node, 'running')
    try {
      if (!ctx.table || !ctx.table.rows.length) {
        throw new Error('没有可导出的表格（流程里需要「导入表格」模块先执行）')
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
    await withTimeout(ctx, wc.executeJavaScript(waitScript(s, s?.timeoutMs), true), (s?.timeoutMs || 10000) + 5000, '等待元素')
    checkStopped()
    return { summary: `元素已出现：${s.value}` }
  }

  if (node.type === 'click') {
    const s = sel(data.selector)
    const timeoutMs = s?.timeoutMs || 5000
    await withTimeout(ctx, wc.executeJavaScript(clickScript(s, timeoutMs), true), timeoutMs + 5000, '点击')
    checkStopped()
    const didNav = await waitPossibleNavigation(ctx.win, timeoutMs)
    checkStopped()
    return { summary: didNav ? `已点击并跳转到 ${wc.getURL()}` : `已点击 ${s.value}` }
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
    const res = await withTimeout(
      ctx,
      wc.executeJavaScript(extractScript(fields, data.timeoutMs), true),
      (data.timeoutMs || 5000) + 10000,
      '提取数据',
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
    ctx.log('info', `已读取表格：${rows.length} 行 × ${columns.length} 列（${columns.join('、')}）`)

    const nexts = (ctx.outEdges.get(node.id) || []).map((e) => ctx.byId.get(e.target)).filter(Boolean)
    // 保存外层上下文（表格嵌套表格时内层跑完能回到外层行）
    const outer = { loop: ctx.loop, vars: ctx.vars, currentRow: ctx.currentRow }
    for (let i = 0; i < rows.length; i++) {
      if (ctx.stopped || ctx.failed) break
      ctx.currentRow = rows[i]
      ctx.vars = { ...rows[i] }
      ctx.pushVars()
      ctx.loop = { row: i + 1, total: rows.length }
      ctx.nodeState(node, 'running')
      const brief = columns.slice(0, 3).map((c) => `${c}=${rows[i][c]}`).join(' ')
      ctx.log('info', `── 第 ${i + 1}/${rows.length} 行：${brief}`, node)
      await walkFrom(ctx, nexts)
      if (!ctx.stopped && !ctx.failed) ctx.nodeState(node, 'success')
    }
    Object.assign(ctx, outer)
    ctx.pushVars() // 循环结束回到外层变量作用域，面板同步切回（避免停留在最后一行的值）
    if (ctx.stopped) throw new Error('任务已停止')
    if (ctx.failed) throw new Error(ctx.failed)
    return { summary: `表格循环完成：${rows.length} 行` }
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
    if (!ctx.currentRow) throw new Error('表格编辑需要在「导入表格」的循环流程内使用')
    const column = String(data.column ?? '').trim()
    // 整串 {{变量}} 可能取回对象（接口拦截的 JSON）：转 JSON 文本再入表，导出才不是 [object Object]
    const raw = interpolate(data.value ?? '', ctx.vars)
    const value = raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : (raw ?? '')
    const existed = ctx.table.columns.includes(column)
    if (!existed) ctx.table.columns.push(column)
    ctx.currentRow[column] = value
    return { summary: `${existed ? '更新' : '新增'}列「${column}」= ${value === '' ? '空' : value}` }
  }

  if (node.type === 'exportTable') {
    // 真正的导出统一在流程收尾做（runExportNodes）：摆在循环里也只导一次整表
    return { summary: '已排期：流程结束后统一导出' }
  }

  return { summary: `「${label}」为未知模块类型，已跳过` }
}
