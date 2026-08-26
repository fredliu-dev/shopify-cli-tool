import { BrowserWindow, ipcMain, protocol, session, shell } from 'electron'
import { join } from 'node:path'

const load = () => import('@shopify-cli-tool/core')

// TAPD 网页登录窗口引用（取图 Cookie 用；窗口在 tapd:openLogin handler 里创建）
let loginWindow = null

// 伪装成浏览器的图片请求头：file.tapd.cn 的 WAF 对无 UA 裸请求返回 1 字节 HTML 干扰判断
// （UA 用 Windows 身份，与应用主要用户群一致）
const IMG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  Referer: 'https://www.tapd.cn/',
}

// 窗口内链接一律转系统浏览器：富文本里 Ctrl/Cmd+点击会被 Chromium 当「新标签打开」
// 走 window.open，不拦会弹出裸 Electron 窗口（普通点击由渲染层 onRichContentClick 处理）
const openExternalOnly = ({ url }) => {
  if (/^https?:/i.test(url)) shell.openExternal(url)
  return { action: 'deny' }
}

// 从会话 Cookie jar 取「会发给该 URL 的 Cookie」（按域+路径规则匹配，含 host-only 与 .tapd.cn 域 Cookie）
async function cookieHeaderFor(url) {
  const list = await session.defaultSession.cookies.get({ url })
  return list.map((c) => `${c.name}=${c.value}`).join('; ')
}

// 把响应的 Set-Cookie 写回会话 Cookie jar：登录跳转链中途下发的票据 Cookie 必须存下来，
// 后续跳转与后续图片请求才认。electron#8891/#44456 表明 net 模块/net.fetch 的 Cookie
// 回发语义不可靠，因此取图代理全程手动管 Cookie（读 jar → 带上 → 存回 jar）。
async function storeSetCookies(url, res) {
  const lines = res.headers.getSetCookie?.() || []
  for (const line of lines) {
    const [pair, ...attrs] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const opt = {
      url,
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      path: '/',
    }
    for (const attr of attrs) {
      const [k, v] = attr.split('=')
      const key = (k || '').trim().toLowerCase()
      const val = (v || '').trim()
      if (key === 'domain') opt.domain = val.replace(/^\./, '')
      else if (key === 'path') opt.path = val || '/'
      else if (key === 'expires') {
        const t = Date.parse(val)
        if (Number.isFinite(t)) opt.expirationDate = Math.floor(t / 1000)
      } else if (key === 'max-age') {
        const n = parseInt(val, 10)
        if (Number.isFinite(n)) opt.expirationDate = Math.floor(Date.now() / 1000) + n
      } else if (key === 'httponly') opt.httpOnly = true
      else if (key === 'secure') opt.secure = true
    }
    try {
      await session.defaultSession.cookies.set(opt)
    } catch {
      /* 过期即删除等场景 set 会报错，忽略 */
    }
  }
}

// 图片魔数嗅探：TAPD 文件域的 Content-Type 不规范（实测可能只回 "image" 不带子类型），
// 不能信它判断成败/定类型，按文件头识别
function sniffImage(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length > 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  if (buf.length > 5 && buf.toString('ascii', 0, 5) === '<svg ') return 'image/svg+xml'
  return ''
}

/**
 * tapd-img://<host>/<path> → https://<host>/<path>，主进程代理取图并手动管 Cookie。
 * 富文本图片（/tfl/captures/...）直连 file.tapd.cn 会 302 到登录页，个人访问令牌也不被文件域名接受，
 * 只有「网页登录过一次」的会话 Cookie 才能取到；取图要经历 登录页验证→带票据跳回 的多跳重定向，
 * 每跳都可能下发新 Cookie，故逐跳 manual redirect + 读写 Cookie jar。
 * 成败判定以内容为准（魔数嗅探出图片类型或 content-type 为 image/*），登录页 HTML 按 401 返回。
 */
function registerTapdImageProtocol() {
  protocol.handle('tapd-img', async (request) => {
    try {
      const u = new URL(request.url)
      // 只代理 tapd.cn 域，防止该协议被拿来当任意 SSRF 跳板
      if (!/(^|\.)tapd\.cn$/i.test(u.host)) return new Response(null, { status: 403 })
      let current = `https://${u.host}${u.pathname}${u.search}`
      let res
      for (let hop = 0; hop < 8; hop += 1) {
        const cookie = await cookieHeaderFor(current)
        res = await fetch(current, {
          headers: { ...IMG_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
          redirect: 'manual',
        })
        await storeSetCookies(current, res)
        if (![301, 302, 303, 307, 308].includes(res.status)) break
        const loc = res.headers.get('location')
        if (!loc) break
        current = new URL(loc, current).toString()
      }
      const type = res?.headers.get('content-type') || ''
      const buf = res ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0)
      const sniffed = sniffImage(buf)
      const isHtml = /text\/html/i.test(type) || (!sniffed && /^</.test(buf.toString('utf8', 0, 16)))
      const ok = res?.ok && !isHtml && (sniffed || type.startsWith('image/')) && buf.length > 0
      console.log(`[tapd-img] ${u.pathname} -> ${res?.status} ct=${JSON.stringify(type)} sniff=${sniffed || '-'} ${buf.length}B`)
      if (!ok) {
        return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } })
      }
      const contentType = type.startsWith('image/') ? type.split(';')[0].trim() : sniffed
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
      })
    } catch (err) {
      console.log('[tapd-img] error:', err?.message)
      return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
  })
}

/**
 * 探测 TAPD 网页登录态：直接请求登录页并跟随跳转——已登录时登录页会 302 跳走
 * （回首页/continue 目标），未登录时 200 停在登录表单。
 * 旧探测（请求 file.tapd.cn 的探针图、按落点 URL 是否含 login 判定）已失效：实测
 * 文件域对不存在的路径直接回 200 + 1 字节 "0"（WAF），落点永不含 login 字样，
 * 未登录也被判成已登录（表现为退出后/登录后状态显示都不对）。现以内容为准：
 * 停在登录页 URL 或 HTML 含密码输入框 = 未登录。跳转链 Cookie 照常存回会话。
 * checkLogin IPC 与登录窗口的「登录成功自动关窗」共用此函数
 */
async function probeTapdLogin() {
  let current = 'https://www.tapd.cn/cloud_logins/login?site=TAPD'
  const chain = []
  for (let hop = 0; hop < 8; hop += 1) {
    const cookie = await cookieHeaderFor(current)
    const res = await fetch(current, {
      headers: {
        'User-Agent': IMG_HEADERS['User-Agent'],
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: 'https://www.tapd.cn/',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'manual',
    })
    await storeSetCookies(current, res)
    chain.push(`${res.status} ${current}`)
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) break
      current = new URL(loc, current).toString()
      continue
    }
    const type = res.headers.get('content-type') || ''
    const body = /text\/html/i.test(type) ? await res.text() : ''
    const loginForm =
      /cloud_logins\/login/i.test(current) || /<input[^>]+type=["']?password/i.test(body)
    const loggedIn = !loginForm
    console.log(`[tapd] checkLogin: loggedIn=${loggedIn} <- ${chain.join(' -> ')}`)
    return loggedIn
  }
  // 8 跳全是重定向没落地：能被一路弹走说明会话有效
  console.log(`[tapd] checkLogin: loggedIn=true <- ${chain.join(' -> ')}`)
  return true
}

/**
 * tapd 域 IPC handlers：配置 CRUD、工单列表（cache-first）、状态映射/流转、独立窗口。
 * 数据与凭据落 userDataDir()/tapd.json；列表/元信息缓存落 tapd-cache.json（流转成功后失效）。
 * 凭据缺失时 core 抛 'NO_TAPD_AUTH'，原样透传给前端显示凭据表单（同 git.js 的 NO_TOKEN 约定）。
 */
export function registerTapdIpc() {
  // 富文本图片代理协议（scheme 特权已在 main.js 于 app ready 前注册）
  registerTapdImageProtocol()

  // 探测 TAPD 网页登录态（富文本图片需要）：见 probeTapdLogin（IPC 探测与登录窗口自动关窗共用）
  ipcMain.handle('tapd:checkLogin', async () => {
    try {
      return { ok: true, data: { loggedIn: await probeTapdLogin() } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 打开 TAPD 网页登录窗口（登录后 Cookie 存入应用会话，工单图片即可显示）。
  // 登录窗口关闭时才 resolve，渲染层 await 后自动重载图片
  ipcMain.handle('tapd:openLogin', () => {
    return new Promise((resolve) => {
      try {
        if (loginWindow && !loginWindow.isDestroyed()) {
          if (loginWindow.isMinimized()) loginWindow.restore()
          loginWindow.focus()
          resolve({ ok: true, reused: true })
          return
        }
        loginWindow = new BrowserWindow({
          width: 1100,
          height: 760,
          title: '登录 TAPD（用于显示工单图片）',
          backgroundColor: '#0d0d0f',
          webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        })
        loginWindow.webContents.setWindowOpenHandler(openExternalOnly)
        // 登录成功自动关窗：登录完成后页面会跳离登录域（首页/工作台），此时探测一次会话，
        // 有效即 close——closed 事件会 resolve openLogin，渲染层随即复检登录态并重载图片。
        // 仍在登录域内的导航（含 login/cloud_logins/passport）不探测，避免进页面就误触发
        let probing = false
        loginWindow.webContents.on('did-navigate', async (_evt, url) => {
          if (probing || !loginWindow || loginWindow.isDestroyed()) return
          if (!/^https?:/i.test(url) || /cloud_logins|passport|login/i.test(url)) return
          probing = true
          try {
            if (await probeTapdLogin()) loginWindow.close()
          } catch {
            /* 探测失败不关窗，用户手动关时 openLogin 照常 resolve */
          } finally {
            probing = false
          }
        })
        loginWindow.on('closed', () => {
          loginWindow = null
          resolve({ ok: true })
        })
        loginWindow.loadURL('https://www.tapd.cn/cloud_logins/login?site=TAPD')
      } catch (err) {
        resolve({ ok: false, error: err.message })
      }
    })
  })

  // 退出 TAPD 网页登录：清掉会话里全部 tapd.cn 域 Cookie（图片代理与登录探测认的就是它们），
  // 顺带关掉登录窗口（其 closed 事件会让挂起的 openLogin resolve，渲染层随即复检到未登录）。
  // Electron 的 remove(url, name) 按「该 URL 会收到哪些 Cookie」反查，对 URL 拼法挑剔
  // （host-only/域 Cookie、secure、路径都影响匹配），单条失败曾被静默吞掉且仍返回成功——
  // 表现为「点了退出，重开弹窗还是已登录」。因此：每条 Cookie 多变体 URL 轮试 remove、
  // 仍不行用过期 set 覆写，删完复读 Cookie jar 验证；还有残留则升级 clearStorageData
  // 清全部 Cookie（本应用默认会话只有 TAPD 登录窗口加载外部页面，全清不伤其它业务）
  ipcMain.handle('tapd:logout', async () => {
    try {
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy()
      const tapdCookies = async () => {
        const all = await session.defaultSession.cookies.get({})
        return all.filter((c) => /(^|\.)tapd\.cn$/i.test(c.domain || ''))
      }
      const targets = await tapdCookies()
      for (const c of targets) {
        const host = (c.domain || '').replace(/^\./, '')
        const path = c.path || '/'
        // 同一条 Cookie 的多种删除 URL：协议 × 域 Cookie 用裸域/子域 × 路径，覆盖各类匹配口径
        const urls = [
          `https://${host}${path}`,
          `http${c.secure ? 's' : ''}://${host}${path}`,
          `https://www.${host}${path}`,
          `https://${host}/`,
        ]
        let removed = false
        for (const url of urls) {
          try {
            await session.defaultSession.cookies.remove(url, c.name)
            removed = true
          } catch {
            /* 该拼法不匹配，换下一种 */
          }
        }
        if (!removed) {
          // 兜底：同名同域覆写一条已过期的 Cookie，等价删除（remove 全部拼法不匹配时）
          try {
            await session.defaultSession.cookies.set({
              url: `https://${host}/`,
              name: c.name,
              value: c.value,
              domain: host,
              path,
              secure: !!c.secure,
              httpOnly: !!c.httpOnly,
              expirationDate: 1, // 1970，即刻过期
            })
          } catch {
            /* 过期覆写也失败则交给下面的全清兜底 */
          }
        }
      }
      let remaining = (await tapdCookies()).length
      if (remaining > 0) {
        // 变体删除后仍有残留（顽固 Cookie）：清会话全部 Cookie。默认会话只服务 TAPD，安全
        await session.defaultSession.clearStorageData({ storages: ['cookies'] })
        remaining = (await tapdCookies()).length
      }
      console.log(`[tapd] logout: removed=${targets.length} remaining=${remaining}`)
      if (remaining > 0) {
        return { ok: false, error: `仍有 ${remaining} 条 Cookie 未能清除，请重启应用后再试` }
      }
      return { ok: true, data: { removed: targets.length } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // TAPD 工单页已并入主窗口（左侧栏切换），不再有独立窗口 / showMain 聚焦逻辑；
  // 网页登录窗口（tapd:openLogin）仍是独立 BrowserWindow。

  // 读取配置（{ token, workspaceId, recentWorkspaceIds }）
  ipcMain.handle('tapd:loadConfig', async () => {
    const { loadTapdConfig } = await load()
    try {
      return { ok: true, data: loadTapdConfig() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 浅合并保存配置（凭据/默认 workspace）
  ipcMain.handle('tapd:saveConfig', async (_evt, patch) => {
    const { saveTapdConfig } = await load()
    try {
      return { ok: true, data: saveTapdConfig(patch || {}) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // API 账号参与的项目列表（workspace 下拉候选）
  ipcMain.handle('tapd:workspaces', async () => {
    const { listWorkspaces } = await load()
    try {
      return { ok: true, data: await listWorkspaces() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 校验手填 workspace_id 并取项目名
  ipcMain.handle('tapd:workspaceInfo', async (_evt, workspaceId) => {
    const { getWorkspaceInfo } = await load()
    try {
      return { ok: true, data: await getWorkspaceInfo(workspaceId) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 校验当前凭据并取用户昵称（保存凭据后即时反馈有效性）
  ipcMain.handle('tapd:user', async () => {
    const { getTapdUser } = await load()
    try {
      return { ok: true, data: await getTapdUser() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 本地 projects.json 各项目 _tapd 链接解析出的 workspace_id 推荐（零配置可用）
  ipcMain.handle('tapd:suggestWorkspaces', async () => {
    const { suggestWorkspaceIds } = await load()
    try {
      return { ok: true, data: suggestWorkspaceIds() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 工单列表：默认读缓存（秒开），force=true 清缓存重拉（仿 repos:depGraph）；owner 为「只看我的」服务端过滤
  ipcMain.handle('tapd:list', async (_evt, { type, workspaceId, status, iterationId, owner, force } = {}) => {
    const { listWorkItems, loadTapdCache, saveTapdCache } = await load()
    try {
      const key = `list:${workspaceId}:${type}:${status || ''}:${iterationId || ''}:${owner || ''}`
      if (!force) {
        const cached = loadTapdCache()[key]
        if (cached) return { ok: true, cached: true, savedAt: cached.savedAt, data: cached.data }
      }
      const data = await listWorkItems(type, { workspaceId, status, iterationId, owner })
      saveTapdCache(key, data)
      return { ok: true, cached: false, savedAt: Date.now(), data }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 初始化弹窗「选择工单」下拉候选：当前账号自己的、未到终态的三类工单合并（按 id 倒序）。
  // owner 走服务端过滤；「排除已完成」客户端判定（终态集合优先、statusMap 中文名关键词兜底，
  // 与 TAPD 页 bucketOf 同口径）；三类串行拉取防限流。未配令牌时 NO_TAPD_AUTH 原样透传，前端显示「去配置」
  ipcMain.handle('tapd:myOpenItems', async (_evt, { workspaceId, force } = {}) => {
    const { getTapdUser, listWorkItems, getStatusMap, getLastSteps, buildTapdUrl, loadTapdCache, saveTapdCache } =
      await load()
    try {
      const key = `myOpen:${workspaceId}`
      if (!force) {
        const cached = loadTapdCache()[key]
        if (cached) return { ok: true, cached: true, savedAt: cached.savedAt, data: cached.data }
      }
      const { name } = await getTapdUser()
      if (!name) throw new Error('无法获取当前 TAPD 账号，请检查访问令牌')
      const TYPES = [
        { key: 'story', cn: '需求' },
        { key: 'bug', cn: '缺陷' },
        { key: 'task', cn: '任务' },
      ]
      const out = []
      for (const t of TYPES) {
        // 元信息（statusMap/lastSteps）走与独立 handler 相同的缓存 key，首开 TAPD 页后即互享
        let statusMap = loadTapdCache()[`meta:${workspaceId}:${t.key}:statusMap`]?.data
        if (!statusMap) {
          statusMap = await getStatusMap(t.key, { workspaceId })
          if (statusMap) saveTapdCache(`meta:${workspaceId}:${t.key}:statusMap`, statusMap)
        }
        let lastSteps = loadTapdCache()[`meta:${workspaceId}:${t.key}:lastSteps`]?.data
        if (!lastSteps) {
          lastSteps = await getLastSteps(t.key, { workspaceId })
          if (lastSteps?.length) saveTapdCache(`meta:${workspaceId}:${t.key}:lastSteps`, lastSteps)
        }
        const terminal = new Set(Array.isArray(lastSteps) ? lastSteps : [])
        const { items } = await listWorkItems(t.key, { workspaceId, owner: name })
        for (const it of items) {
          // 终态判定同 Tapd.jsx bucketOf 的 done 分支：task 写死 done；其余终态集合优先、
          // 集合拉取失败时用状态中文名关键词兜底
          const done =
            t.key === 'task'
              ? it.status === 'done'
              : terminal.size
                ? terminal.has(it.status)
                : /完成|实现|解决|通过|关闭|上线|done|closed|resolved|reject/i.test(statusMap?.[it.status] || it.status)
          if (done) continue
          out.push({
            type: t.key,
            typeCn: t.cn,
            id: String(it.id),
            title: String(it.name || it.title || `#${it.id}`),
            status: it.status,
            statusCn: String(statusMap?.[it.status] || it.status),
            url: buildTapdUrl(t.key, workspaceId, it.id),
          })
        }
      }
      out.sort((a, b) => Number(b.id) - Number(a.id))
      saveTapdCache(key, out)
      return { ok: true, cached: false, savedAt: Date.now(), data: out }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 解析手输工单引用（初始化弹窗「输入工单」分支：粘贴链接或纯 ID → title + 详情链接）；单次操作不缓存
  ipcMain.handle('tapd:resolveWorkItem', async (_evt, { input, workspaceId } = {}) => {
    const { resolveWorkItemRef } = await load()
    try {
      return { ok: true, data: await resolveWorkItemRef(input, { workspaceId }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 状态英文→中文映射（story 失败自动带需求类别重试；再失败返回 null 显示英文原值）
  ipcMain.handle('tapd:statusMap', async (_evt, { type, workspaceId } = {}) => {
    const { getStatusMap, loadTapdCache, saveTapdCache } = await load()
    try {
      const key = `meta:${workspaceId}:${type}:statusMap`
      const cached = loadTapdCache()[key]
      if (cached) return { ok: true, data: cached.data }
      const map = await getStatusMap(type, { workspaceId })
      if (map) saveTapdCache(key, map) // null（拉取失败）不缓存，修好凭据后可重试
      return { ok: true, data: map }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 允许的流转细则（归一化后的 [{ name, from, to, requiredFields }]）
  ipcMain.handle('tapd:transitions', async (_evt, { type, workspaceId } = {}) => {
    const { getAllowedTransitions, loadTapdCache, saveTapdCache } = await load()
    try {
      const key = `meta:${workspaceId}:${type}:transitions`
      const cached = loadTapdCache()[key]
      if (cached) return { ok: true, data: cached.data }
      const list = await getAllowedTransitions(type, { workspaceId })
      if (list?.length) saveTapdCache(key, list) // 空结果不缓存
      return { ok: true, data: list }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 工作流终态集合（「已完成」快速筛选的语义依据；空结果不缓存，可重试）
  ipcMain.handle('tapd:lastSteps', async (_evt, { type, workspaceId } = {}) => {
    const { getLastSteps, loadTapdCache, saveTapdCache } = await load()
    try {
      const key = `meta:${workspaceId}:${type}:lastSteps`
      const cached = loadTapdCache()[key]
      if (cached) return { ok: true, data: cached.data }
      const list = await getLastSteps(type, { workspaceId })
      if (list?.length) saveTapdCache(key, list)
      return { ok: true, data: list }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 流转工单状态（core 成功后已清该 workspace 列表缓存）
  ipcMain.handle('tapd:updateStatus', async (_evt, { type, workspaceId, id, status, extraFields } = {}) => {
    const { updateWorkItemStatus } = await load()
    try {
      return { ok: true, data: await updateWorkItemStatus(type, { workspaceId, id, status, extraFields }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 项目成员（流转选处理人的候选；有缓存）
  ipcMain.handle('tapd:members', async (_evt, { workspaceId } = {}) => {
    const { listWorkspaceMembers, loadTapdCache, saveTapdCache } = await load()
    try {
      const key = `meta:${workspaceId}:members`
      const cached = loadTapdCache()[key]
      if (cached) return { ok: true, data: cached.data }
      const list = await listWorkspaceMembers({ workspaceId })
      if (list?.length) saveTapdCache(key, list)
      return { ok: true, data: list }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 工单评论列表（实时拉取，不缓存）
  ipcMain.handle('tapd:comments', async (_evt, { type, workspaceId, id } = {}) => {
    const { listComments } = await load()
    try {
      return { ok: true, data: await listComments(type, { workspaceId, id }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 添加评论（写操作；author 为当前账号名）
  ipcMain.handle('tapd:addComment', async (_evt, { type, workspaceId, id, content, author } = {}) => {
    const { addComment: add } = await load()
    try {
      return { ok: true, data: await add(type, { workspaceId, id, content, author }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 修改评论（POST /comments 带 id 即更新；官方 API 无删除接口，删除需去 TAPD 网页端）
  ipcMain.handle('tapd:updateComment', async (_evt, { workspaceId, commentId, content, author } = {}) => {
    const { updateComment: update } = await load()
    try {
      return { ok: true, data: await update({ workspaceId, commentId, content, author }) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
