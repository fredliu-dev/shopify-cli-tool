import React, { useEffect, useState } from 'react'
import { Table, Button, Typography, App, Popconfirm, Space } from 'antd'

const { Title } = Typography

export default function Del() {
  const { message } = App.useApp()
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const res = await window.api.shops.ls()
    setRows(res.ok ? res.data : [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const onDelete = async () => {
    const res = await window.api.shops.delete(selected)
    if (res.ok) {
      message.success(`已删除 ${res.deleted} 个项目`)
      setSelected([])
      load()
    } else {
      message.error(res.error)
    }
  }

  const columns = [
    { title: '模板', dataIndex: 'templateName', width: 80 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: 'theme', dataIndex: 'theme', width: 120 },
  ]

  return (
    <>
      <Title level={4}>删除项目</Title>
      <Space style={{ marginBottom: 12 }}>
        <Popconfirm
          title={`确认删除选中的 ${selected.length} 个项目？`}
          onConfirm={onDelete}
          okButtonProps={{ danger: true }}
        >
          <Button danger disabled={!selected.length}>
            删除选中（{selected.length}）
          </Button>
        </Popconfirm>
        <Button onClick={load}>刷新</Button>
      </Space>
      <Table
        rowKey={(r) => r.id}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="middle"
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys),
        }}
      />
    </>
  )
}
