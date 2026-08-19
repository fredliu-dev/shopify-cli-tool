/**
 * Git 仓库扫描的纯逻辑（headless）：供 CLI 与 Electron 桌面应用共用。
 * 只读 git、不打印、不提问；展示与交互由各自的壳负责。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 在 cwd 跑一次 git 子进程，捕获 stdout/stderr。
 * headless：进程错误/超时静默返回退出码（不抛、不打印），由调用方按 code 处理。
 * @param {string[]} args 透传给 git 的参数
 * @param {string} cwd 工作目录
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runGit(args, cwd, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      resolve({ code: code ?? 0, stdout, stderr })
    }
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout })
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      // git 缺失（ENOENT）等启动失败写入 stderr：调用方按退出码只能看到「失败」，
      // 这里给出可读原因（如「未找到 git 命令」），不再静默吞掉
      stderr += err.code === 'ENOENT'
        ? '未找到 git 命令：请安装 Git 并确认其已加入 PATH。'
        : `git 进程启动失败：${err.message}`
      finish(1)
    })
    child.on('close', finish)
  })
}

/** 多行文本按行去空白、去重、排序后返回（用于文件名列表）。 */
function uniqLines(s) {
  return [...new Set(String(s).split('\n').map((l) => l.trim()).filter(Boolean))].sort()
}

/**
 * 还原 git 的 C 风格引用路径：去首尾引号 + 解码 \NNN 八进制转义（还原为 UTF-8 字节再解码）。
 * 即便禁用了 core.quotepath，含 "、\t 等控制字符的路径仍会被 git 引用输出。
 * @param {string} p
 * @returns {string}
 */
function unquotePath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const inner = p.slice(1, -1)
  let out = ''
  let bytes = []
  const flush = () => {
    if (bytes.length) {
      out += Buffer.from(bytes).toString('utf8')
      bytes = []
    }
  }
  for (let i = 0; i < inner.length; ) {
    const m = /^\\([0-7]{3})/.exec(inner.slice(i))
    if (m) {
      bytes.push(parseInt(m[1], 8)) // 八进制转义是 UTF-8 字节序列，攒够再整体解码
      i += 4
    } else {
      flush()
      if (inner[i] === '\\') {
        // \" 与 \\ 的简单反转义
        out += inner[i + 1] ?? '\\'
        i += 2
      } else {
        out += inner[i]
        i += 1
      }
    }
  }
  flush()
  return out
}

/**
 * 解析当前分支的改动范围（<fork-point>..HEAD），供 getChangedFiles 取「本分支自创建以来的改动」。
 *
 * 不再依赖持久化的基准文件——改用 reflog 直接还原「分支创建点」：`git log -g --format=%H <branch>`
 * 列出该分支 ref 的全部历史值，最末一条即分支创建时指向的 commit（基准分支当时的 tip），
 * `<创建点>..HEAD` 即本分支自创建以来新加的全部提交，精确贴合「创建到现在」语义。
 * 纯本地查询、不写文件、不联网，且对 GitHub 网页拉的分支同样有效（本地 checkout 即写 reflog）。
 *
 * reflog 会过期/gc（默认 90 天）或因 rename 取不到——此时回退拓扑推断：在 origin/main 等候选里
 * 取「是 HEAD 祖先且 HEAD 领先数最小」者，用其 merge-base 作 fork-point。拓扑仍不可用返回 null，
 * 由调用方按「最近 N 条提交」兜底。
 *
 * @param {string} repoPath
 * @returns {Promise<string | null>} 形如 '<sha>..HEAD' 的范围；无合适范围返回 null
 */
async function resolveRange(repoPath) {
  // 1. 优先：reflog 还原分支创建点（最准、贴合「创建到现在」）
  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  const branch = head.code === 0 ? head.stdout.trim() : ''
  if (branch && branch !== 'HEAD') {
    const rl = await runGit(['log', '-g', '--format=%H', branch], repoPath)
    if (rl.code === 0) {
      const shas = rl.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      // reflog 按时间倒序，最末一条 = 最早的 ref 值 = 分支创建时的 commit（基准当时的 tip）
      const start = shas.length ? shas[shas.length - 1] : ''
      if (start) {
        // 创建点必然是 HEAD 的祖先；防御性校验，不通过则弃用 reflog 结果走拓扑
        const anc = await runGit(['merge-base', '--is-ancestor', start, 'HEAD'], repoPath)
        if (anc.code === 0) return `${start}..HEAD`
      }
    }
  }

  // 2. 回退：远端优先 + 取是祖先且领先数最小的候选，用 merge-base 作 fork-point
  const candidates = ['origin/main', 'main', 'origin/master', 'master', 'origin/develop', 'develop']
  let best = null
  let bestAhead = Infinity
  for (const c of candidates) {
    const ex = await runGit(['rev-parse', '--verify', '--quiet', c], repoPath)
    if (ex.code !== 0 || !ex.stdout.trim()) continue
    // 必须是 HEAD 的祖先：is-ancestor 返回 0 表示 c 的提交全在 HEAD 里（即「HEAD 从 c 拉出来」）
    const anc = await runGit(['merge-base', '--is-ancestor', c, 'HEAD'], repoPath)
    if (anc.code !== 0) continue
    const ahead = await runGit(['rev-list', '--count', `${c}..HEAD`], repoPath)
    const n = ahead.code === 0 ? parseInt(ahead.stdout.trim(), 10) || 0 : Infinity
    if (n < bestAhead) {
      bestAhead = n
      best = c
    }
  }
  if (best) {
    const mb = await runGit(['merge-base', best, 'HEAD'], repoPath)
    if (mb.code === 0 && mb.stdout.trim()) return `${mb.stdout.trim()}..HEAD`
  }
  return null
}

/**
 * 取仓库的 origin 远程地址（git remote get-url origin）。无 origin / 非 git 仓库返回 null。
 * 供拼接「当前分支的 GitHub 页」等外链：原始地址可能是 SSH 或 HTTPS，用 normalizeGitUrl 归一化。
 * @param {string} repoPath
 * @returns {Promise<string | null>}
 */
export async function getRemoteUrl(repoPath) {
  if (!isGitRepo(repoPath)) return null
  const r = await runGit(['remote', 'get-url', 'origin'], repoPath)
  return r.code === 0 ? r.stdout.trim() : null
}

/**
 * 轻量取仓库分支信息：当前分支 + 本地分支列表。供弹窗选基准/目标/主分支用（不计算 changedFiles）。
 * @param {string} repoPath
 * @returns {Promise<{ current: string | null, branches: string[] }>}
 */
export async function listBranches(repoPath) {
  if (!isGitRepo(repoPath)) return { current: null, branches: [] }
  const cur = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  const current = cur.code === 0 ? cur.stdout.trim() : null
  const br = await runGit(['branch', '--list'], repoPath)
  const branches =
    br.code === 0
      ? [
          ...new Set(
            br.stdout
              .split('\n')
              .map((l) => l.replace(/^\* /, '').trim())
              .filter(Boolean),
          ),
        ]
      : []
  return { current, branches }
}

/**
 * fetch 后列出所有可切换分支，按本地 / 远程分组返回（保留区分信息，供下拉标注）。
 * 用于分支切换下拉的懒加载：扫描时不 fetch（避免逐仓库网络请求拖慢首屏），
 * 用户展开下拉时才按需 fetch origin，拿到完整远程分支。
 * 离线时 fetch 失败仍返回本地已知的远程 refs（refs/remotes）。
 * 切换时 `git checkout <name>` 对本地不存在的分支会自动 DWIM 跟踪 origin/<name>，无需改 checkout。
 * @param {string} repoPath
 * @param {{ fetch?: boolean }} [opts] fetch 默认 true
 * @returns {Promise<{ current: string | null, local: string[], remote: string[] }>}
 *   local  本地分支名（refs/heads）；remote 远程分支名（仅 origin/，去前缀、去 HEAD）
 */
export async function listAllBranches(repoPath, { fetch = true } = {}) {
  if (!isGitRepo(repoPath)) return { current: null, local: [], remote: [] }
  const cur = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  const current = cur.code === 0 ? cur.stdout.trim() : null
  if (fetch) {
    await runGit(['fetch', 'origin', '--prune'], repoPath, { timeout: 60000 }) // 失败忽略，下面仍列已知 refs
  }
  const [loc, rem] = await Promise.all([
    runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath),
    runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repoPath),
  ])
  const local = loc.code === 0 ? uniqLines(loc.stdout) : []
  const remote =
    rem.code === 0
      ? [
          ...new Set(
            rem.stdout
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .filter((l) => l.startsWith('origin/')) // 仅 origin 远程分支
              .map((l) => l.slice('origin/'.length))
              .filter((l) => l && l !== 'HEAD' && !l.includes('->')),
          ),
        ].sort()
      : []
  return { current, local, remote }
}

/**
 * 当前分支最终的改动文件清单（去重、排序）= 已提交改动 ∪ 工作区未提交改动，即「最终的 template 变动」。
 * 已提交部分：自分支创建点（reflog 还原，回退拓扑推断）以来、HEAD 之间各提交改动过的文件并集；
 * 取不到范围（detached HEAD 且无候选基准等）时，回退为「最近 maxCount 个提交改动过的文件」。
 * 用 `git log --name-only`（而非 diff）以覆盖「改了又改回」的文件；未提交部分用 `git status --porcelain`。
 * @param {string} repoPath
 * @param {{ maxCount?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(repoPath, { maxCount = 20 } = {}) {
  const range = await resolveRange(repoPath)

  // core.quotepath=false：非 ASCII 路径原样输出，避免中文文件名被转成 "\344\270\255" 八进制转义
  const args = ['-c', 'core.quotepath=false', 'log', '--name-only', '--no-merges', '--pretty=format:']
  if (range) args.push(range)
  else args.push('-n', String(maxCount), 'HEAD')

  const lg = await runGit(args, repoPath)
  const committed = uniqLines(lg.code === 0 ? lg.stdout : '').map(unquotePath)

  // 合并工作区未提交改动（已暂存 / 未暂存），与已提交记录去重，得到最终的 template 变动
  const dirty = await workingTreeFiles(repoPath)
  return uniqLines(`${committed.join('\n')}\n${dirty.join('\n')}`)
}

/**
 * 判断目录是否为 git 仓库：存在 .git（目录或文件均算，覆盖 worktree/submodule）。
 * @param {string} dir
 * @returns {boolean}
 */
export function isGitRepo(dir) {
  try {
    return existsSync(join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * 取单个仓库的信息：当前分支 / 分支列表 / 当前分支自创建以来改动过的文件。
 * @param {string} repoPath 仓库目录
 * @param {{ maxCount?: number }} [opts] maxCount 回退时取最近提交条数，默认 20
 * @returns {Promise<{
 *   path: string, name: string, isRepo: boolean,
 *   currentBranch: string | null, branches: string[], branchCount: number,
 *   changedFiles: string[]
 * }>}
 */
export async function getRepoInfo(repoPath, { maxCount = 20 } = {}) {
  const name = basename(repoPath)
  if (!isGitRepo(repoPath)) {
    return { path: repoPath, name, isRepo: false, currentBranch: null, branches: [], branchCount: 0, changedFiles: [], remoteUrl: null }
  }

  // 当前分支 + 本地分支列表（复用 listBranches）；远程地址（origin）并行取，供拼接分支外链
  const [{ current: currentBranch, branches }, remoteUrl] = await Promise.all([
    listBranches(repoPath),
    getRemoteUrl(repoPath),
  ])

  // 当前分支最终的改动文件（已提交 ∪ 工作区未提交，去重）
  const changedFiles = await getChangedFiles(repoPath, { maxCount })

  return { path: repoPath, name, isRepo: true, currentBranch, branches, branchCount: branches.length, changedFiles, remoteUrl }
}

/**
 * 扫描目录下一层的 git 仓库（rootDir 自身是仓库也收录），并返回每个仓库的详细信息。
 * 只扫一层（符合「工作区文件夹下挂多个项目仓库」的常见布局），跳过 `.` 开头与 node_modules。
 * @param {string} rootDir 工作区目录
 * @param {{ maxCount?: number }} [opts] 透传给 getRepoInfo
 * @returns {Promise<ReturnType<getRepoInfo>[]>}
 */
export async function scanGitRepos(rootDir, opts) {
  const found = []
  if (isGitRepo(rootDir)) found.push(rootDir)

  let entries = []
  try {
    entries = readdirSync(rootDir)
  } catch {
    return found.length ? Promise.all(found.map((p) => getRepoInfo(p, opts))) : []
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(rootDir, entry)
    try {
      if (statSync(full).isDirectory() && isGitRepo(full)) found.push(full)
    } catch {
      // 无权限/符号链接异常等：跳过
    }
  }

  // 去重保序（rootDir 自身与其子项不会重复，防御性去重）
  const uniq = [...new Set(found)]
  return Promise.all(uniq.map((p) => getRepoInfo(p, opts)))
}

/**
 * 从 git 远程地址解析仓库名（取路径最后一段、去 `.git`）。
 * 支持 SSH（git@github.com:org/Repo.git）与 HTTPS（https://github.com/org/Repo.git）。
 * @param {string} url
 * @returns {string}
 */
export function repoNameFromUrl(url) {
  const cleaned = String(url).trim().replace(/\.git$/, '')
  // SSH 用 ':' 分隔 host:path；HTTPS 用 '/'。统一取最后一段。
  const last = cleaned.replace(/^.*[:/]/, '')
  return last || cleaned
}

/**
 * 把任意 git 远程地址归一化为 https URL（去 .git；SSH/git/ssh 协议头 → https）。
 *   git@github.com:org/Repo.git    → https://github.com/org/Repo
 *   https://github.com/org/Repo.git → https://github.com/org/Repo
 * 供「拼接当前分支页」等外链用（非 https 形式浏览器打不开）。空值返回 ''。
 * @param {string} url
 * @returns {string}
 */
export function normalizeGitUrl(url) {
  let u = String(url || '').trim()
  if (!u) return ''
  u = u.replace(/\.git$/, '')
  u = u.replace(/^git@([^:]+):/, 'https://$1/') // git@host:org/repo → https://host/org/repo
  u = u.replace(/^git:\/\//, 'https://') // git://host/... → https://...
  u = u.replace(/^ssh:\/\/(?:[^/@]+@)?/, 'https://') // ssh://[user@]host/... → https://host/...
  return u
}

/**
 * 从 git 远程地址解析 GitHub owner/repo（SSH/HTTPS 均可，复用 normalizeGitUrl 归一化）。
 * 非 github.com / 解析失败返回 null。供调 GitHub REST API 拼 /repos/{owner}/{repo} 用。
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseOwnerRepoFromUrl(url) {
  const https = normalizeGitUrl(url) // → https://github.com/owner/Repo
  const m = https.match(/github\.com\/([^/]+)\/([^/?#]+)/i)
  return m ? { owner: m[1], repo: m[2] } : null
}

/**
 * 取仓库的 GitHub 协作者列表（login/头像/主页）。需 token；非 github 仓库返回 []。
 * token 来源优先级：显式传入（来自 settings.githubToken）> 环境变量 GH_TOKEN/GITHUB_TOKEN（终端启动兼容）。
 * 调 GitHub REST API /repos/{owner}/{repo}/collaborators（per_page=100；单仓库 >100 人需加分页，当前最多 46 够用）。
 * 错误分层：无 origin / 非 github → []（下拉空、不报错）；无 token / API 失败 → throw（由 IPC 转 {ok:false}）。
 * @param {string} repoPath
 * @param {string} [token] 显式传入的 GitHub token（来自 settings.githubToken）
 * @returns {Promise<Array<{ login: string, avatar: string, url: string }>>}
 */
export async function getCollaborators(repoPath, token) {
  const url = await getRemoteUrl(repoPath)
  if (!url) return []
  const or = parseOwnerRepoFromUrl(url)
  if (!or) return [] // 非 github 仓库
  const tok = token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!tok) throw new Error('NO_TOKEN') // 特殊标识：前端据此显示 token 输入框（而非普通错误）
  const res = await fetch(
    `https://api.github.com/repos/${or.owner}/${or.repo}/collaborators?per_page=100`,
    { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' } },
  )
  if (!res.ok) {
    let body = null
    try {
      body = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    const msg = body?.message ? `：${body.message}` : ''
    if (res.status === 404) {
      throw new Error(
        `HTTP 404${msg}。常见原因：① Token 未勾选 repo 权限；② Token 所属账号不是该仓库协作者（无访问权限）；③ 仓库不存在或远程地址解析错误。`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}${msg}。请检查 GitHub Token 是否有效、是否过期、是否勾选了 repo 权限。`)
    }
    throw new Error(`HTTP ${res.status}${msg}`)
  }
  const list = await res.json()
  return list.map((c) => ({ login: c.login, avatar: c.avatar_url, url: c.html_url }))
}

/**
 * 请求 PR reviewer：先一次性请求全部，422/失败则逐个重试过滤掉被拒的 login，最大限度把能加的都加上。
 * 被拒常见原因：该 login 非仓库直接协作者、或为 PR 作者本人、或组织仓库且非组织成员；
 * requested_reviewers 只要有一个无效就整组失败，故失败时降级逐个重试以找出被拒者。
 * @param {{ owner: string, repo: string }} or
 * @param {string} tok
 * @param {number} number PR 编号
 * @param {string[]} reviewers login 数组
 * @returns {Promise<{ failed: string[], error: string }>} failed=未能添加的 login；error=首次失败的 GitHub message
 */
async function addReviewers(or, tok, number, reviewers) {
  const endpoint = `https://api.github.com/repos/${or.owner}/${or.repo}/pulls/${number}/requested_reviewers`
  const headers = {
    Authorization: `Bearer ${tok}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  }
  const tryOnce = async (list) => {
    const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ reviewers: list }) })
    if (r.ok) return { ok: true, msg: '' }
    let msg = ''
    try {
      msg = (await r.json())?.message || ''
    } catch {
      /* 非 JSON 响应 */
    }
    return { ok: false, msg }
  }
  const all = await tryOnce(reviewers)
  if (all.ok) return { failed: [], error: '' }
  // 一次性失败：多个 reviewer 时逐个重试找出被拒者；单个直接判失败
  if (reviewers.length <= 1) return { failed: [...reviewers], error: all.msg }
  const failed = []
  for (const login of reviewers) {
    const one = await tryOnce([login])
    if (!one.ok) failed.push(login)
  }
  return { failed, error: all.msg }
}

/**
 * 在 GitHub 上创建 Pull Request，并可选地请求 reviewer 审核。
 * head=源分支、base=目标分支；reviewers 为 GitHub login 数组（来自 getCollaborators，已是协作者）。
 * token 来源优先级同 getCollaborators。返回 PR 编号与页面链接；reviewer 请求失败不致命（PR 已建好）。
 * 错误分层：无 origin/非 github 抛错；无 token 抛 'NO_TOKEN'；422 给出可读校验详情
 * （常见：已有打开的 PR / head 与 base 相同 / head 未推到远程）。
 * @param {string} repoPath
 * @param {{ title: string, head: string, base: string, body?: string, reviewers?: string[] }} opts
 * @param {string} [token] 显式传入的 GitHub token（来自 settings.githubToken）
 * @returns {Promise<{ number: number, url: string, reviewerWarning?: boolean }>}
 */
export async function createPullRequest(repoPath, opts, token) {
  const url = await getRemoteUrl(repoPath)
  if (!url) throw new Error('未找到 git 远程地址（origin）')
  const or = parseOwnerRepoFromUrl(url)
  if (!or) throw new Error('远程地址不是 GitHub 仓库，无法创建 PR')
  const tok = token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!tok) throw new Error('NO_TOKEN')
  const { title, head, base, body, reviewers } = opts || {}
  const res = await fetch(`https://api.github.com/repos/${or.owner}/${or.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, head, base, body }),
  })
  if (!res.ok) {
    let b = null
    try {
      b = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    const msg = b?.message ? `：${b.message}` : ''
    if (res.status === 422) {
      const errs = Array.isArray(b?.errors) && b.errors.length
        ? `（${b.errors.map((e) => e.message).filter(Boolean).join('；')}）`
        : ''
      throw new Error(
        `创建 PR 失败：HTTP 422${msg}${errs}。常见：该分支已有打开的 PR；或 head 与 base 相同；或 head 分支尚未推到远程。`,
      )
    }
    if (res.status === 404) {
      throw new Error(
        `HTTP 404${msg}。常见原因：① Token 未勾选 repo 权限；② Token 所属账号不是该仓库协作者（无访问权限）；③ 仓库不存在或远程地址解析错误。`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}${msg}。请检查 GitHub Token 是否有效、是否过期、是否勾选了 repo 权限。`)
    }
    throw new Error(`创建 PR 失败：HTTP ${res.status}${msg}`)
  }
  const pr = await res.json()
  // 请求 reviewer：PR 已建好。先一次性请求，失败则逐个重试过滤被拒者，返回被拒名单/原因给前端。
  if (Array.isArray(reviewers) && reviewers.length) {
    const added = await addReviewers(or, tok, pr.number, reviewers)
    if (added.failed.length) {
      return {
        number: pr.number,
        url: pr.html_url,
        reviewerWarning: true,
        reviewerFailed: added.failed,
        reviewerError: added.error,
      }
    }
  }
  return { number: pr.number, url: pr.html_url }
}

/**
 * 克隆远程仓库到指定目录（创建 intoDir/<repoName>）。
 * @param {string} url 远程地址（模板 `_github`）
 * @param {string} intoDir 目标父目录（工作区）
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string }>}
 */
export async function cloneRepo(url, intoDir, { timeout = 180000 } = {}) {
  const repoName = repoNameFromUrl(url)
  const target = join(intoDir, repoName)
  if (existsSync(target)) return { ok: false, error: `目录已存在：${target}` }
  const r = await runGit(['clone', url, repoName], intoDir, { timeout })
  if (r.code === 0) return { ok: true, path: target }
  return { ok: false, error: (r.stderr || r.stdout || '克隆失败').trim() }
}

/**
 * 判断指定分支名在远程 origin 是否存在。用 `git ls-remote --heads origin <name>` 直接查远程
 * （权威、不依赖本地 fetch、不污染 refs/remotes）；离线/无权限等失败一律按「不存在」处理。
 * @param {string} repoPath
 * @param {string} name 分支名
 * @returns {Promise<boolean>}
 */
export async function remoteBranchExists(repoPath, name) {
  if (!name) return false
  const r = await runGit(['ls-remote', '--heads', 'origin', name], repoPath, { timeout: 30000 })
  return r.code === 0 && r.stdout.trim().length > 0
}

/**
 * 把本地分支推到远程 origin 并设置上游跟踪（git push -u origin <name>）。
 * @param {string} repoPath
 * @param {string} name
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function pushBranch(repoPath, name) {
  const r = await runGit(['push', '-u', 'origin', name], repoPath, { timeout: 120000 })
  if (r.code === 0) return { ok: true }
  return { ok: false, error: (r.stderr || r.stdout || '推送远程失败').trim() }
}

/**
 * 基于基准分支创建（默认并切到）新分支。默认先 fetch origin/<base>，确保基于远程最新代码；
 * 远程无该分支时回退本地 <base>。
 * push=true（「拉取分支」/「创建 release」用）：先校验 origin 是否已存在同名分支——存在则拒绝创建并提示；
 * 否则创建本地分支后用 `git push -u origin <name>` 推到远程并设上游，实现「远程创建 + 拉到本地」。
 * switch=false（「创建 release」用）：用 `git branch` 代替 `git checkout -b`，仅建分支指针、不切换，
 * 当前工作分支与 shopify.theme.toml 保持不动。
 * @param {string} repoPath
 * @param {{ base: string, name: string, fetch?: boolean, push?: boolean, switch?: boolean }} opts
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function createBranch(repoPath, { base, name, fetch = true, push = false, switch: doSwitch = true } = {}) {
  if (!base || !name) return { ok: false, error: '缺少基准分支或新分支名' }
  // 远程已存在同名分支时不允许创建（仅 push 模式校验，避免建了本地分支才发现远程已被占用）
  if (push && (await remoteBranchExists(repoPath, name))) {
    return { ok: false, error: `远程已存在分支 ${name}，不允许创建` }
  }
  if (fetch) {
    await runGit(['fetch', 'origin', base], repoPath, { timeout: 60000 }) // 失败忽略，下面回退本地
  }
  // 优先基于 origin/<base> 最新代码创建；远程无该分支则回退本地 <base>。
  // switch=true（默认）checkout -b 创建并切到新分支；switch=false 用 git branch 仅建指针、不切换。
  const make = (start) => (doSwitch ? ['checkout', '-b', name, start] : ['branch', name, start])
  let r = await runGit(make(`origin/${base}`), repoPath)
  if (r.code !== 0) r = await runGit(make(base), repoPath)
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '创建分支失败').trim() }
  if (push) {
    const pushed = await pushBranch(repoPath, name)
    if (!pushed.ok) return pushed
  }
  return { ok: true }
}

/**
 * 切换本地分支（git checkout <branch>）。工作区有冲突性改动时会失败，由调用方提示。
 * @param {string} repoPath
 * @param {string} branch
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function checkoutBranch(repoPath, branch) {
  if (!branch) return { ok: false, error: '缺少分支名' }
  const r = await runGit(['checkout', branch], repoPath)
  if (r.code === 0) return { ok: true }
  return { ok: false, error: (r.stderr || r.stdout || '切换分支失败').trim() }
}

/**
 * 判断 shopify.theme.toml 是否被 git 跟踪。用 `git ls-files --error-unmatch` 直接查索引：
 * 退出码 0 = 已跟踪（在索引里）；非 0 = 未跟踪（含文件不存在）。供「切换分支同步配置」判断——
 * 已跟踪时 git checkout 已切换了它，不能再删/重建（否则工作区变脏、阻塞后续合并）。
 * @param {string} repoPath
 * @returns {Promise<boolean>}
 */
export async function isTomlTracked(repoPath) {
  const r = await runGit(['ls-files', '--error-unmatch', 'shopify.theme.toml'], repoPath)
  return r.code === 0
}

/**
 * 工作区未提交的文件列表（已暂存或未暂存均算），按 `git status --porcelain` 解析。
 * 空数组表示工作区干净。
 * @param {string} repoPath
 * @returns {Promise<string[]>}
 */
export async function workingTreeFiles(repoPath) {
  // core.quotepath=false + unquotePath：中文/含引号路径原样还原，否则 /\.json$/ 之类的匹配会漏文件
  const r = await runGit(['-c', 'core.quotepath=false', 'status', '--porcelain'], repoPath)
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    // 只过滤空行，不能 trim 整行：「 M path」未暂存修改的首列是空格，
    // trim 会吃掉它导致 slice(3) 错位、路径被截断。
    .filter((l) => l.trim())
    .map((l) => {
      // "XY path"（前 2 列状态码 + 1 空格），rename 形如 "R  old -> new" 取新路径
      const arrow = l.indexOf(' -> ')
      if (arrow >= 0) return unquotePath(l.slice(arrow + 4).trim())
      return unquotePath(l.slice(3).trim())
    })
}

/**
 * 把 source（开发分支）合并进 target（release 分支）；合并前先合 main（主分支）解冲突。
 * 全程在本地分支 ref 上操作；任一步失败则 `git merge --abort` 回到合并前状态并返回失败原因。
 * 执行完会把仓库切回原始分支（detached HEAD 不切）。
 * @param {string} repoPath
 * @param {{ source: string, target: string, main: string }} opts
 * @returns {Promise<{ ok: true } | { ok: false, step: string, error: string }>}
 */
export async function mergeBranches(repoPath, { source, target, main } = {}) {
  if (!source || !target || !main) {
    return { ok: false, step: 'args', error: '缺少 source / target / main 分支' }
  }

  // 合并前必须工作区干净（checkout/merge 才不会被打断）
  const dirty = await workingTreeFiles(repoPath)
  if (dirty.length) {
    return { ok: false, step: 'dirty', error: `工作区有未提交文件：\n${dirty.join('\n')}` }
  }

  const { current: original } = await listBranches(repoPath)
  const restore = async () => {
    if (original && original !== 'HEAD') await runGit(['checkout', original], repoPath)
  }

  try {
    // 1) 切到目标 release 分支
    let r = await runGit(['checkout', target], repoPath)
    if (r.code !== 0) {
      await restore()
      return { ok: false, step: 'checkout', error: (r.stderr || r.stdout || '切换目标分支失败').trim() }
    }

    // 2) 先合主分支到 release（提前解冲突）
    r = await runGit(['merge', main], repoPath)
    if (r.code !== 0) {
      await runGit(['merge', '--abort'], repoPath)
      await restore()
      return { ok: false, step: 'merge-main', error: (r.stderr || r.stdout || '合并主分支失败').trim() }
    }

    // 3) 再合开发分支
    r = await runGit(['merge', source], repoPath)
    if (r.code !== 0) {
      await runGit(['merge', '--abort'], repoPath)
      await restore()
      return { ok: false, step: 'merge-source', error: (r.stderr || r.stdout || '合并开发分支失败').trim() }
    }

    await restore()
    return { ok: true }
  } catch (err) {
    await restore()
    return { ok: false, step: 'unknown', error: err.message }
  }
}
