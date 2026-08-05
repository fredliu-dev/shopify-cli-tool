// 调试 cli：cd 到 packages/cli，跑 shop 命令。透传参数。
//   pnpm dev:cli            → shop（help）
//   pnpm dev:cli -- ls      → shop ls
//   pnpm dev:cli -- pre -e dev
import { chdir } from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
chdir(join(here, '../packages/cli'))

const args = process.argv.slice(2)
console.log('当前目录:', process.cwd())
console.log('执行: shop', args.join(' '), '\n')
const child = spawn('node', ['src/index.js', ...args], { stdio: 'inherit' })
child.on('close', (c) => process.exit(c ?? 0))
