import { commandTable } from '../ui/table.js'

// 透传示例（仅作展示，原样转发给 @shopify/cli）
const PASSTHROUGH_EXAMPLES = [
  ['shop app dev', '启动本地应用开发服务器'],
  ['shop theme pull', '拉取线上主题文件到本地'],
  ['shop theme push', '推送本地主题到店铺'],
  ['shop theme dev', '本地实时预览主题'],
]

/**
 * `shop -h` / `shop --help` / `shop help` / 无参数 —— 打印帮助。
 */
export default {
  name: 'help',
  aliases: ['-h', '--help'],
  description: '查看本帮助',
  usage: 'shop -h, --help',
  async run({ version, banner, log, commands }) {
    banner(version)
    log.info('透传命令（原样转发给 @shopify/cli）：')
    console.log(commandTable(PASSTHROUGH_EXAMPLES))
    console.log()
    log.info('自定义命令：')
    const rows = commands
      .filter((c) => !c.hidden)
      .map((c) => [c.usage ?? `shop ${c.aliases.join(', ')}`, c.description])
    console.log(commandTable(rows))
  },
}
