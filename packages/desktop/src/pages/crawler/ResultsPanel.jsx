// 结果面板：提取数据的动态列表格（所有行字段名并集）+ 导出 JSON/CSV（CSV 手拼 + BOM 防 Excel 中文乱码）。
import React, { useMemo } from 'react'
import { App, Button, Empty, Space, Table, Tag } from 'antd'
import { DownloadOutlined, FileTextOutlined } from '@ant-design/icons'

const csvEscape = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function ResultsPanel({ rows, columns: columnsProp, emptyText }) {
  const { message } = App.useApp()

  // 列优先用外部给定顺序（表格模块的 columns），否则按行字段出现顺序取并集
  const columns = useMemo(() => {
    const names = []
    if (columnsProp?.length) {
      names.push(...columnsProp)
      for (const r of rows) {
        for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k)
      }
    } else {
      for (const r of rows) {
        for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k)
      }
    }
    return names.map((name, i) => ({
      title: name,
      dataIndex: name,
      key: name,
      ellipsis: true,
      render: (v) => <span style={{ fontSize: 12 }}>{v === null || v === undefined ? '-' : v}</span>,
      // 第一列稍窄给后面的链接类字段留空间
      width: i === 0 ? 200 : undefined,
    }))
  }, [rows, columnsProp])

  const doExport = async (format) => {
    if (!rows.length) return message.warning('暂无数据可导出')
    let content
    let defaultName
    if (format === 'json') {
      content = JSON.stringify(rows, null, 2)
      defaultName = 'crawler-results.json'
    } else {
      const names = columns.map((c) => c.title)
      const lines = [names.map(csvEscape).join(','), ...rows.map((r) => names.map((n) => csvEscape(r[n])).join(','))]
      // ﻿ BOM：Excel 无 BOM 会按 ANSI 解析，中文列名/内容乱码
      content = `﻿${lines.join('\r\n')}`
      defaultName = 'crawler-results.csv'
    }
    const res = await window.api.crawler.saveResults({ defaultName, content })
    if (res.canceled) return
    if (res.ok) message.success(`已导出：${res.path}`)
    else message.error(res.error || '导出失败')
  }

  if (!rows.length) {
    return <Empty style={{ marginTop: 30 }} description={emptyText || '运行后提取的数据会显示在这里'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <div style={{ padding: '8px 4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Tag color="green">{rows.length} 行</Tag>
        <Space>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => doExport('json')}>
            导出 JSON
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport('csv')}>
            导出 CSV
          </Button>
        </Space>
      </div>
      <Table
        size="small"
        rowKey={(_, i) => i}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 50, size: 'small', showSizeChanger: false }}
        scroll={{ x: 'max-content', y: 'calc(100% - 60px)' }}
        sticky
      />
    </div>
  )
}
