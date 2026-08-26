import { useEffect, useState } from 'react'
import { Avatar, ConfigProvider, Dropdown, Tooltip, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  AppstoreOutlined,
  DeploymentUnitOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  ProjectOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { version } from '../package.json'
import Repos from './pages/Repos.jsx'
import DepGraphPage from './pages/DepGraph.jsx'
import TapdPage from './pages/Tapd.jsx'
import CrawlerPage from './pages/crawler/index.jsx'

// 引用图仍为独立窗口（#/dep-graph?dir=...&name=...）：按 hash 分流渲染，不带主框架；
// TAPD 工单 / 爬虫工作流已改为主窗口内左侧栏切换，不再各开独立窗口。
const isDepGraphRoute = () => window.location.hash.startsWith('#/dep-graph')

// 窗口标题带版本号：读 desktop package.json，每次发版改 version 即自动跟上
// （Electron 原生标题由 main.js 用 app.getVersion() 设置；这里同步页面 <title>，避免页面加载后覆盖回去）。
// 引用图窗口的标题是仓库名，由该页面的 effect 设置，不在此覆盖。
if (!isDepGraphRoute()) {
  document.title = `Shopify 工具箱 v${version}`
}

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

// 左侧窄栏的三个主页面：同窗口切换（原 TAPD / 爬虫独立窗口已并入）
const PAGES = [
  { key: 'repos', icon: <FolderOpenOutlined />, label: '本地项目' },
  { key: 'tapd', icon: <ProjectOutlined />, label: 'TAPD 工单' },
  { key: 'crawler', icon: <DeploymentUnitOutlined />, label: '爬虫工作流' },
]

// 左侧栏导航 tab（按参考图）：纯图标、无背景色块，选中仅变主色、悬停提亮；
// 原生 button + appearance 重置 + 各状态强制透明背景，彻底压掉 UA/残留样式
const NAV_STYLE = `
.shell-nav-btn { border: none; background: transparent; padding: 0; cursor: pointer;
  appearance: none; -webkit-appearance: none; outline: none;
  width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
  font-size: 22px; color: rgba(255,255,255,0.5); transition: color 0.2s; }
.shell-nav-btn:hover, .shell-nav-btn:focus, .shell-nav-btn:active,
.shell-nav-btn:focus-visible { background: transparent; box-shadow: none; }
.shell-nav-btn:hover { color: rgba(255,255,255,0.85); }
.shell-nav-btn:focus-visible { color: rgba(255,255,255,0.85); }
.shell-nav-btn.is-active { color: #ffa940; }
`

// 彩色光晕：毛玻璃卡片 blur 后透出的色彩来源（iOS 控制中心式背景），本地项目页沿用
const GLOW_BACKGROUND =
  'radial-gradient(circle at 12% 18%, rgba(22,119,255,0.14), transparent 38%), radial-gradient(circle at 88% 12%, rgba(114,46,241,0.12), transparent 36%), radial-gradient(circle at 78% 88%, rgba(19,194,194,0.10), transparent 40%)'

// 主窗口壳：左侧窄栏（头像「更多」菜单 + 页面切换）+ 右侧内容区。
// 页面惰性挂载（首次切到才渲染，TAPD/爬虫挂载即拉数据），之后常驻只切显隐——
// 切走再切回不丢状态（筛选/滚动位置/画布）；本地项目页始终挂载（头像菜单动作注册在它内部）。
function MainShell() {
  const [page, setPage] = useState('repos')
  const [visited, setVisited] = useState({ repos: true })
  // 头像「更多」菜单的动作（弹窗等）都活在本地项目页里，页面挂载时注册 { run(key), editorLabel }
  const [menuApi, setMenuApi] = useState(null)

  const switchTo = (key) => {
    setPage(key)
    setVisited((v) => (v[key] ? v : { ...v, [key]: true }))
  }

  // 弹窗/抽屉深处的入口（如「去配置 TAPD」）经 window 事件请求切页（见 shell-events.js）
  useEffect(() => {
    const onSwitch = (e) => switchTo(e.detail)
    window.addEventListener('shell:switch-page', onSwitch)
    return () => window.removeEventListener('shell:switch-page', onSwitch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 原顶栏「更多」下拉 + 「下载最新版」按钮，统一收进左上角头像菜单
  const menuItems = [
    { key: 'manageTemplates', icon: <AppstoreOutlined />, label: '模板管理' },
    { key: 'contacts', icon: <TeamOutlined />, label: '人员管理' },
    { key: 'groups', icon: <MessageOutlined />, label: '通知群管理' },
    { key: 'dingtalkTemplates', icon: <FileTextOutlined />, label: '信息模板管理' },
    { type: 'divider' },
    { key: 'localConfig', icon: <FolderOpenOutlined />, label: '本地配置' },
    { key: 'exportConfig', icon: <DownloadOutlined />, label: '导出配置' },
    { type: 'divider' },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: menuApi?.editorLabel ? `默认编辑器：${menuApi.editorLabel}` : '设置默认编辑器',
    },
    { key: 'about', icon: <InfoCircleOutlined />, label: '关于' },
    { type: 'divider' },
    { key: 'releases', icon: <DownloadOutlined />, label: '下载最新版本' },
  ]

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0f' }}>
      <style>{NAV_STYLE}</style>
      <aside
        style={{
          width: 64,
          flexShrink: 0,
          position: 'relative',
          borderRight: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {/* 左上角用户头像：点击展开「更多」菜单（管理类弹窗 + 下载最新版本）。
            无彩色底（中性灰），整条侧栏不出现任何背景色 */}
        <div style={{ position: 'absolute', top: 12, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <Dropdown
            placement="bottomLeft"
            trigger={['click']}
            menu={{ items: menuItems, onClick: ({ key }) => menuApi?.run?.(key) }}
          >
            <Tooltip title="更多操作" placement="right">
              <Avatar
                size={34}
                icon={<UserOutlined style={{ fontSize: 17 }} />}
                style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.08)' }}
              />
            </Tooltip>
          </Dropdown>
        </div>
        <div
          style={{
            position: 'absolute',
            top: 54,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 26,
            height: 1,
            background: 'rgba(255,255,255,0.12)',
          }}
        />
        {/* 三个页面 tab：相对整条侧栏（非头像以下剩余空间）绝对定位垂直居中 */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {PAGES.map((p) => (
            <Tooltip key={p.key} title={p.label} placement="right">
              <button
                type="button"
                className={`shell-nav-btn${page === p.key ? ' is-active' : ''}`}
                onClick={() => switchTo(p.key)}
              >
                {p.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      </aside>

      {/* 内容区：本地项目页整页滚动 + 光晕背景；TAPD / 爬虫页高度撑满、内部自管滚动 */}
      <main style={{ flex: 1, minWidth: 0, height: '100vh' }}>
        <div
          style={{
            height: '100%',
            overflowY: 'auto',
            padding: 20,
            display: page === 'repos' ? 'block' : 'none',
            backgroundImage: GLOW_BACKGROUND,
            backgroundAttachment: 'fixed',
          }}
        >
          <Repos registerMenu={setMenuApi} />
        </div>
        {visited.tapd && (
          <div style={{ height: '100%', display: page === 'tapd' ? 'block' : 'none' }}>
            <TapdPage />
          </div>
        )}
        {visited.crawler && (
          <div style={{ height: '100%', display: page === 'crawler' ? 'block' : 'none' }}>
            <CrawlerPage />
          </div>
        )}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={theme}>
      {isDepGraphRoute() ? <DepGraphPage /> : <MainShell />}
    </ConfigProvider>
  )
}
