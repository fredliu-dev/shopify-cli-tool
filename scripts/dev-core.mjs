// 调试 core：cd 到 packages/core，跑一遍 smoke 验证导出与关键函数。
// core 是纯逻辑库，改完即时被 cli/desktop 引用生效，无需 build。
import { chdir } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
chdir(join(here, '../packages/core'))

const core = await import('../packages/core/src/index.js')

console.log('当前目录:', process.cwd())
console.log('core 导出:', Object.keys(core).sort().join(', '))
console.log('\nlistTemplates():', core.listTemplates().map((t) => t.name).join(', '))
console.log('assembleProjects():', core.assembleProjects().length, '个项目')
console.log('\n（改完 core 源码，cli 和 desktop 会立即生效）')
