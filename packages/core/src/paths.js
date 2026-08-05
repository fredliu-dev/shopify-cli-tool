import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'shopify-cli-tool'

/**
 * 用户数据目录（位于包之外，更新/重装包都不会丢失）。
 *   Windows: %APPDATA%/shopify-cli-tool
 *   其它:    ${XDG_CONFIG_HOME:-~/.config}/shopify-cli-tool
 */
export function userDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_NAME)
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_NAME)
}

/** 确保数据目录存在并返回其路径。 */
export function ensureDataDir() {
  const dir = userDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
