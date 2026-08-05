// 发布到 npm：交互选版本位 → 同时 bump core 和 cli → 先发 core 后发 cli。
// pnpm publish 会自动把 cli 的 "@shopify-cli-tool/core": "workspace:^"
// 替换为 core 的真实版本号，所以发布出去的是正常依赖。
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const corePkgPath = join(root, 'packages/core/package.json')
const cliPkgPath = join(root, 'packages/cli/package.json')

const bump = (v, kind) => {
  const [x, y, z] = v.split('.').map(Number)
  if (kind === 'major') return `${x + 1}.0.0`
  if (kind === 'minor') return `${x}.${y + 1}.0`
  return `${x}.${y}.${z + 1}`
}

const core = JSON.parse(readFileSync(corePkgPath, 'utf8'))
const cli = JSON.parse(readFileSync(cliPkgPath, 'utf8'))

console.log(`当前版本：core ${core.version} / cli ${cli.version}`)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ans = (await rl.question('升级版本位 [1]major [2]minor [3]patch（默认 3）: ')).trim()
rl.close()
const kind = ans === '1' ? 'major' : ans === '2' ? 'minor' : 'patch'

core.version = bump(core.version, kind)
cli.version = bump(cli.version, kind)
writeFileSync(corePkgPath, JSON.stringify(core, null, 2) + '\n', 'utf8')
writeFileSync(cliPkgPath, JSON.stringify(cli, null, 2) + '\n', 'utf8')
console.log(`→ core ${core.version} / cli ${cli.version}`)

console.log('\n[1/2] 发布 core …')
execSync('pnpm publish --no-git-checks --access public', {
  stdio: 'inherit',
  cwd: join(root, 'packages/core'),
})

console.log('\n[2/2] 发布 cli …')
execSync('pnpm publish --no-git-checks', {
  stdio: 'inherit',
  cwd: join(root, 'packages/cli'),
})

console.log('\n✅ npm 发布完成（core + cli）')
