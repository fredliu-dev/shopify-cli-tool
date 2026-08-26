// 爬虫项目列表视图：卡片网格（玻璃拟态），新建/导入/重命名/删除，点卡片进编辑器。
import React, { useEffect, useState } from 'react'
import { App, Button, Card, Col, Empty, Input, Modal, Popconfirm, Row, Space, Spin, Tag, Typography } from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  RightOutlined,
  UploadOutlined,
} from '@ant-design/icons'

const { Text, Title } = Typography

// 玻璃拟态（同 Repos.jsx 的 GLASS/HOVER_GLASS，页面独立一份避免跨页面 import）
const GLASS = {
  background: 'rgba(255,255,255,0.055)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.1)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}
const HOVER_GLASS = {
  background: 'rgba(255,255,255,0.1)',
  border: '1px solid rgba(255,255,255,0.24)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 8px 28px rgba(0,0,0,0.35)',
}

const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function ProjectList({ onOpen, onImported }) {
  const { message } = App.useApp()
  const [projects, setProjects] = useState(null) // null=加载中
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [renaming, setRenaming] = useState(null) // { id, name }
  const [renameValue, setRenameValue] = useState('')

  const refresh = async () => {
    const res = await window.api.crawler.ls()
    if (res.ok) setProjects(res.data)
    else {
      message.error(res.error || '项目列表加载失败')
      setProjects([])
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    const name = createName.trim() || '未命名爬虫'
    const res = await window.api.crawler.create(name)
    if (!res.ok) return message.error(res.error || '新建失败')
    setCreating(false)
    setCreateName('')
    onOpen(res.data.id)
  }

  const rename = async () => {
    const name = renameValue.trim()
    if (!name) return message.warning('项目名不能为空')
    const res = await window.api.crawler.rename({ id: renaming.id, name })
    if (!res.ok) return message.error(res.error || '重命名失败')
    setRenaming(null)
    refresh()
  }

  const remove = async (id) => {
    const res = await window.api.crawler.delete(id)
    if (!res.ok) return message.error(res.error || '删除失败')
    message.success('已删除')
    refresh()
  }

  const importGraph = async () => {
    const res = await window.api.crawler.importGraph()
    if (res.canceled) return
    if (!res.ok) return message.error(res.error || '导入失败')
    message.success(`已导入「${res.data.name}」`)
    onImported?.(res.data.id)
  }

  return (
    <div style={{ padding: '28px 36px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            爬虫工作流
          </Title>
          <Text type="secondary">拖拽模块搭建流程，后台自动执行并提取数据</Text>
        </div>
        <Space>
          <Button icon={<UploadOutlined />} onClick={importGraph}>
            导入画布
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建项目
          </Button>
        </Space>
      </div>

      {projects === null ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin />
        </div>
      ) : projects.length === 0 ? (
        <Empty
          style={{ marginTop: 80 }}
          description="还没有爬虫项目"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建第一个项目
          </Button>
        </Empty>
      ) : (
        <Row gutter={[16, 16]}>
          {projects.map((p) => (
            <Col key={p.id} xs={24} sm={12} md={8} lg={6}>
              <Card
                hoverable
                style={{ ...GLASS, transition: 'all 0.25s', cursor: 'pointer', borderRadius: 12 }}
                styles={{ body: { padding: 16 } }}
                onClick={() => onOpen(p.id)}
                onMouseEnter={(e) => Object.assign(e.currentTarget.style, HOVER_GLASS)}
                onMouseLeave={(e) => Object.assign(e.currentTarget.style, GLASS)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text strong ellipsis={{ tooltip: p.name }} style={{ fontSize: 15 }}>
                    {p.name}
                  </Text>
                  <Tag color="blue" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                    {p.nodeCount} 节点
                  </Tag>
                </div>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                  更新于 {fmtTime(p.updatedAt)}
                </Text>
                <div
                  style={{ display: 'flex', gap: 4, marginTop: 12, justifyContent: 'flex-end' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="small"
                    type="text"
                    icon={<RightOutlined />}
                    onClick={() => onOpen(p.id)}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setRenaming(p)
                      setRenameValue(p.name)
                    }}
                  />
                  <Popconfirm title="确定删除该项目？" onConfirm={() => remove(p.id)} okText="删除" cancelText="取消">
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal
        title="新建爬虫项目"
        open={creating}
        onOk={create}
        onCancel={() => setCreating(false)}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="项目名称，如：抓取商品列表"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onPressEnter={create}
          maxLength={50}
        />
      </Modal>

      <Modal
        title="重命名项目"
        open={!!renaming}
        onOk={rename}
        onCancel={() => setRenaming(null)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={rename}
          maxLength={50}
        />
      </Modal>
    </div>
  )
}
