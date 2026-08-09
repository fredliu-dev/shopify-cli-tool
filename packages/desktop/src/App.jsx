import React from 'react'
import { ConfigProvider, Layout, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { version } from '../package.json'
import Repos from './pages/Repos.jsx'

// 窗口标题带版本号：读 desktop package.json，每次发版改 version 即自动跟上
// （Electron 原生标题由 main.js 用 app.getVersion() 设置；这里同步页面 <title>，避免页面加载后覆盖回去）
document.title = `Shopify 工具箱 v${version}`

const { Content } = Layout

// 全局暗色主题：darkAlgorithm 让所有 antd 组件自动切暗色；
// 默认按钮在暗色下用「半透明橘色填充 + 浅橘文字/图标」，悬停/按下加深，扁平无阴影。
// danger 走独立 colorError 分支（红色删除按钮不受 default* 影响），primary 蓝色不变。
const theme = {
  algorithm: antdTheme.darkAlgorithm,
  components: {
    Button: {
      defaultBg: 'rgba(250, 140, 22, 0.16)',
      defaultColor: '#ffa940',
      defaultBorderColor: 'transparent',
      defaultHoverBg: 'rgba(250, 140, 22, 0.26)',
      defaultHoverColor: '#ffb84d',
      defaultHoverBorderColor: 'transparent',
      defaultActiveBg: 'rgba(250, 140, 22, 0.34)',
      defaultActiveColor: '#ffc068',
      defaultActiveBorderColor: 'transparent',
      defaultShadow: 'none',
      primaryShadow: 'none',
      fontWeight: 500,
    },
  },
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={theme}>
      <Layout style={{ height: '100vh' }}>
        <Content
          style={{
            padding: 20,
            overflow: 'auto',
            background: '#0d0d0f',
            // 彩色光晕：毛玻璃卡片 blur 后透出的色彩来源（iOS 控制中心式背景）
            backgroundImage:
              'radial-gradient(circle at 12% 18%, rgba(22,119,255,0.14), transparent 38%), radial-gradient(circle at 88% 12%, rgba(114,46,241,0.12), transparent 36%), radial-gradient(circle at 78% 88%, rgba(19,194,194,0.10), transparent 40%)',
            backgroundAttachment: 'fixed',
          }}
        >
          <Repos />
        </Content>
      </Layout>
    </ConfigProvider>
  )
}
