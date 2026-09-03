import { buildLinks } from './links.js'
/**
 * shopify CLI 主题相关调用的 headless 封装（CLI 与桌面应用共用）。
 * 只跑 shopify 子进程、解析输出，不打印、不提问；展示与交互由各自的壳负责。
 */
import { captureShopify } from './runner.js'

/**
 * 从 shopify -j 的 stdout 里解析 JSON。
 * -j 一般输出纯 JSON；做一点容错：整体解析失败时尝试截取最后一个 [...] / {...} 再解析。
 * @param {string} stdout
 * @returns {any | null}
 */
function parseJson(stdout) {
    const text = stdout.trim()
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        const matches = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/g)
        if (matches) {
            for (let i = matches.length - 1; i >= 0; i--) {
                try {
                    return JSON.parse(matches[i])
                } catch { }
            }
        }
        return null
    }
}

/**
 * 复制指定环境的 live 主题为新草稿主题（headless，无 inquirer）。
 * 流程：`theme list --role live -j` 取 live id → 拼 `[env] 活动 | 负责人 | YYYYMMDD` 主题名
 * → `theme duplicate --theme <id> --name <name> --force -j` 取新 id → 用 buildLinks 算后台/编辑链接。
 * 前置：该 store 已 `shopify login`，否则 shopify 返回非零退出码（无 in-band 登录）。
 * @param {{ cwd: string, envName: string, envConfig: object, activity: string, owner: string, namePrefix?: string }} opts
 *   envName：shopify `-e` 取的环境（含 store 配置，通常 dev）；
 *   namePrefix：可选，覆盖主题名前缀（默认用 envName），如「创建 release」时传 'release' → [release] 活动 | 负责人 | 日期。
 *   envConfig 用于拼链接（取 store/domain/preview_key/port）
 * @returns {Promise<{ ok: true, id: string, name: string, links: object } | { ok: false, stage: string, code: number, stderr: string, stdout: string }>}
 */
export async function duplicateLiveTheme({ cwd, envName, envConfig, activity, owner, namePrefix }) {
    // 拉 live 主题
    const listRes = await captureShopify(['theme', 'list', '--role', 'live', '-j', '-e', envName], { cwd })
    if (listRes.code !== 0) {
        return { ok: false, stage: 'list', code: listRes.code, stderr: listRes.stderr, stdout: listRes.stdout }
    }
    const list = parseJson(listRes.stdout)
    const live = Array.isArray(list) ? list.find((t) => t.role === 'live') ?? list[0] : null
    if (!live || !live.id) {
        return { ok: false, stage: 'list', code: 0, stderr: '未找到 live 主题', stdout: listRes.stdout }
    }

    // 拼主题名：[<前缀>] <活动> | <负责人> | <YYYYMMDD>（前缀默认用 envName，可被 namePrefix 覆盖）
    const now = new Date()
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const prefix = namePrefix ?? envName
    const themeName = `[${prefix}] ${String(activity).trim()} | ${String(owner).trim()} | ${dateStr}`

    // 复制主题
    const dupRes = await captureShopify(
        ['theme', 'duplicate', '--theme', String(live.id), '--name', themeName, '--force', '-e', envName, '-j'],
        { cwd },
    )
    if (dupRes.code !== 0) {
        return { ok: false, stage: 'duplicate', code: dupRes.code, stderr: dupRes.stderr, stdout: dupRes.stdout }
    }
    const dup = parseJson(dupRes.stdout)
    const newTheme = dup?.theme
    if (!newTheme || !newTheme.id) {
        return { ok: false, stage: 'parse', code: 0, stderr: '主题数量已达上限，需删除主题', stdout: dupRes.stdout }
    }

    return {
        ok: true,
        id: String(newTheme.id),
        name: newTheme.name,
        links: buildLinks({ ...envConfig, theme: String(newTheme.id) }),
    }
}

/**
 * 查询单个主题的线上信息（theme list -j 后按 id 匹配）。
 * 本地项目只存 theme id，不存名称；「删除主题」二次确认弹窗要展示主题名/角色，先来这里拉。
 * 前置：该 store 已 `shopify login`。
 * @param {{ cwd: string, envName: string, themeId: string|number }} opts
 * @returns {Promise<{ ok: true, theme: { id: string, name: string, role: string } | null } | { ok: false, code: number, stderr: string }>}
 *   theme=null 表示该 id 在线上已不存在（可能已被删除）
 */
export async function getThemeInfo({ cwd, envName, themeId }) {
    const res = await captureShopify(['theme', 'list', '-j', '-e', envName], { cwd })
    if (res.code !== 0) {
        return { ok: false, code: res.code, stderr: res.stderr }
    }
    const list = parseJson(res.stdout)
    const theme = (Array.isArray(list) ? list : []).find((t) => String(t.id) === String(themeId))
    return { ok: true, theme: theme ? { id: String(theme.id), name: theme.name, role: theme.role || '' } : null }
}

/**
 * 列出该环境对应 store 的全部主题（theme list -j，headless）。
 * 主题列表弹窗展示用：live 优先由前端排序，这里保持 CLI 返回原顺序。
 * 前置：该 store 已 `shopify login`。
 * @param {{ cwd: string, envName: string }} opts
 * @returns {Promise<{ ok: true, themes: Array<{ id, name, role }> } | { ok: false, code: number, stderr: string }>}
 */
export async function listThemes({ cwd, envName }) {
    const res = await captureShopify(['theme', 'list', '-j', '-e', envName], { cwd })
    if (res.code !== 0) {
        return { ok: false, code: res.code, stderr: res.stderr }
    }
    const list = parseJson(res.stdout)
    return { ok: true, themes: Array.isArray(list) ? list : [] }
}

/**
 * 发布指定主题为线上 live 主题（headless）：`theme publish --theme <id> --force`。
 * --force 跳过 CLI 的交互确认；live 主题不可重复发布（CLI 会报错，调用方宜先按 role 拦截）。
 * 注意：theme publish 不支持 -j（JSON 输出）标志，传了会报 Nonexistent flag 退出码 2，
 * 因此只靠退出码判断成败。前置：该 store 已 `shopify login`。
 * @param {{ cwd: string, envName: string, themeId: string|number }} opts
 * @returns {Promise<{ ok: boolean, code: number, stderr: string }>}
 */
export async function publishTheme({ cwd, envName, themeId }) {
    const res = await captureShopify(['theme', 'publish', '--theme', String(themeId), '--force', '-e', envName], { cwd })
    return { ok: res.code === 0, code: res.code, stderr: res.stderr }
}

/**
 * 删除线上主题（headless）：`theme delete --theme <id> --force`。
 * --force 跳过 CLI 的交互确认；live 主题不可删（CLI 会报错，调用方宜先用 getThemeInfo 按 role 拦截）。
 * 前置：该 store 已 `shopify login`。
 * @param {{ cwd: string, envName: string, themeId: string|number }} opts
 * @returns {Promise<{ ok: boolean, code: number, stderr: string }>}
 */
export async function deleteTheme({ cwd, envName, themeId }) {
    const res = await captureShopify(['theme', 'delete', '--theme', String(themeId), '--force', '-e', envName], { cwd })
    return { ok: res.code === 0, code: res.code, stderr: res.stderr }
}

/**
 * 拉取指定 templates json 文件（headless，对应 shop async 的 pull 步骤）。
 * `shopify theme pull -e <env> --only <file> --only <file> …`
 * 前置：该 store 已 `shopify login`。
 * @param {{ cwd: string, env: string, files: string[] }} opts
 * @returns {Promise<{ ok: boolean, code: number, stderr: string }>}
 */
export async function pullTemplateJson({ cwd, env, files }) {
    const onlyArgs = (files || []).flatMap((f) => ['--only', f])
    const res = await captureShopify(['theme', 'pull', '-e', env, ...onlyArgs], { cwd })
    return { ok: res.code === 0, code: res.code, stderr: res.stderr }
}
