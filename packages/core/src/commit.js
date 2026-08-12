/**
 * Commit 类型与标题拼接。
 *
 * 供 CLI `shop cmt` 与桌面端「提交 Pull Request」共用，保证两边类型清单与「[类型]: 描述」格式一致。
 */

// Commit 类型标准：[类型]: 简要描述
export const COMMIT_TYPES = [
  { value: 'feat', desc: '新功能开发' },
  { value: 'fix', desc: '缺陷修复' },
  { value: 'refactor', desc: '代码重构（不影响功能）' },
  { value: 'style', desc: '样式或前端视觉修改' },
  { value: 'perf', desc: '性能优化' },
  { value: 'merge', desc: '分支合并' },
]

/**
 * 按「[类型]: 描述」拼接 commit/PR 标题（描述自动 trim）。
 * @param {string} type COMMIT_TYPES 中的 value
 * @param {string} message 标题描述
 * @returns {string} 如 `feat: 新增秒杀模块`
 */
export const formatCommitTitle = (type, message) => `${type}: ${String(message ?? '').trim()}`
