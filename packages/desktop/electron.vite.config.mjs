import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 入口目录刻意不叫 electron/，避免与必须 externalize 的 'electron' 包前缀匹配
// （rollup 会把 electron/main.js 当成 electron 包的一部分给外部化）。
const external = (id) =>
  id === 'electron' ||
  id === '@shopify-cli-tool/core' ||
  id === 'electron-updater' ||
  id.startsWith('node:')

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src-electron/main.js' },
        external,
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: 'src-electron/preload.js' },
        external,
      },
    },
  },
  renderer: {
    root: 'src',
    build: {
      rollupOptions: { input: { index: 'src/index.html' } },
    },
    plugins: [react()],
  },
})
