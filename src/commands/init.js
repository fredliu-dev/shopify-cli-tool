import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { select, input } from '@inquirer/prompts'

// 工具自带的模板目录（src/config/，相对本文件定位，不是 cwd）
const templatesDir = fileURLToPath(new URL('../config/', import.meta.url))

/**
 * 列出 src/config/ 下的模板：选项名 = 文件名第一个点前的文案。
 * 例：us.shopify.theme.toml → { file, name: 'us' }
 * @returns {{ file: string, name: string }[]}
 */
function listTemplates() {
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith('.toml'))
    .map((f) => ({ file: f, name: f.split('.')[0] }))
}

/**
 * 把模板里某个 key 的值替换为新值（仅首个匹配，保留 key 原有空白格式与其余行/注释）。
 * 自动适配原有写法：带引号（"..."）→ 加引号 + 转义；裸值（如数字 9292）→ 原样写入不加引号。
 * @param {string} content 模板内容
 * @param {string} key     键名，如 'theme' / 'preview_key' / 'port'
 * @param {string} value   要填入的值
 * @returns {string}
 */
function fillValue(content, key, value) {
  const re = new RegExp('^(\\s*' + key + '\\s*=\\s*)(?:"([^"]*)"|([^\\s"\\n]+))', 'm')
  const m = re.exec(content)
  if (!m) return content
  const prefix = m[1]
  const isQuoted = m[2] !== undefined
  const replacement = isQuoted
    ? '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : String(value)
  return content.slice(0, m.index) + prefix + replacement + content.slice(m.index + m[0].length)
}

/**
 * `shop init` —— 在项目根目录初始化 shopify.theme.toml。
 * 已存在则提示「已初始化完毕」；否则引导：选模板 → 输 theme → 输 port → 输 preview_key → 填值生成。
 */
export default {
  name: 'init',
  aliases: ['init'],
  description: '初始化 shopify.theme.toml',
  usage: 'shop init',
  async run({ log }) {
    const target = join(process.cwd(), 'shopify.theme.toml')
    if (existsSync(target)) {
      log.success('已初始化完毕（shopify.theme.toml 已存在）')
      return
    }

    const templates = listTemplates()
    if (!templates.length) {
      log.error('未找到任何模板（src/config/*.toml）')
      return
    }

    let tpl, theme, port, previewKey
    try {
      tpl = await select({
        message: '选择模板：',
        choices: templates.map((t) => ({ name: t.name, value: t })),
      })
      theme = await input({
        message: '请输入 theme：',
        validate: (v) => (v.trim() ? true : '不能为空'),
      })
      port = await input({
        message: '请输入 port：',
        default: '9292',
        validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字'),
      })
      previewKey = await input({ message: '请输入 preview_key（新页面需填）：' })
    } catch (err) {
      // Ctrl+C / ESC 取消：优雅退出，不报「命令执行出错」
      if (err && err.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }

    let content = readFileSync(join(templatesDir, tpl.file), 'utf8')
    content = fillValue(content, 'theme', theme.trim())
    content = fillValue(content, 'port', port.trim())
    content = fillValue(content, 'preview_key', previewKey.trim())

    writeFileSync(target, content, 'utf8')
    log.success(`已创建 ${target}`)
  },
}
