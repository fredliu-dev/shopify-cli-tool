// 发布桌面应用：交互选版本位 → bump desktop 版本 → 本机打包验证 → 提示 tag 触发 CI。
// 真正发布到 GitHub Release 由推 desktop-v* tag 触发 CI 完成（本机无 GH_TOKEN 不能直接上传）。
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkgPath = join(root, 'packages/desktop/package.json')

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
execSync('pnpm -F @shopify-cli-tool/desktop package', { stdio: 'inherit', cwd: root })

console.log(`\n✅ 打包完成。要发布到 GitHub Release：`)
console.log(`  git add -A && git commit -m "desktop v${pkg.version}"`)
console.log(`  git tag desktop-v${pkg.version} && git push origin desktop-v${pkg.version}`)
