import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureDataDir, userDataDir } from './paths.js'
import { loadProjects } from './projects.js'

const DATA_DIR = userDataDir()
const TAPD_FILE = join(DATA_DIR, 'tapd.json')
const TAPD_CACHE_FILE = join(DATA_DIR, 'tapd-cache.json')
const TAPD_CACHE_VERSION = 1
const TAPD_CACHE_MAX = 12

const TAPD_API_BASE = 'https://api.tapd.cn'

/**
 * 三类工单的元信息：API 路径、中文名、TAPD 前端详情链接模板。
 * bug 链接格式来自社区资料（官方文档未给出），若与实际不符只需改这里。
 */
const WORK_ITEM_META = {
    story: { api: '/stories', cn: '需求', url: (ws, id) => `https://www.tapd.cn/${ws}/prong/stories/view/${id}` },
    bug: { api: '/bugs', cn: '缺陷', url: (ws, id) => `https://www.tapd.cn/${ws}/bugtrace/bugs/view?bug_id=${id}` },
    task: { api: '/tasks', cn: '任务', url: (ws, id) => `https://www.tapd.cn/${ws}/prong/tasks/view/${id}` },
}

// task 三态固定（workflow 接口不支持 system=task，写死兜底）
const TASK_STATUS_MAP = { open: '未开始', progressing: '进行中', done: '已完成' }
// task 允许的流转（三态可互转）
const TASK_TRANSITIONS = [
    { from: 'open', to: 'progressing' },
    { from: 'open', to: 'done' },
    { from: 'progressing', to: 'open' },
    { from: 'progressing', to: 'done' },
    { from: 'done', to: 'open' },
    { from: 'done', to: 'progressing' },
]

/**
 * TAPD 列表响应的每条记录外层包了一层实体类型名（实测 { Story: {...} } / { Bug: {...} } / { Workspace: {...} }），
 * 拆包取实体本身；无包装时原样返回。
 */
const unwrapEntity = (x) => x?.Story || x?.Bug || x?.Task || x?.Workspace || x

/* ---------------- 配置 ---------------- */

/**
 * 读取 TAPD 配置（{ token, workspaceId, recentWorkspaceIds }）。
 * 凭据为个人访问令牌（token，TAPD「个人设置 → 个人访问令牌」创建，Bearer 认证），
 * 明文存于本机 userData/tapd.json 仅自用；文件缺失/损坏返回空配置，不抛错。
 * @returns {{ token: string, workspaceId: string, recentWorkspaceIds: string[] }}
 */
export function loadTapdConfig() {
    ensureDataDir()
    if (!existsSync(TAPD_FILE)) return { token: '', workspaceId: '', recentWorkspaceIds: [] }
    try {
        const raw = JSON.parse(readFileSync(TAPD_FILE, 'utf8'))
        if (raw && typeof raw === 'object') {
            return {
                token: typeof raw.token === 'string' ? raw.token : '',
                workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
                recentWorkspaceIds: Array.isArray(raw.recentWorkspaceIds) ? raw.recentWorkspaceIds : [],
            }
        }
    } catch {
        /* 损坏按空配置处理 */
    }
    return { token: '', workspaceId: '', recentWorkspaceIds: [] }
}

/**
 * 浅合并保存 TAPD 配置并返回合并后的完整配置。
 * workspaceId 变化时把旧值挪进 recentWorkspaceIds（去重，最多 5 个），供下拉快速切回。
 * @param {Partial<{ token: string, workspaceId: string }>} patch
 */
export function saveTapdConfig(patch = {}) {
    ensureDataDir()
    const cfg = loadTapdConfig()
    const next = { ...cfg }
    if (typeof patch.token === 'string') next.token = patch.token.trim()
    if (typeof patch.workspaceId === 'string') {
        const ws = patch.workspaceId.trim()
        if (ws && cfg.workspaceId && cfg.workspaceId !== ws) {
            next.recentWorkspaceIds = [cfg.workspaceId, ...cfg.recentWorkspaceIds.filter((w) => w !== ws && w !== cfg.workspaceId)].slice(0, 5)
        }
        next.workspaceId = ws
    }
    writeFileSync(TAPD_FILE, JSON.stringify(next, null, 2), 'utf8')
    return next
}

/** 配置文件路径（供调试/提示使用） */
export function getTapdFile() {
    return TAPD_FILE
}

/* ---------------- 请求 ---------------- */

/**
 * 解析 API 凭据（个人访问令牌）：显式传入 > 配置文件 > 环境变量（终端启动兼容）。
 * @param {{ token?: string }} [auth]
 * @returns {{ token: string }}
 * @throws {Error} 'NO_TAPD_AUTH'（特殊标识：前端据此显示凭据表单，而非普通报错）
 */
function resolveAuth(auth) {
    const token = auth?.token || loadTapdConfig().token || process.env.TAPD_TOKEN
    if (token) return { token }
    throw new Error('NO_TAPD_AUTH')
}

// 去掉值为 undefined/空串的键（TAPD 对空参数可能报错）
const cleanParams = (params = {}) =>
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))

/**
 * TAPD 开放 API 请求包装：Bearer 令牌鉴权 + 响应信封（{ data, status, info }，status===1 成功）校验。
 * 错误分层（对齐 git.js 的做法）：401/令牌无效 → 凭据错误；403 → 无权限；info 含限流关键词 → 提示稍后重试；
 * 其余 status!==1 → 透出 TAPD 的中文 info。
 * @param {string} path 如 '/stories'
 * @param {{ method?: 'GET'|'POST', params?: object, form?: object, auth?: object }} [opts]
 * @returns {Promise<object>} TAPD 响应 json（status 已校验为 1）
 */
async function tapdRequest(path, { method = 'GET', params = {}, form = {}, auth } = {}) {
    const { token } = resolveAuth(auth)
    const headers = { Authorization: `Bearer ${token}` }
    let url = TAPD_API_BASE + path
    let body
    if (method === 'GET') {
        url += `?${new URLSearchParams(cleanParams(params))}`
    } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        body = new URLSearchParams(cleanParams(form))
    }
    let res
    try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) })
    } catch (err) {
        throw new Error(`无法连接 TAPD（${err.message}），请检查网络`)
    }
    let json = null
    try {
        json = await res.json()
    } catch {
        /* 非 JSON 响应，下面按 HTTP 状态处理 */
    }
    const info = json?.info ? String(json.info) : ''
    if (res.status === 401) throw new Error('TAPD 返回 401：访问令牌无效或已过期，请检查「凭据设置」')
    if (res.status === 403) throw new Error('TAPD 返回 403：API 账号无该项目访问权限，请联系管理员开通')
    if (!res.ok) {
        // 无效访问令牌实测返回 422 + 英文提示（The access token provided is invalid），转成可读中文
        if (/access token/i.test(info)) throw new Error('TAPD：访问令牌无效，请检查「凭据设置」里的令牌')
        throw new Error(`TAPD HTTP ${res.status}${info ? `：${info}` : ''}`)
    }
    if (json && json.status !== 1) {
        if (/频率|频繁|limit/i.test(info)) throw new Error('请求过于频繁（TAPD 限流），请稍后重试')
        throw new Error(`TAPD：${info || '未知错误'}`)
    }
    return json
}

/* ---------------- 链接 / workspace ---------------- */

/**
 * 获取当前凭据对应的用户信息（GET /users/info）。
 * 供保存凭据后即时校验有效性（401 等错误会抛出）并显示账号昵称；
 * name 是账号标识（如 fred.liu），与工单 owner 字段同格式，供「只看我的」服务端过滤。
 * @param {object} [auth]
 * @returns {Promise<{ name: string, nick: string }>}
 */
export async function getTapdUser(auth) {
    const json = await tapdRequest('/users/info', { auth })
    const data = json?.data && typeof json.data === 'object' ? json.data : {}
    return { name: data.name || '', nick: data.nick || data.name || '' }
}

/**
 * 拼某工单的 TAPD 前端详情链接（表格点开详情用）。
 * @param {'story'|'bug'|'task'} type
 * @param {string} workspaceId
 * @param {string} id 工单长 id
 */
export function buildTapdUrl(type, workspaceId, id) {
    const meta = WORK_ITEM_META[type]
    return meta ? meta.url(workspaceId, id) : ''
}

/**
 * 从 TAPD 链接提取 workspace_id。两种前端链接格式都支持：
 *   https://www.tapd.cn/60171234/prong/stories/view/xxx       → 60171234
 *   https://www.tapd.cn/tapd_fe/23436281/story/detail/xxx     → 23436281
 * 取 tapd.cn 后第一段纯数字；tapd_fe 等路径前缀会被跳过（惰性匹配取最左侧的数字段）。
 * @param {string} link
 * @returns {string|null}
 */
export function parseWorkspaceIdFromLink(link) {
    if (typeof link !== 'string') return null
    const m = link.match(/https?:\/\/(?:www\.)?tapd\.cn\/(?:[^/?#]+\/)*?(\d{6,})/i)
    return m ? m[1] : null
}

/**
 * 汇总本地 projects.json 各项目 _tapd 链接里的 workspace_id（去重 + 出现次数，按次数降序），
 * 作为 workspace 选择器的零配置推荐项。
 * @returns {Array<{ workspaceId: string, count: number }>}
 */
export function suggestWorkspaceIds() {
    const counts = new Map()
    for (const p of loadProjects()) {
        const ws = parseWorkspaceIdFromLink(p?._tapd || '')
        if (ws) counts.set(ws, (counts.get(ws) || 0) + 1)
    }
    return [...counts.entries()]
        .map(([workspaceId, count]) => ({ workspaceId, count }))
        .sort((a, b) => b.count - a.count)
}

/**
 * 当前 API 账号参与的项目列表（GET /workspaces/user_participant_projects，无分页、无需公司管理权限）。
 * 供 workspace 下拉选择；失败（含未配凭据）由前端降级为只用手填/本地推荐。
 * @param {object} [auth]
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listWorkspaces(auth) {
    const json = await tapdRequest('/workspaces/user_participant_projects', { auth })
    const raw = (Array.isArray(json?.data) ? json.data : []).map(unwrapEntity)
    // 返回里混有 category=organization 的公司条目，只保留项目；全无 category 字段时不过滤
    const projects = raw.filter((w) => !w.category || w.category === 'project')
    return (projects.length ? projects : raw).map((w) => ({ id: String(w.id), name: w.name || String(w.id) }))
}

/**
 * 校验手填 workspace_id 并取项目名（GET /workspaces/get_workspace_info）。
 * @param {string} workspaceId
 * @param {object} [auth]
 * @returns {Promise<{ id: string, name: string }>}
 */
export async function getWorkspaceInfo(workspaceId, auth) {
    const json = await tapdRequest('/workspaces/get_workspace_info', { params: { workspace_id: workspaceId }, auth })
    const w = unwrapEntity(json?.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : Array.isArray(json?.data) ? json.data[0] : null)
    if (!w?.id) throw new Error(`未找到项目 ${workspaceId}，请检查 workspace_id`)
    return { id: String(w.id), name: w.name || String(w.id) }
}

/* ---------------- 工单列表 ---------------- */

/**
 * 分页拉取某类工单列表（逐页串行，页间 120ms 防限流）。
 * 每条附带 _url（TAPD 前端详情链接，`_` 前缀=派生字段，与 _tapd/_branch 约定一致）。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, status?: string, iterationId?: string, owner?: string, id?: string, maxPages?: number, auth?: object }} opts
 *   maxPages 默认 3（每页 200，最多拉 600 条；TAPD 限流按账号计，保守起步）；
 *   id 为按工单 id 精确过滤（服务端 id 参数，供 resolveWorkItemRef 单条定位）
 * @returns {Promise<{ items: Array<object>, total: number }>} total 来自 /count 接口
 */
export async function listWorkItems(type, { workspaceId, status, iterationId, owner, id, maxPages = 3, auth } = {}) {
    const meta = WORK_ITEM_META[type]
    if (!meta) throw new Error(`未知的工单类型：${type}`)
    if (!workspaceId) throw new Error('请先选择 TAPD 项目（workspace_id）')
    const filters = cleanParams({ status, iteration_id: iterationId, owner, id })
    let items = []
    let page = 1
    while (page <= maxPages) {
        const json = await tapdRequest(meta.api, { params: { workspace_id: workspaceId, limit: 200, page, ...filters }, auth })
        const batch = Array.isArray(json?.data) ? json.data.map(unwrapEntity) : []
        items = items.concat(batch)
        if (batch.length < 200) break
        page += 1
        await new Promise((r) => setTimeout(r, 120))
    }
    // 按 created 倒序（TAPD 默认顺序不保证，前端展示统一最新的在前）
    items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
    let total = items.length
    try {
        const cnt = await tapdRequest(`${meta.api}/count`, { params: { workspace_id: workspaceId, ...filters }, auth })
        total = cnt?.data?.count ?? cnt?.count ?? items.length
    } catch {
        /* count 失败不阻塞列表，用已加载数量兜底 */
    }
    return { items: items.map((it) => ({ ...it, _url: meta.url(workspaceId, it.id) })), total }
}

/**
 * 解析用户手输的工单引用（初始化弹窗「选择或输入工单」的输入分支）。
 * 支持两种输入：TAPD 前端详情链接（从中提取 workspace_id 与长 id）或纯数字工单 id
 * （workspace 用当前配置的）。三类逐一查（id 不编码类型，命中即止，最多 3 次列表请求）。
 * @param {string} input 工单链接或纯数字 id
 * @param {{ workspaceId?: string, auth?: object }} opts 纯 id 输入时的项目来源
 * @returns {Promise<{ type: string, typeCn: string, id: string, title: string, url: string, workspaceId: string, item: object }>}
 *   item 为完整工单实体（listWorkItems 原始字段 + _url），供详情抽屉直接渲染
 * @throws {Error} 输入里识别不出 id / 三类都查不到（不在这个项目、无权限或已删除）
 */
export async function resolveWorkItemRef(input, { workspaceId, auth } = {}) {
    const raw = String(input ?? '').trim()
    if (!raw) throw new Error('请输入工单链接或工单 ID')
    const wsFromLink = parseWorkspaceIdFromLink(raw)
    const ws = wsFromLink || workspaceId
    if (!ws) throw new Error('无法识别该链接所属项目，请先在工单系统配置 workspace')
    // 工单长 id（≥10 位，内嵌 workspace 前缀）：链接里取最后一段长数字（workspace 也是数字段，取末段避开）；
    // 纯数字输入整体即 id。story/bug/task 的 id 长度一致，无法按位数辨型，只能逐类查。
    const runs = raw.match(/\d{10,}/g) || []
    const id = runs.length ? runs[runs.length - 1] : /^\d+$/.test(raw) ? raw : null
    if (!id) throw new Error('无法从输入中识别工单 ID（支持粘贴工单链接，或直接输入工单 ID）')
    for (const [type, meta] of Object.entries(WORK_ITEM_META)) {
        const { items } = await listWorkItems(type, { workspaceId: ws, id, maxPages: 1, auth })
        const hit = items.find((it) => String(it.id) === String(id))
        if (hit) {
            return {
                type,
                typeCn: meta.cn,
                id: String(hit.id),
                title: String(hit.name || hit.title || `#${hit.id}`),
                url: buildTapdUrl(type, ws, hit.id),
                workspaceId: String(ws),
                item: hit,
            }
        }
    }
    throw new Error('未找到该工单（可能不在所属项目内，或当前令牌无权限查看）')
}

/* ---------------- 实时同步（增量轮询） ---------------- */

/**
 * epoch 毫秒 → TAPD 接口时间串（北京时间 'YYYY-MM-DD HH:mm:ss'，UTC+8）。
 * TAPD 的 modified 过滤与返回时间都是该格式（无时区后缀），字符串比较即时间比较；
 * 用「时间戳 + 8h 后取 ISO 串」换算，避免依赖宿主机时区设置。
 * @param {number} [ms] 默认当前时间
 * @returns {string}
 */
export function tapdTimeFromMs(ms = Date.now()) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 增量拉取某类工单中「修改时间 >= since」的记录（实时同步轮询专用，单页小量）。
 * TAPD 列表接口的参数名支持带操作符（modified>=xxx），只返回变动过的少数几条，
 * 单次请求即可完成一轮探测；不翻页、不拉 count——超过 limit 条时由调度器推进水线
 * 后下一轮补齐。返回条目与 listWorkItems 同构（带 _url 派生字段）。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, since?: string, limit?: number, auth?: object }} opts
 *   since 为 TAPD 北京时间串（tapdTimeFromMs 生成），缺省时等同全量首页
 * @returns {Promise<Array<object>>}
 */
export async function fetchChangedWorkItems(type, { workspaceId, since, limit = 50, auth } = {}) {
    const meta = WORK_ITEM_META[type]
    if (!meta) throw new Error(`未知的工单类型：${type}`)
    if (!workspaceId) throw new Error('请先选择 TAPD 项目（workspace_id）')
    const params = { workspace_id: workspaceId, limit, page: 1 }
    if (since) params['modified>='] = since
    const json = await tapdRequest(meta.api, { params, auth })
    return (Array.isArray(json?.data) ? json.data : [])
        .map(unwrapEntity)
        .map((it) => ({ ...it, _url: meta.url(workspaceId, it.id) }))
}

/* ---------------- 状态映射 / 流转 ---------------- */

/**
 * 解析 all_transitions 的 Appendfield（实测为数组，每项 { FieldName, FieldLabel, Notnull, DefaultValue }），
 * 取必填（Notnull=yes）条目归一化为 [{ field, label, defaultValueFrom }]：
 * label 用 TAPD 的中文字段名；DefaultValue 是联动规则数组（如 { Type:'record_value', Field:'creator,' }），
 * 取首个字段名存为 defaultValueFrom —— UI 用当前工单该字段的值预填（如「处理人」默认取创建人）。
 */
function parseRequiredFields(appendfield) {
    if (!appendfield) return []
    let val = appendfield
    if (typeof val === 'string') {
        try {
            val = JSON.parse(val)
        } catch {
            return []
        }
    }
    if (!Array.isArray(val)) return []
    return val
        .filter((f) => f && f.FieldName && String(f.Notnull).toLowerCase() === 'yes')
        .map((f) => {
            const rule = Array.isArray(f.DefaultValue) ? f.DefaultValue[0] : null
            const fromField = rule?.Field ? String(rule.Field).split(',')[0].trim() : ''
            return { field: String(f.FieldName), label: f.FieldLabel || String(f.FieldName), defaultValueFrom: fromField }
        })
}

/**
 * 状态英文 → 中文名映射。
 * story/bug 走 GET /workflows/status_map（data 为对象）；story 失败时自动拉 /story_categories
 * 取默认需求类别 id 重试（自定义工作流的项目需要 workitem_type_id），再失败返回 null（前端显示英文原值）。
 * task 接口不支持，返回固定三态。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, auth?: object }} opts
 * @returns {Promise<Record<string,string>|null>}
 */
export async function getStatusMap(type, { workspaceId, auth } = {}) {
    if (type === 'task') return TASK_STATUS_MAP
    const params = { workspace_id: workspaceId, system: type }
    try {
        const json = await tapdRequest('/workflows/status_map', { params, auth })
        if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data
        return null
    } catch (err) {
        if (err.message === 'NO_TAPD_AUTH') throw err
        if (type !== 'story') return null
        // story：带需求类别 id 重试一次
        try {
            const cat = await tapdRequest('/story_categories', { params: { workspace_id: workspaceId, limit: 1 }, auth })
            const id = Array.isArray(cat?.data) && cat.data[0]?.id ? cat.data[0].id : null
            if (!id) return null
            const json = await tapdRequest('/workflows/status_map', { params: { ...params, workitem_type_id: id }, auth })
            if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data
            return null
        } catch {
            return null
        }
    }
}

/**
 * 允许的流转（归一化）：把 /workflows/all_transitions 的 Name/StepPrevious/StepNext/Appendfield
 * 转成 [{ name, from, to, requiredFields }]（requiredFields = 流转必填附加字段，流转表单据此渲染输入项）。
 * task 接口不支持，返回写死的三态互转。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, auth?: object }} opts
 * @returns {Promise<Array<{ name: string, from: string, to: string, requiredFields: Array<{field: string, defaultValue: string}> }>>}
 */
export async function getAllowedTransitions(type, { workspaceId, auth } = {}) {
    if (type === 'task') return TASK_TRANSITIONS.map((t) => ({ name: '', requiredFields: [], ...t }))
    const json = await tapdRequest('/workflows/all_transitions', { params: { workspace_id: workspaceId, system: type }, auth })
    const list = Array.isArray(json?.data) ? json.data : []
    return list
        .filter((t) => t && t.StepPrevious && t.StepNext)
        .map((t) => ({
            name: t.Name || '',
            from: String(t.StepPrevious),
            to: String(t.StepNext),
            requiredFields: parseRequiredFields(t.Appendfield),
        }))
}

/**
 * 工作流的终态状态集合（GET /workflows/last_steps，如 { resolved:'已实现', rejected:'已拒绝', status_6:'已通过' }），
 * 供前端「已完成」快速筛选做语义分类（比关键词猜测可靠）。task 接口不支持，返回写死的 done。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, auth?: object }} opts
 * @returns {Promise<string[]>} 终态英文值数组；接口失败返回 []（前端降级为关键词分类）
 */
export async function getLastSteps(type, { workspaceId, auth } = {}) {
    if (type === 'task') return ['done']
    try {
        const json = await tapdRequest('/workflows/last_steps', { params: { workspace_id: workspaceId, system: type }, auth })
        return json?.data && typeof json.data === 'object' && !Array.isArray(json.data) ? Object.keys(json.data) : []
    } catch (err) {
        if (err.message === 'NO_TAPD_AUTH') throw err
        return []
    }
}

/**
 * 项目成员列表（GET /workspaces/users，每条包 UserWorkspace）。
 * user 为账号名（与工单 owner 字段同格式，如 fred.liu），name 为显示名 —— 供流转时选择处理人。
 * @param {{ workspaceId: string, auth?: object }} opts
 * @returns {Promise<Array<{ user: string, name: string }>>}
 */
export async function listWorkspaceMembers({ workspaceId, auth } = {}) {
    const json = await tapdRequest('/workspaces/users', { params: { workspace_id: workspaceId, limit: 200 }, auth })
    const list = (Array.isArray(json?.data) ? json.data : []).map((x) => x?.UserWorkspace || x)
    return list.filter((u) => u.user).map((u) => ({ user: String(u.user), name: u.name || String(u.user) }))
}

// 评论对象类型（entry_type）：官方文档取值为 bug / stories / tasks —— bug 单数、story/task 复数。
// 注意 GET /comments 实测只认 entry_id 过滤（type/id 参数均被服务端忽略），entry_type 仅 POST 时需要。
const COMMENT_ENTRY_TYPE = { story: 'stories', bug: 'bug', task: 'tasks' }

/**
 * 工单评论列表（GET /comments，按 entry_id 过滤该工单的评论，每条包 Comment）。
 * 服务端对返回的 entry_id 有历史脏数据，客户端再按 entry_id 兜底过滤一次，确保不串单。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, id: string, auth?: object }} opts
 * @returns {Promise<Array<{ id: string, author: string, description: string, created: string, modified: string, rootId: string, replyId: string }>>} 最新在前
 */
export async function listComments(type, { workspaceId, id, auth } = {}) {
    if (!WORK_ITEM_META[type] || !id) throw new Error('缺少工单类型或 id')
    const json = await tapdRequest('/comments', {
        params: { workspace_id: workspaceId, entry_id: id, limit: 50 },
        auth,
    })
    const list = (Array.isArray(json?.data) ? json.data : [])
        .map((x) => x?.Comment || x)
        .filter((c) => !c.entry_id || String(c.entry_id) === String(id))
    return list
        .map((c) => ({
            id: String(c.id || ''),
            author: c.author || '',
            description: c.description || '',
            created: c.created || '',
            modified: c.modified || '',
            rootId: String(c.root_id || ''),
            replyId: String(c.reply_id || ''),
        }))
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))
}

/**
 * 添加评论（POST /comments，description 支持纯文本或 HTML）。
 * author 为评论人账号名（前端传当前账号，保证与 TAPD 记录一致）；
 * 按官方文档用 entry_type + entry_id 标识被评论工单（type/id 会被服务端忽略）。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, id: string, content: string, author: string, auth?: object }} opts
 */
export async function addComment(type, { workspaceId, id, content, author, auth } = {}) {
    if (!content || !author) throw new Error('评论内容或评论人缺失')
    const json = await tapdRequest('/comments', {
        method: 'POST',
        form: {
            workspace_id: workspaceId,
            entry_type: COMMENT_ENTRY_TYPE[type],
            entry_id: id,
            description: content,
            author,
        },
        auth,
    })
    return json?.data || {}
}

/**
 * 修改评论（POST /comments 带 id 即为更新，仅能改内容；官方开放 API 无删除评论接口，
 * 删除只能去 TAPD 网页端）。change_creator 传原评论人账号，以其身份更新本人评论。
 * @param {{ workspaceId: string, commentId: string, content: string, author?: string, auth?: object }} opts
 */
export async function updateComment({ workspaceId, commentId, content, author, auth } = {}) {
    if (!commentId || !content) throw new Error('缺少评论 id 或评论内容')
    const json = await tapdRequest('/comments', {
        method: 'POST',
        form: {
            workspace_id: workspaceId,
            id: commentId,
            description: content,
            ...(author ? { change_creator: author } : {}),
        },
        auth,
    })
    return json?.data || {}
}

/**
 * 流转工单状态：POST /stories|/bugs|/tasks（form 带 id + status + 附加必填字段）。
 * 成功后清掉该 workspace 全部列表缓存（下次 tapd:list 强制重新拉取，状态即时生效）。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, id: string, status: string, extraFields?: object, auth?: object }} opts
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function updateWorkItemStatus(type, { workspaceId, id, status, extraFields, auth } = {}) {
    const meta = WORK_ITEM_META[type]
    if (!meta) throw new Error(`未知的工单类型：${type}`)
    if (!id || !status) throw new Error('缺少工单 id 或目标状态')
    const form = cleanParams({ workspace_id: workspaceId, id, status, ...extraFields })
    await tapdRequest(meta.api, { method: 'POST', form, auth })
    clearTapdCache(`list:${workspaceId}`)
    return { id, status }
}

// 编辑工单允许下发的字段（开放文档声明的可编辑字段白名单，防止把内部字段发给 API）；
// custom_field_* 是各项目自定义字段（开放文档明确更新接口支持）
const EDITABLE_FIELDS = new Set([
    'name',
    'title',
    'description',
    'owner',
    'cc',
    'priority',
    'priority_label',
    'begin',
    'due',
    'deadline',
    'developer',
    'iteration_id',
    'version',
    'module',
    'label',
    'current_user',
])
const isEditableKey = (k) => EDITABLE_FIELDS.has(k) || /^custom_field_/.test(k)

/**
 * 编辑工单字段：POST /stories|/bugs|/tasks（id + workspace_id + 任意可改字段，一次一条）。
 * 与流转状态同一端点；空值字段跳过（开放 API 对空串行为不明确，不支持清空日期类字段）。
 * 成功后清掉该 workspace 全部列表缓存（下次 tapd:list 强制重新拉取）。
 * @param {'story'|'bug'|'task'} type
 * @param {{ workspaceId: string, id: string, fields: object, auth?: object }} opts
 * @returns {Promise<{ id: string, fields: object }>}
 */
export async function updateWorkItem(type, { workspaceId, id, fields, auth } = {}) {
    const meta = WORK_ITEM_META[type]
    if (!meta) throw new Error(`未知的工单类型：${type}`)
    if (!id) throw new Error('缺少工单 id')
    const patch = {}
    for (const [k, v] of Object.entries(fields || {})) {
        if (!isEditableKey(k)) continue
        const s = String(v ?? '').trim()
        if (s) patch[k] = s
    }
    if (!Object.keys(patch).length) throw new Error('没有可更新的字段')
    const form = cleanParams({ workspace_id: workspaceId, id, ...patch })
    await tapdRequest(meta.api, { method: 'POST', form, auth })
    clearTapdCache(`list:${workspaceId}`)
    return { id, fields: patch }
}

/* ---------------- 缓存（deps.js 同款：版本号 + savedAt + LRU） ---------------- */

/**
 * 读取 TAPD 缓存：{ [key]: { v, savedAt, data } }；文件缺失/损坏返回 {}。
 * 版本号不匹配的旧条目视为不存在（丢弃）。key 形如 `list:{ws}:{type}:{filters}` / `meta:{ws}:{type}:{kind}`。
 * @returns {Record<string, { savedAt: number, data: object }>}
 */
export function loadTapdCache() {
    ensureDataDir()
    try {
        const obj = JSON.parse(readFileSync(TAPD_CACHE_FILE, 'utf8'))
        if (!obj || typeof obj !== 'object') return {}
        for (const key of Object.keys(obj)) {
            if (obj[key]?.v !== TAPD_CACHE_VERSION) delete obj[key]
        }
        return obj
    } catch {
        return {}
    }
}

/**
 * 写入单条缓存并按 savedAt 淘汰最旧的（只保留最近 TAPD_CACHE_MAX 条）。写失败静默。
 * @param {string} key
 * @param {object} data
 */
export function saveTapdCache(key, data) {
    ensureDataDir()
    const all = { ...loadTapdCache(), [key]: { v: TAPD_CACHE_VERSION, savedAt: Date.now(), data } }
    const keys = Object.keys(all)
    if (keys.length > TAPD_CACHE_MAX) {
        const drop = keys.sort((a, b) => all[a].savedAt - all[b].savedAt).slice(0, keys.length - TAPD_CACHE_MAX)
        drop.forEach((k) => delete all[k])
    }
    try {
        writeFileSync(TAPD_CACHE_FILE, JSON.stringify(all), 'utf8')
    } catch {
        /* 磁盘满/权限等：缓存写不进就算了 */
    }
}

/**
 * 按前缀清除缓存（流转成功后失效对应 workspace 的列表缓存用）。
 * @param {string} keyPrefix
 */
export function clearTapdCache(keyPrefix) {
    ensureDataDir()
    const all = loadTapdCache()
    const keys = Object.keys(all).filter((k) => k.startsWith(keyPrefix))
    if (!keys.length) return
    keys.forEach((k) => delete all[k])
    try {
        writeFileSync(TAPD_CACHE_FILE, JSON.stringify(all), 'utf8')
    } catch {
        /* 清不掉就算了，下次 force 刷新会覆盖 */
    }
}
