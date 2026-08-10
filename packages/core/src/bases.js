import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, ensureDataDir } from './paths.js'

const DATA_DIR = userDataDir()
const BASES_FILE = join(DATA_DIR, 'bases.json')

/**
 * 按「仓库 + 分支」记录其基准分支（创建分支时由 createBranch 写入）。
 *
 * 为什么需要它：getChangedFiles 要取「本分支自 fork-point 以来的改动」，但 Git 不存「父分支」，
 * 纯靠拓扑推断（最近祖先/下游）在「已合并回 release」的分支上会失效——release 翻成下游、
 * 且和兄弟分支（如 hotfix）都让 base..HEAD=0，分不清。而 createBranch 创建时本就知道 base，
 * 记下来即可直接用，不再猜。
 *
 * 结构：{ "<repoPath>": { "<branch>": "<base>" } }——按仓库分组、分支为内层 key，
 * 同一仓库不同分支基准可不同（每个分支基准都可能不同）。嵌套结构免去拼接分隔符的歧义。
 * 存 userDataDir/bases.json，与 projects.json 同级、独立，不耦合 toml（toml 会被删/清）。
 */
function loadAll() {
  ensureDataDir()
  if (!existsSync(BASES_FILE)) return {}
  try {
    return JSON.parse(readFileSync(BASES_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveAll(map) {
  ensureDataDir()
  writeFileSync(BASES_FILE, JSON.stringify(map, null, 2), 'utf8')
}

/**
 * 记录某仓库某分支的基准分支（createBranch 成功后调用）。
 * @param {string} repoPath 仓库目录
 * @param {string} branch 新建的分支名
 * @param {string} base 基准分支名（如 'release/version-backtoschool'）
 */
export function recordBase(repoPath, branch, base) {
  if (!repoPath || !branch || !base) return
  const map = loadAll()
  if (!map[repoPath]) map[repoPath] = {}
  map[repoPath][branch] = base
  saveAll(map)
}

/**
 * 取某仓库某分支记录过的基准分支；未记录返回 null。
 * @param {string} repoPath 仓库目录
 * @param {string} branch 分支名
 * @returns {string | null}
 */
export function getRecordedBase(repoPath, branch) {
  if (!repoPath || !branch) return null
  return loadAll()[repoPath]?.[branch] ?? null
}
