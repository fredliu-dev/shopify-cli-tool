#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { banner } from './ui/banner.js'
import { log } from './ui/logger.js'
import { runShopify } from '@shopify-cli-tool/core'
import { loadCommands } from './registry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
const version = pkg.version

const argv = process.argv.slice(2)

// 加载 src/commands/ 下所有自定义命令
const { commands, resolve } = await loadCommands()

// 传给每个命令 run() 的共享上下文
const ctx = { argv, version, banner, log, runShopify, commands }

// 无参数 → 归一化为 help（顺带让 `shop help` 也生效）
const key = argv.length === 0 ? 'help' : argv[0]
const cmd = resolve(key)

// 命中自定义命令 → 执行；否则原样透传给 @shopify/cli
if (cmd) {
  try {
    const code = await cmd.run(ctx)
    process.exit(code ?? 0)
  } catch (err) {
    log.error(`命令执行出错：${err.message}`)
    process.exit(1)
  }
}

banner(version)
log.step(`执行：shopify ${argv.join(' ')}`)

const code = await runShopify(argv)
if (code === 0) {
  log.success('完成 ✅')
} else {
  log.error(`命令失败，退出码 ${code}`)
  process.exit(code)
}
