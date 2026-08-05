import React, { useState } from 'react'
import { Layout, Menu } from 'antd'
import Ls from './pages/Ls.jsx'
import Del from './pages/Del.jsx'
import Edit from './pages/Edit.jsx'
import Pre from './pages/Pre.jsx'
import Init from './pages/Init.jsx'

const { Sider, Content } = Layout

const items = [
  { key: 'ls', label: '项目列表' },
  { key: 'del', label: '删除项目' },
  { key: 'edit', label: '编辑项目' },
  { key: 'pre', label: '提测链接' },
  { key: 'init', label: '初始化配置' },
]

const pages = { ls: Ls, del: Del, edit: Edit, pre: Pre, init: Init }

export default function App() {
  const [page, setPage] = useState('ls')
  const Page = pages[page]

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider width={200} theme="light">
        <div
          style={{
            height: 48,
            margin: 12,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#1677ff',
          }}
        >
          Shopify 工具箱
        </div>
        <Menu mode="inline" selectedKeys={[page]} onClick={(e) => setPage(e.key)} items={items} />
      </Sider>
      <Layout>
        <Content style={{ padding: 24, overflow: 'auto', background: '#f5f5f5' }}>
          <Page />
        </Content>
      </Layout>
    </Layout>
  )
}
