import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { log } from './ui/logger.js'

const require = createRequire(import.meta.url)

// @shopify/cli 的 exports 没有暴露 bin 子路径，所以先解析它的 package.json
// （该子路径已暴露），再读 bin 字段定位实际入口脚本。
const pkgJsonPath = require.resolve('@shopify/cli/package.json')
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.shopify
const SHOPIFY_BIN = join(dirname(pkgJsonPath), binRel)

/**
 * 用子进程跑 @shopify/cli，shopify 自身的彩色输出原样透传。
 * （环境参数请用 config.js 的 resolveEnvironment(args) 单独获取。）
 * @param {string[]} args 透传给 shopify 的参数（原样，不做改动）
 * @returns {Promise<number>} 进程退出码
 */
export function runShopify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHOPIFY_BIN, ...args], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    })
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      log.error(`无法启动 shopify：${err.message}`)
      resolve(1)
    })
  })
}
