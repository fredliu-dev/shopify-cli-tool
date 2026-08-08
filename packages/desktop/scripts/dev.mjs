import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, delimiter } from 'node:path'

// 本包的 node_modules/.bin 加到 PATH 最前：electron-vite 是本包 devDependency，
// 从仓库根目录（pnpm dev:desktop）跑时根 .bin 里没有它，直接 spawn 会 command not found。
// 用 delimiter 而非写死 ':'：Windows 的 PATH 分隔符是 ';'，写死 ':' 会把 PATH 拼坏、electron-vite 找不到。
const here = dirname(fileURLToPath(import.meta.url))
const localBin = join(here, '..', 'node_modules', '.bin')
process.env.PATH = `${localBin}${delimiter}${process.env.PATH ?? ''}`

// 启动前清除从 IDE（VSCode / Trae 等）继承的 electron 环境变量。
// 这些变量会让 electron 以纯 node 模式运行，导致 require('electron') 拿不到 app / BrowserWindow。
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_ENABLE_LOGGING',
]) {
  delete process.env[key]
}

const child = spawn('electron-vite', ['dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
})

child.on('close', (code) => process.exit(code ?? 0))
