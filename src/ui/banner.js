import boxen from 'boxen'
import gradient from 'gradient-string'
import pc from 'picocolors'

// 品牌色渐变标题
const title = gradient('#95BE22', '#3B82F6')(' Shopify Wrapper ')

/**
 * 打印美化横幅。
 * @param {string} version 当前版本号
 */
export function banner(version) {
  console.log(
    boxen(`${title}\n${pc.dim(`v${version}  ·  powered by @shopify/cli`)}`, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'green',
      textAlignment: 'center',
    }),
  )
}
