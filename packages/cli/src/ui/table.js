import Table from 'cli-table3'
import pc from 'picocolors'

/**
 * 渲染「命令 | 说明」表格。
 * @param {Array<[string, string]>} rows [命令, 说明] 二元组数组
 * @returns {string} 表格字符串
 */
export function commandTable(rows) {
  const table = new Table({
    head: ['命令', '说明'],
    style: { head: ['cyan'] },
  })
  rows.forEach(([cmd, desc]) => table.push([pc.green(cmd), desc]))
  return table.toString()
}
