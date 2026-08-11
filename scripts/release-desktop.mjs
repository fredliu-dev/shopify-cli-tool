// 发布桌面应用：交互选版本位 → bump desktop 版本 → 本机打包验证 → 自动提交/tag → 确认推送触发 CI。
// 真正发布到 GitHub Release 由推 desktop-v* tag 触发 CI 完成（本机无 GH_TOKEN 不能直接上传）。
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkgPath = join(root, 'packages/desktop/package.json')

/** 以 inherit stdio 在仓库根跑命令，失败（非 0）即抛错中止脚本。 */
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root })

/** 取当前分支名（detached HEAD 返回 'HEAD'）。 */
const currentBranch = () =>
  execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: root }).trim()

const bump = (v, kind) => {
  const [x, y, z] = v.split('.').map(Number)
  if (kind === 'major') return `${x + 1}.0.0`
  if (kind === 'minor') return `${x}.${y + 1}.0`
  return `${x}.${y}.${z + 1}`
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
console.log(`当前版本：desktop ${pkg.version}`)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ans = (await rl.question('升级版本位 [1]major [2]minor [3]patch（默认 3）: ')).trim()
rl.close()
const kind = ans === '1' ? 'major' : ans === '2' ? 'minor' : 'patch'
pkg.version = bump(pkg.version, kind)
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`→ desktop ${pkg.version}`)

console.log('\n本机打包（packages/desktop/release/，不上传 Release）…')
run('pnpm -F @shopify-cli-tool/desktop package')

// 自动提交 version 改动 + 打 tag。只提交 package.json，避免把工作区其他改动混进发版 commit
// （其余改动留在工作区，可之后单独提交）；与 git log 中 "desktop v*" 纯发版 commit 的模式一致。
const tagName = `desktop-v${pkg.version}`
console.log(`\n提交版本改动并打 tag ${tagName} …`)
run('git add packages/desktop/package.json')
run(`git commit -m "desktop v${pkg.version}"`)
run(`git tag ${tagName}`)

// 推 tag 才会触发 CI 发布到 GitHub Release——确认后再推（给本地验证产物留时间，公开发布的最后一关）
const rl2 = createInterface({ input: process.stdin, output: process.stdout })
const push = (await rl2.question('\n✅ 已提交并打 tag。立即推送 origin 触发 CI 发布？[Y/n] '))
  .trim()
  .toLowerCase()
rl2.close()
if (push === 'n') {
  console.log('已跳过推送。稍后手动执行：')
  const br = currentBranch()
  if (br && br !== 'HEAD') console.log(`  git push origin ${br}`)
  console.log(`  git push origin ${tagName}`)
  process.exit(0)
}

// 先推当前分支（让 tag 指向的 commit 在远端存在），再推 tag 触发 CI
const branch = currentBranch()
if (branch && branch !== 'HEAD') {
  run(`git push origin ${branch}`)
} else {
  console.log('⚠️ 当前是 detached HEAD，未推分支；tag 仍会推送（其指向的 commit 会一并上传）。')
}
run(`git push origin ${tagName}`)
console.log('\n🚀 已推送。CI 构建发布进度：https://github.com/fredliu-dev/shopify-cli-tool/actions')
