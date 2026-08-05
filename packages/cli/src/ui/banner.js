import boxen from 'boxen'
import gradient from 'gradient-string'
import pc from 'picocolors'

// 品牌色渐变标题（旧版默认 banner 使用）
const brandTitle = gradient('#95BE22', '#3B82F6')(' Shopify Wrapper ')

/**
 * 类型到标签文案与边框颜色映射。
 * @type {Record<string, { label: string, color: string }>}
 */
const typeMap = {
  success: { label: ' success ', color: 'green' },
  info: { label: ' info ', color: 'blue' },
  warning: { label: ' warning ', color: 'yellow' },
  error: { label: ' error ', color: 'red' },
}

/**
 * 打印美化横幅。
 *
 * 支持两种调用方式：
 * 1. 旧版兼容：banner(version) — 打印居中的品牌欢迎横幅。
 * 2. 新版自定义：banner({ type, title, body, align, width, titleStyle, bodyStyle }) — 类似 Shopify 升级提示的左侧标签卡片。
 *
 * @param {string | object} input 版本号字符串，或配置对象。
 * @param {string} [input.type] 标签类型：success | info | warning | error，决定标签文案和边框颜色。默认 info。
 * @param {string} [input.title] 主标题文案。
 * @param {string} [input.body] 正文说明文案。
 * @param {'left' | 'center' | 'right'} [input.align='left'] 内容对齐方式。
 * @param {number} [input.width] 横幅固定宽度（字符数），不设置则自动。
 * @param {function} [input.titleStyle] 标题样式函数，默认 pc.bold + pc.white。
 * @param {function} [input.bodyStyle] 正文样式函数，默认 pc.dim。
 */
export function banner(input) {
  // 旧版兼容：传入版本号字符串
  if (typeof input === 'string') {
    console.log(
      boxen(`${brandTitle}\n${pc.dim(`v${input}  ·  powered by @shopify/cli`)}`, {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'green',
        textAlignment: 'center',
      }),
    )
    return
  }

  const {
    type = 'info',
    title = '',
    body = '',
    align = 'left',
    width,
    titleAlign = 'left',
    titleStyle = pc.bold,
    bodyStyle = pc.dim,
  } = input

  const { label, color } = typeMap[type] || typeMap.info

  const styledTitle = title && titleStyle(title)
  const styledBody = body && bodyStyle(body)

  // 把标签作为第一行内容，模拟左侧标签紧贴边框的卡片效果
  const content = styledBody || ''

  const boxenOptions = {
    padding: { top: 2, bottom: 2, left: 2, right: 2 },
    margin: '5 auto',
    borderStyle: 'round',
    borderColor: color,
    textAlignment: align,
    title: styledTitle || label,
    titleAlignment: titleAlign,
  }

  if (typeof width === 'number' && width > 0) {
    boxenOptions.width = width
  }

  console.log(boxen(content, boxenOptions))
}
