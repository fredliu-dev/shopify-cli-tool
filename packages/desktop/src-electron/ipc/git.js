import { ipcMain } from 'electron'

const load = () => import('@shopify-cli-tool/core')

/**
 * git 域 IPC handlers。core 是 ESM 包，CJS 主进程用动态 import 加载。
 */
export function registerGitIpc() {
  // 扫描目录下一层的 git 仓库，返回每个仓库的详细信息
  ipcMain.handle('git:scanRepos', async (_evt, dir) => {
    const { scanGitRepos } = await load()
    try {
      return { ok: true, data: await scanGitRepos(dir) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 取单个仓库的详细信息（供刷新单个仓库）
  ipcMain.handle('git:repoInfo', async (_evt, repoPath) => {
    const { getRepoInfo } = await load()
    try {
      return { ok: true, data: await getRepoInfo(repoPath) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
