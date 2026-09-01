// 公共资源库管理弹窗：跨项目共享的「元素选择器」与「网址」两类条目。
// 这里只维护名字 + 值（元素带匹配模式），保存到 userDataDir/crawler-common.json；
// 模块配置抽屉里的下拉选中即把值拷进节点（运行时与手填一致，runner 无感知）。
import React, { useEffect, useState } from 'react'
import { App, Button, Empty, Input, Modal, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { SELECTOR_MODES } from './constants.js'
import { INK, MAT } from './theme.js'

const { Text } = Typography

const CARD = {
  padding: 12,
  borderRadius: 12,
  background: MAT.card,
  border: `1px solid ${MAT.line}`,
  marginBottom: 12,
}

const ROW = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }

/** 单条元素：名称 + 匹配模式 + 值。 */
function ElementRow({ item, patch, onRemove }) {
  return (
    <div style={{ ...CARD, marginBottom: 8 }}>
      <div style={ROW}>
        <Tag color="blue" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
          元素
        </Tag>
        <Input
          size="small"
          placeholder="名称，如 翻页按钮"
          value={item.name}
          maxLength={50}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <Popconfirm title="删除该条目？" onConfirm={onRemove} okText="删除" cancelText="取消">
          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>
      <Radio.Group
        size="small"
        optionType="button"
        buttonStyle="solid"
        options={SELECTOR_MODES}
        value={item.mode}
        onChange={(e) => patch({ mode: e.target.value })}
        style={{ marginBottom: 8 }}
      />
      <Input
        size="small"
        placeholder="选择器值，如 next-pagination-next"
        value={item.value}
        maxLength={500}
        onChange={(e) => patch({ value: e.target.value })}
      />
    </div>
  )
}

/** 单条网址：名称 + URL。 */
function UrlRow({ item, patch, onRemove }) {
  return (
    <div style={{ ...CARD, marginBottom: 8 }}>
      <div style={ROW}>
        <Tag color="geekblue" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
          网址
        </Tag>
        <Input
          size="small"
          placeholder="名称，如 博客列表页"
          value={item.name}
          maxLength={50}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <Popconfirm title="删除该条目？" onConfirm={onRemove} okText="删除" cancelText="取消">
          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>
      <Input
        size="small"
        placeholder="https://example.com/list"
        value={item.value}
        maxLength={500}
        onChange={(e) => patch({ value: e.target.value })}
      />
    </div>
  )
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {{elements: Array, urls: Array}} props.lib 当前库（打开时快照进本地编辑态）
 * @param {(lib: {elements: Array, urls: Array}) => void} props.onSaved 保存成功后回传新库（Editor 更新状态供各抽屉下拉用）
 */
export default function CommonLibModal({ open, lib, onClose, onSaved }) {
  const { message } = App.useApp()
  const [elements, setElements] = useState([])
  const [urls, setUrls] = useState([])
  const [saving, setSaving] = useState(false)

  // 每次打开从外部库重新快照（关闭期间别处不会改，但保持简单的一致性来源）
  useEffect(() => {
    if (open) {
      setElements((lib?.elements || []).map((e) => ({ ...e })))
      setUrls((lib?.urls || []).map((u) => ({ ...u })))
    }
  }, [open, lib])

  const save = async () => {
    setSaving(true)
    const res = await window.api.crawler.saveCommon({ elements, urls })
    setSaving(false)
    if (!res.ok) return message.error(res.error || '保存失败')
    onSaved(res.data)
    message.success('公共资源已保存')
    onClose()
  }

  const empty = elements.length === 0 && urls.length === 0

  return (
    <Modal
      title={<span style={{ fontWeight: 600, color: INK[1] }}>公共资源</span>}
      open={open}
      onOk={save}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      width={560}
      destroyOnHidden
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12, lineHeight: 1.7 }}>
        跨项目共享的元素与网址：保存后，「等待/点击/输入/提取」等模块的选择器、「打开网页」的网址下拉里都能直接选用。
      </Text>

      {empty && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">还没有公共资源，下面添加第一条</Text>}
          style={{ margin: '8px 0 16px' }}
        />
      )}

      {elements.map((item, i) => (
        <ElementRow
          key={item.id}
          item={item}
          patch={(f) => setElements((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...f } : x)))}
          onRemove={() => setElements((arr) => arr.filter((_, idx) => idx !== i))}
        />
      ))}
      {urls.map((item, i) => (
        <UrlRow
          key={item.id}
          item={item}
          patch={(f) => setUrls((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...f } : x)))}
          onRemove={() => setUrls((arr) => arr.filter((_, idx) => idx !== i))}
        />
      ))}

      <Space size={8} style={{ marginTop: 4 }}>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setElements((arr) => [...arr, { id: crypto.randomUUID(), name: '', mode: 'class', value: '' }])}
        >
          添加元素
        </Button>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setUrls((arr) => [...arr, { id: crypto.randomUUID(), name: '', value: '' }])}
        >
          添加网址
        </Button>
      </Space>
    </Modal>
  )
}
