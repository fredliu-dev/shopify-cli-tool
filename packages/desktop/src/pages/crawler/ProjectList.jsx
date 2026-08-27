// 爬虫项目列表视图：卡片网格（安静毛玻璃 + 悬停抬升），新建/导入/重命名/删除，
// 点卡片进编辑器。卡片左侧着色图标 chip（iOS 设置行风格）按项目 id 稳定取色。
import React, { useEffect, useState } from 'react'
import { App, Button, Col, Empty, Input, Modal, Popconfirm, Row, Space, Spin, Typography } from 'antd'
import {
  DeleteOutlined,
  DeploymentUnitOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  RightOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { EASE, INK, LIFT, MAT, iconChip } from './theme.js'

const { Text } = Typography

// 项目卡左侧 chip 的取色板（Apple 暗色系统色；按 id 哈希稳定取一个）
const CHIP_COLORS = ['#0a84ff', '#bf5af2', '#30d158', '#ff9f0a', '#64d2ff', '#ff375f', '#5e5ce6', '#63e6e2']
const chipColorOf = (id) => CHIP_COLORS[[...(id || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % CHIP_COLORS.length]

// 卡片悬停/按压：CSS 过渡（含 -2px 抬升 + 阴影弥散），比 JS 换行内样式顺滑
const CARD_CSS = `
.proj-card { transition: transform 0.28s ${EASE}, background 0.28s ${EASE}, border-color 0.28s ${EASE}, box-shadow 0.28s ${EASE}; }
.proj-card:hover { transform: translateY(-2px); background: rgba(255,255,255,0.075); border-color: rgba(255,255,255,0.2); box-shadow: ${LIFT}; }
.proj-card:active { transform: translateY(0); }
.proj-card .proj-actions { opacity: 0; transition: opacity 0.2s ${EASE}; }
.proj-card:hover .proj-actions { opacity: 1; }
`

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
    <div style={{ padding: '30px 38px', height: '100%', overflowY: 'auto' }}>
      <style>{CARD_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 26 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.4px', color: INK[1], lineHeight: 1.2 }}>
            爬虫工作流
          </div>
          <Text type="secondary" style={{ fontSize: 13, marginTop: 6, display: 'block' }}>
            拖拽模块搭建流程，后台自动执行并提取数据
          </Text>
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
              <div
                className="proj-card"
                style={{
                  borderRadius: 16,
                  padding: '16px 16px 12px',
                  background: MAT.card,
                  backdropFilter: MAT.blur,
                  WebkitBackdropFilter: MAT.blur,
                  border: `1px solid ${MAT.line}`,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                }}
                onClick={() => onOpen(p.id)}
                title="打开项目"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={iconChip(chipColorOf(p.id), 32, 17)}>
                    <DeploymentUnitOutlined />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      title={p.name}
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: INK[1],
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.name}
                    </div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      更新于 {fmtTime(p.updatedAt)}
                    </Text>
                  </div>
                </div>
                <div
                  className="proj-actions"
                  style={{ display: 'flex', gap: 2, marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: '18px',
                      padding: '0 8px',
                      borderRadius: 999,
                      color: '#6cb2ff',
                      background: 'rgba(10,132,255,0.13)',
                    }}
                  >
                    {p.nodeCount} 节点
                  </span>
                  <Space size={0}>
                    <Button size="small" type="text" icon={<RightOutlined />} onClick={() => onOpen(p.id)} title="打开" />
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setRenaming(p)
                        setRenameValue(p.name)
                      }}
                      title="重命名"
                    />
                    <Popconfirm title="确定删除该项目？" onConfirm={() => remove(p.id)} okText="删除" cancelText="取消">
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} title="删除" />
                    </Popconfirm>
                  </Space>
                </div>
              </div>
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
