import React, { useEffect, useState } from 'react'
import { Table, Typography, App } from 'antd'

const { Title, Text } = Typography

export default function Ls() {
  const { message } = App.useApp()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await window.api.shops.ls()
      if (cancelled) return
      if (res.ok) setRows(res.data)
      else message.error(`加载失败：${res.error}`)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [message])

  const link = (v) =>
    v ? (
      <a href={v} target="_blank" rel="noreferrer">
        {v}
      </a>
    ) : (
      '-'
    )

  const columns = [
    { title: '模板', dataIndex: 'templateName', width: 70 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: 'theme', dataIndex: 'theme', width: 110 },
    { title: 'port', dataIndex: 'port', width: 70 },
    { title: '开发链接', key: 'dev', width: 240, render: (_, r) => link(r.links?.devLink) },
    { title: '提测链接', key: 'preview', render: (_, r) => link(r.links?.previewLink) },
  ]

  return (
    <>
      <Title level={4}>项目列表</Title>
      <Table
        rowKey={(r) => r.id ?? r.templateName}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="middle"
      />
      <Text type="secondary">共 {rows.length} 个项目</Text>
    </>
  )
}
