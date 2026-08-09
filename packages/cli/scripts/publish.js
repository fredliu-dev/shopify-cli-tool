#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { select } from '@inquirer/prompts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgPath = join(__dirname, '../package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [x, y, z] = pkg.version.split('.').map(Number)

const choice = await select({
  message: `当前版本 ${pkg.version}，选择要升级的版本位：`,
  choices: [
    { name: `major (${x + 1}.0.0)`, value: 'major' },
    { name: `minor (${x}.${y + 1}.0)`, value: 'minor' },
    { name: `patch (${x}.${y}.${z + 1})`, value: 'patch' },
  ],
})

let nextVersion
switch (choice) {
  case 'major':
    nextVersion = `${x + 1}.0.0`
    break
  case 'minor':
    nextVersion = `${x}.${y + 1}.0`
    break
  case 'patch':
  default:
    nextVersion = `${x}.${y}.${z + 1}`
}

pkg.version = nextVersion
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log(`版本已更新：${pkg.version} → ${nextVersion}`)

// 必须用 pnpm publish：它会自动把 workspace:^ 等协议解析成真实版本号。
// npm publish 不做这个替换，会把 "workspace:^" 原样发上去，导致安装时 EUNSUPPORTEDPROTOCOL。
console.log('正在执行 pnpm publish …')
const result = spawnSync('pnpm', ['publish', '--no-git-checks'], { stdio: 'inherit', shell: true })
process.exit(result.status ?? 0)
