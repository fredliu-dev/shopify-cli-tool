/**
 * `shop -v` / `shop --version` —— 打印 banner 后退出。
 */
export default {
  name: 'version',
  aliases: ['-v', '--version'],
  description: '查看本工具版本',
  usage: 'shop -v, --version',
  async run({ version, banner }) {
    banner(version)
  },
}
