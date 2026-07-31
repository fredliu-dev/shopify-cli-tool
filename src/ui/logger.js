import pc from 'picocolors'
import symbols from 'log-symbols'

// 统一的美化日志，每种级别带固定图标 + 颜色
export const log = {
  info: (msg) => console.log(symbols.info, pc.cyan(msg)),
  success: (msg) => console.log(symbols.success, pc.green(msg)),
  warn: (msg) => console.log(symbols.warning, pc.yellow(msg)),
  error: (msg) => console.log(symbols.error, pc.red(msg)),
  step: (msg) => console.log(pc.bold(pc.magenta('▸')), msg),
}
