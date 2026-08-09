import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import App from './App.jsx'

// 外层就上 darkAlgorithm：AntdApp 提供的静态 modal/message（如提测默认值询问）才会跟 UI 一致为暗色，
// 否则它们走外层默认亮色。App.jsx 内层 ConfigProvider 再叠加 Button 等组件级定制（只作用于 UI 按钮）。
createRoot(document.getElementById('root')).render(
  <ConfigProvider locale={zhCN} theme={{ algorithm: antdTheme.darkAlgorithm }}>
    <AntdApp>
      <App />
    </AntdApp>
  </ConfigProvider>,
)
