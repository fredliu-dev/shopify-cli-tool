import React, { useEffect, useState } from 'react'
import { Select, Form, Input, Button, Typography, App, Card, Space } from 'antd'

const { Title } = Typography

export default function Edit() {
  const { message } = App.useApp()
  const [rows, setRows] = useState([])
  const [id, setId] = useState(null)
  const [form] = Form.useForm()

  useEffect(() => {
    ;(async () => {
      const res = await window.api.shops.ls()
      setRows(res.ok ? res.data : [])
    })()
  }, [])

  const onPick = (pid) => {
    setId(pid)
    const p = rows.find((r) => r.id === pid)
    if (p) {
      form.setFieldsValue({
        theme: p.theme,
        previewKey: p.previewKey,
        port: String(p.port ?? ''),
        description: p.description ?? '',
      })
    }
  }

  const onSave = async (vals) => {
    const res = await window.api.shops.update(id, {
      theme: vals.theme?.trim(),
      previewKey: vals.previewKey?.trim(),
      port: vals.port?.trim(),
      description: vals.description?.trim(),
    })
    if (res.ok) {
      message.success('已更新')
      const ls = await window.api.shops.ls()
      setRows(ls.ok ? ls.data : [])
    } else {
      message.error(res.error)
    }
  }

  return (
    <>
      <Title level={4}>编辑项目</Title>
      <Card>
        <Select
          placeholder="选择要编辑的项目"
          style={{ width: 420, marginBottom: 16 }}
          value={id}
          onChange={onPick}
          options={rows.map((p) => ({
            value: p.id,
            label: `${p.templateName ?? p.store ?? '?'} - ${p.description || '无描述'}`,
          }))}
        />
        {id && (
          <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 480 }}>
            <Form.Item name="theme" label="theme">
              <Input />
            </Form.Item>
            <Form.Item name="previewKey" label="preview_key">
              <Input />
            </Form.Item>
            <Form.Item name="port" label="port" rules={[{ pattern: /^\d+$/, message: '需为数字' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
          </Form>
        )}
      </Card>
    </>
  )
}
