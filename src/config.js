import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { parse } from 'smol-toml'
import { log } from './ui/logger.js'

const CONFIG_FILE = 'shopify.theme.toml'

/**
 * 从 startDir 逐级向上查找 shopify.theme.toml，直到文件系统根。
 * 读取位置是 cwd（用户的主题项目目录），不是本工具的 __dirname。
 * @param {string} [startDir=process.cwd()]
 * @returns {string | undefined} 配置文件绝对路径，找不到返回 undefined
 */
export function findThemeConfig(startDir = process.cwd()) {
  let dir = startDir
  // 逐级向上，直到 dirname 不再变化（即到达文件系统根）
  while (true) {
    const candidate = join(dir, CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 读取并解析 shopify.theme.toml。
 * @returns {{ path: string, environments: Record<string, object> } | null}
 *   文件不存在或解析失败返回 null（解析失败会 warn，但不阻断透传）。
 */
export function loadThemeConfig() {
  const path = findThemeConfig()
  if (!path) return null

  let parsed
  try {
    parsed = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    log.warn(`解析 ${basename(path)} 失败：${err.message}`)
    return null
  }

  return { path, environments: parsed.environments ?? {} }
}

/**
 * 解析命令对应的环境参数对象（shopify.theme.toml 里 [environments.<name>] 的内容）。
 * 纯函数：不打印、无副作用，只把参数对象 return 出来。
 * @param {string[]} args 含 -e/--environment 的参数
 * @returns {Record<string, string | number> | null}
 *   命中时返回该环境的参数对象（如 { domain, theme, store, port, preview_key }）；
 *   未带 -e、找不到文件、或环境名不存在时返回 null。
 */
export function resolveEnvironment(args) {
  const name = extractEnvironmentArg(args)
  if (!name) return null
  const cfg = loadThemeConfig()
  if (!cfg) return null
  return cfg.environments[name] ?? null
}

/**
 * 从 argv 中提取环境名，识别四种写法：
 *   -e dev | -e=dev | --environment dev | --environment=dev
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function extractEnvironmentArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '-e' || tok === '--environment') {
      return argv[i + 1] // 下一个 token 作为值；缺失则 undefined
    }
    if (tok.startsWith('-e=')) return tok.slice(3)
    if (tok.startsWith('--environment=')) return tok.slice('--environment='.length)
  }
  return undefined
}
