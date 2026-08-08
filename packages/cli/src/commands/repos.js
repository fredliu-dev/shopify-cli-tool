import pc from 'picocolors'
import { scanGitRepos } from '@shopify-cli-tool/core'

/**
 * `shop repos [目录]` —— 扫描目录下的 Git 仓库，显示当前分支、分支数与最近提交。
 * 不传目录则扫描当前目录（cwd）。只扫一层子目录，跳过 `.` 开头与 node_modules。
 */
export default {
  name: 'repos',
  aliases: ['repos', 'repo'],
  description: '扫描目录下的 Git 仓库，显示当前分支、分支数与最近提交',
  usage: 'shop repos [目录]',
  async run({ argv, log }) {
    // argv[0] 是命令名本身（见 cli/src/index.js），位置参数从 argv[1] 起
    const dir = argv.slice(1).find((a) => !a.startsWith('-')) || process.cwd()

    const repos = await scanGitRepos(dir, { maxCount: 10 })
    if (!repos.length) {
      log.info(`在 ${dir} 下未发现 Git 仓库`)
      return
    }

    log.success(`在 ${dir} 下发现 ${repos.length} 个 Git 仓库：`)

    for (const r of repos) {
      console.log(pc.bold(pc.cyan(r.name)) + pc.gray(`  ${r.path}`))
      console.log(
        `  当前分支：${r.currentBranch ? pc.green(r.currentBranch) : pc.gray('-')}   分支数：${r.branchCount}`,
      )

      if (!r.changedFiles.length) {
        console.log(pc.gray('  （当前分支无改动文件）\n'))
        continue
      }

      console.log(`  改动文件（${r.changedFiles.length}）：`)
      for (const f of r.changedFiles) console.log(pc.gray(`    ${f}`))
      console.log()
    }
  },
}
