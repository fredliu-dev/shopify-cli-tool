import React, { useState } from 'react'
import { Button, Typography, App, Card, Input, Space, Descriptions } from 'antd'

const { Title } = Typography

export default function Pre() {
  const { message } = App.useApp()
  const [dir, setDir] = useState('')
  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(false)

  const pick = async () => {
    const res = await window.api.dialog.pickDir()
    if (res.ok) setDir(res.dir)
  }

  const getLinks = async () => {
    if (!dir) {
      message.warning('请先选择项目目录')
      return
    }
    setLoading(true)
    const res = await window.api.links.get({ startDir: dir, envName: 'dev' })
    setLoading(false)
    if (res.ok) setLinks(res.data)
    else {
      message.error(res.error)
      setLinks(null)
    }
  }

  const L = ({ v }) =>
    v ? (
      <a href={v} target="_blank" rel="noreferrer">
        {v}
      </a>
    ) : (
      '-'
    )

  return (
    <>
      <Title level={4}>提测链接（shop pre）</Title>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Input
            value={dir}
            placeholder="项目目录（含 shopify.theme.toml）"
            style={{ width: 480 }}
            readOnly
          />
          <Button onClick={pick}>选择目录</Button>
          <Button type="primary" loading={loading} onClick={getLinks}>
            获取链接
          </Button>
        </Space>
        {links && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="开发链接">
              <L v={links.devLink} />
            </Descriptions.Item>
            <Descriptions.Item label="提测链接">
              <L v={links.previewLink} />
            </Descriptions.Item>
            <Descriptions.Item label="主题后台">
              <L v={links.adminLink} />
            </Descriptions.Item>
            <Descriptions.Item label="主题编辑">
              <L v={links.editorLink} />
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>
    </>
  )
}
