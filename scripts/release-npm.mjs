// 发布到 npm：支持单独发 core / cli 或同时发两者。
// 用法：
//   pnpm release:npm      同时发 core + cli（默认，向后兼容）
//   pnpm release:core     只发 core
//   pnpm release:cli      只发 cli
// 同时发时先 core 后 cli：cli 依赖 core 的 workspace:^，pnpm publish 会把它替换为 core 真实
// 版本号，故 core 必须先发布，cli 才能带上正确的 core 依赖版本。
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const corePkgPath = join(root, 'packages/core/package.json')
const cliPkgPath = join(root, 'packages/cli/package.json')
const coreDir = join(root, 'packages/core')
const cliDir = join(root, 'packages/cli')

const which = (process.argv[2] || 'both').toLowerCase()
if (!['core', 'cli', 'both'].includes(which)) {
  console.error('用法： node scripts/release-npm.mjs [core|cli|both]')
  console.error('  对应： pnpm release:core | pnpm release:cli | pnpm release:npm')
  process.exit(1)
}

const bump = (v, kind) => {
  const [x, y, z] = v.split('.').map(Number)
  if (kind === 'major') return `${x + 1}.0.0`
  if (kind === 'minor') return `${x}.${y + 1}.0`
  return `${x}.${y}.${z + 1}`
}

const core = JSON.parse(readFileSync(corePkgPath, 'utf8'))
const cli = JSON.parse(readFileSync(cliPkgPath, 'utf8'))

console.log(`当前版本：core ${core.version} / cli ${cli.version}`)
console.log(`本次发布：${which}`)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ans = (await rl.question('升级版本位 [1]major [2]minor [3]patch（默认 3）: ')).trim()
rl.close()
const kind = ans === '1' ? 'major' : ans === '2' ? 'minor' : 'patch'

if (which === 'core' || which === 'both') {
  core.version = bump(core.version, kind)
  writeFileSync(corePkgPath, JSON.stringify(core, null, 2) + '\n', 'utf8')
}
if (which === 'cli' || which === 'both') {
  cli.version = bump(cli.version, kind)
  writeFileSync(cliPkgPath, JSON.stringify(cli, null, 2) + '\n', 'utf8')
}
console.log(`→ core ${core.version} / cli ${cli.version}`)

// 顺序：both 时先 core 后 cli——cli 依赖 core，core 先发，cli 的 workspace:^ 才能替换到新 core 版本
if (which === 'core' || which === 'both') {
  console.log('\n发布 core …')
  execSync('pnpm publish --no-git-checks --access public', { stdio: 'inherit', cwd: coreDir })
}
if (which === 'cli' || which === 'both') {
  console.log('\n发布 cli …')
  execSync('pnpm publish --no-git-checks', { stdio: 'inherit', cwd: cliDir })
}

console.log(`\n✅ npm 发布完成（${which}）`)
