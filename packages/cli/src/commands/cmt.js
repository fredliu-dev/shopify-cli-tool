import { spawn } from 'node:child_process'
import { select, input } from '@inquirer/prompts'
import pc from 'picocolors'
import { isGitRepo, workingTreeFiles, COMMIT_TYPES, formatCommitTitle } from '@shopify-cli-tool/core'

/**
 * 以 inherit stdio 跑 git 子进程，让 commit 输出实时透传给用户（不被捕获）。
 * @param {string[]} args 透传给 git 的参数
 * @returns {Promise<number>} 退出码
 */
function runGitLive(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: 'inherit' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/**
 * `shop cmt` —— 按规范生成并提交 git commit，随后推送到远程分支。
 * 流程：选 Commit 类型 → 输入描述 → 拼成「[类型]: 描述」→ git add -A 后提交 → git push。
 * 类型不符规范时直接退出（Ctrl+C）按取消处理，不抛错。
 */
export default {
  name: 'cmt',
  aliases: ['cmt'],
  description: '按规范生成并提交 git commit（feat/fix/refactor/style/perf/merge）',
  usage: 'shop cmt',
  async run({ log }) {
    const cwd = process.cwd()

    if (!isGitRepo(cwd)) {
      log.error('当前目录不是 Git 仓库')
      return 1
    }

    // 工作区无改动则提前退出，避免白填一遍描述
    const dirty = await workingTreeFiles(cwd)
    if (!dirty.length) {
      log.warn('工作区干净，没有可提交的改动')
      return
    }
    log.info(`将提交 ${dirty.length} 个改动文件`)

    // ① 选择 Commit 类型
    let type
    try {
      type = await select({
        message: '选择 Commit 类型：',
        choices: COMMIT_TYPES.map((t) => ({ name: `${pc.bold(t.value)}  -  ${t.desc}`, value: t.value })),
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // ② 输入 commit 描述
    let message
    try {
      message = await input({
        message: '请输入 commit 描述：',
        validate: (v) => (v.trim() ? true : '不能为空'),
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    // ③ 拼接规范信息：[类型]: 描述，然后 git add -A + commit
    const commitMsg = formatCommitTitle(type, message)
    log.step(`提交信息：${pc.cyan(commitMsg)}`)

    const addCode = await runGitLive(['add', '-A'])
    if (addCode !== 0) {
      log.error('git add 失败')
      return addCode
    }

    const code = await runGitLive(['commit', '-m', commitMsg])
    if (code !== 0) {
      log.error(`提交失败，退出码 ${code}`)
      return code
    }
    log.success('提交成功 ✅')

    // ④ 推送前二次确认：选择框（非输入框），默认「否」，避免误推送远程分支
    let shouldPush
    try {
      shouldPush = await select({
        message: '是否推送到远程分支？',
        default: false,
        choices: [
          { name: '否，暂不推送', value: false },
          { name: '是，立即推送', value: true },
        ],
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    if (!shouldPush) {
      log.info('已跳过推送（可稍后手动执行 git push）')
      return 0
    }

    // 推送到远程分支：HEAD 自动解析为当前分支；-u 首次推送时设置上游跟踪，已设则无害
    log.step('推送到远程分支...')
    const pushCode = await runGitLive(['push', '-u', 'origin', 'HEAD'])
    if (pushCode === 0) {
      log.success('推送成功 🚀')
    } else {
      log.error(`推送失败，退出码 ${pushCode}（可稍后手动执行 git push）`)
    }
    return pushCode
  },
}
