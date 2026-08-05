// 调试桌面应用：cd 到 packages/desktop，启动 electron-vite dev。
// 复用 desktop/scripts/dev.mjs：自动清除 IDE 继承的 ELECTRON_RUN_AS_NODE 等变量。
import { chdir } from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
chdir(join(here, '../packages/desktop'))

console.log('当前目录:', process.cwd())
const child = spawn('node', ['scripts/dev.mjs'], { stdio: 'inherit', env: process.env })
child.on('close', (c) => process.exit(c ?? 0))
