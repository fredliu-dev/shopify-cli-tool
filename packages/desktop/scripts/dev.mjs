import { spawn } from 'node:child_process'

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
