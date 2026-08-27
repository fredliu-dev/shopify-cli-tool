// 爬虫页苹果化设计令牌：专业工具风（近黑基底 + 毛玻璃分层 + 发丝线 + Apple 暗色系统色）。
// 只在本页内引用，不动全站主题。纯样式令牌，macOS / Windows 通用：
// - 字体走跨平台系统栈：mac 落 SF Pro / SF Mono，Windows 落 Segoe UI Variable + 微软雅黑 /
//   Cascadia + Consolas，不引入任何 webfont；
// - backdrop-filter / 圆角 / 投影 Chromium 两平台行为一致。

/** Apple 标准缓动（视图过渡同款），悬停/展开/收起统一用它。 */
export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/** 界面字体栈：跨平台系统字体（antd 组件默认栈已覆盖，只有显式设 font-family 时用它）。 */
export const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif"

/** 等宽数据字体（日志 / JSON / 路径）：SF Mono → Cascadia → Consolas → Menlo。 */
export const MONO = "'SF Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, ui-monospace, Menlo, monospace"

/** 文本三级层次（近白 → 次要 → 弱化），替代散落各处的 rgba 白。 */
export const INK = {
  1: 'rgba(255,255,255,0.93)',
  2: 'rgba(255,255,255,0.58)',
  3: 'rgba(255,255,255,0.36)',
}

/** 材料分层：bar 最深（顶栏/控制台）、panel 次之（侧栏/抽屉）、card 微白（卡片/输入组）。 */
export const MAT = {
  base: '#08080a',
  bar: 'rgba(16,16,19,0.72)',
  panel: 'rgba(22,22,26,0.66)',
  card: 'rgba(255,255,255,0.045)',
  cardHover: 'rgba(255,255,255,0.09)',
  line: 'rgba(255,255,255,0.075)',
  line2: 'rgba(255,255,255,0.14)',
  blur: 'blur(28px) saturate(170%)',
}

/** 全站延续的橘色强调（Apple 暗色 orange）。 */
export const ACCENT = '#ff9f0a'

/** 运行状态色（Apple 暗色 blue/green/red）。 */
export const STATUS = {
  running: '#0a84ff',
  success: '#30d158',
  failed: '#ff453a',
}

/** 悬浮抬升阴影：近处 1px 压边 + 远处大而软的弥散，两层叠加才有「浮起」感。 */
export const LIFT = '0 1px 2px rgba(0,0,0,0.5), 0 12px 32px rgba(0,0,0,0.4)'
export const LIFT_SOFT = '0 1px 2px rgba(0,0,0,0.4), 0 6px 20px rgba(0,0,0,0.32)'

/**
 * iOS 设置行式图标 chip：模块色着色的圆角方块（顶部亮渐变 + 内衬描边 + 顶部高光），
 * 模块面板 / 画布节点 / 项目卡片共用，是这版苹果化的视觉锚点。
 */
export function iconChip(color, size = 26, icon = 15) {
  return {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.31),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color,
    fontSize: icon,
    flexShrink: 0,
    background: `linear-gradient(180deg, ${color}30, ${color}14)`,
    boxShadow: `inset 0 0 0 1px ${color}38, inset 0 1px 0 rgba(255,255,255,0.09)`,
  }
}

/**
 * 爬虫页全局样式（index.jsx 注入一次，作用域限 .crawler-root）：
 * 细滚动条（overlay 风）、橘色文本选中、抗锯齿。
 */
export const GLOBAL_CSS = `
.crawler-root { -webkit-font-smoothing: antialiased }
.crawler-root ::selection { background: rgba(255,159,10,0.3) }
.crawler-root ::-webkit-scrollbar { width: 8px; height: 8px }
.crawler-root ::-webkit-scrollbar-track { background: transparent }
.crawler-root ::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.12); border-radius: 8px;
  border: 2px solid transparent; background-clip: padding-box;
}
.crawler-root ::-webkit-scrollbar-thumb:hover { background-color: rgba(255,255,255,0.22) }
.crawler-root ::-webkit-scrollbar-corner { background: transparent }
`
