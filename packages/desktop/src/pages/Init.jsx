import React, { useEffect, useState } from 'react'
import { Button, Typography, App, Card, Input, Space, Select, Form, Alert } from 'antd'
import WorkItemSelect from '../components/WorkItemSelect.jsx'

const { Title, Text } = Typography

export default function Init() {
  const { message } = App.useApp()
  const [dir, setDir] = useState('')
  const [templates, setTemplates] = useState([])
  const [status, setStatus] = useState(null) // { exists, hasDevDomain }
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      const res = await window.api.config.templates()
      setTemplates(res || [])
    })()
  }, [])

  const pick = async () => {
    const res = await window.api.dialog.pickDir()
    if (!res.ok) return
    setDir(res.dir)
    setStatus(await window.api.config.initStatus(res.dir))
  }

  const submit = async (vals) => {
    if (!dir) {
      message.warning('请先选择目录')
      return
    }
    setLoading(true)
    // 工单选择器的值：title 写 project_desc，url 写 dev 环境 _tapd（本地保存时回显并带入 projects.json）
    const item = vals.workItem || null
    const res = status?.exists
      ? await window.api.config.initMerge({ dir, templateName: vals.template })
      : await window.api.config.initCreate({
          dir,
          templateName: vals.template,
          theme: vals.theme,
          port: vals.port,
          previewKey: vals.previewKey,
          previewPath: vals.previewPath,
          projectDesc: item?.title || '',
          tapd: item?.url || '',
        })
    setLoading(false)
    if (res.ok) {
      message.success(status?.exists ? '已合并 dev 环境到现有配置' : '已创建 shopify.theme.toml')
      setStatus(await window.api.config.initStatus(dir))
    } else {
      message.error(res.error)
    }
  }

  const done = status?.exists && status?.hasDevDomain

  return (
    <>
      <Title level={4}>初始化配置（shop init）</Title>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Input value={dir} placeholder="项目目录" style={{ width: 480 }} readOnly />
          <Button onClick={pick}>选择目录</Button>
        </Space>
        {done && (
          <Alert
            type="success"
            message="该目录已初始化完毕（shopify.theme.toml 已含 [environments.dev].domain）"
            style={{ marginBottom: 16 }}
          />
        )}
        {dir && !done && (
          <Form
            form={form}
            layout="vertical"
            onFinish={submit}
            initialValues={{ port: '9292' }}
            style={{ maxWidth: 480 }}
          >
            <Form.Item name="template" label="模板" rules={[{ required: true, message: '请选择模板' }]}>
              <Select options={templates.map((t) => ({ value: t.name, label: t.name }))} placeholder="选择模板" />
            </Form.Item>
            {!status?.exists && (
              <>
                <Form.Item name="theme" label="theme">
                  <Input />
                </Form.Item>
                <Form.Item name="port" label="port" rules={[{ pattern: /^\d+$/, message: '需为数字' }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="previewKey" label="preview_key（新页面需填）">
                  <Input />
                </Form.Item>
                <Form.Item name="previewPath" label="网页路径（选填）" extra="如 /pages/back-to-school-sale；无 preview_key 时拼到预览/开发链接，编辑器链接挂 previewPath 参数">
                  <Input placeholder="/pages/xxx" />
                </Form.Item>
                <Form.Item name="workItem" label="工单（选填，标题作为 project_desc）">
                  <WorkItemSelect />
                </Form.Item>
              </>
            )}
            <Button type="primary" htmlType="submit" loading={loading}>
              {status?.exists ? '合并 dev 环境' : '创建配置'}
            </Button>
          </Form>
        )}
        {!dir && <Text type="secondary">先选择要初始化的项目目录</Text>}
      </Card>
    </>
  )
}
