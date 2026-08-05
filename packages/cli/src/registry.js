import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { log } from './ui/logger.js'

/**
 * 自动扫描 src/commands/ 下的 .js 文件并加载为命令模块。
 * - 跳过以 _ 开头的文件（约定：未启用 / WIP）
 * - 单个坏文件（无 default 导出 / 语法错误）会被 warn 后跳过，不影响其它命令
 * - 命令名或别名跨文件冲突 → 启动期抛错
 * - 返回的 commands 按 name 排序，保证 help 顺序确定（readdirSync 在 NTFS 上非字母序）
 * @returns {Promise<{ commands: object[], resolve: (token: string) => object | undefined }>}
 */
export async function loadCommands() {
  const dirUrl = new URL('./commands/', import.meta.url)
  const dirPath = fileURLToPath(dirUrl)

  let files = []
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  } catch (err) {
    // commands 目录不存在等：没有自定义命令，仅透传
    log.warn(`无法读取命令目录：${err.message}`)
    return { commands: [], resolve: () => undefined }
  }

  const commands = []
  for (const file of files) {
    let mod
    try {
      mod = await import(new URL(file, dirUrl).href)
    } catch (err) {
      log.warn(`跳过命令文件 ${file}：${err.message}`)
      continue
    }

    const cmd = mod.default
    if (
      !cmd ||
      typeof cmd !== 'object' ||
      typeof cmd.name !== 'string' ||
      typeof cmd.run !== 'function'
    ) {
      log.warn(`跳过命令文件 ${file}：default 导出需含 string name 与 function run`)
      continue
    }
    commands.push(cmd)
  }

  // name + aliases → 命令 映射；重复则启动期抛错
  const aliasMap = new Map()
  for (const cmd of commands) {
    const tokens = [cmd.name, ...(cmd.aliases ?? [])]
    for (const token of tokens) {
      const existing = aliasMap.get(token)
      if (existing && existing !== cmd) {
        throw new Error(
          `命令别名冲突："${token}" 同时被 ${existing.name} 和 ${cmd.name} 注册`,
        )
      }
      aliasMap.set(token, cmd)
    }
  }

  commands.sort((a, b) => a.name.localeCompare(b.name))

  const resolve = (token) => aliasMap.get(token)
  return { commands, resolve }
}
