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

// 左侧栏导航（毛玻璃质感）：图标按钮圆角方块，悬停浮起 + 浅底、选中主色底 +
// 内描边；激活项由一条带光晕的指示条贴着侧栏左缘滑动（transform 过渡）
const NAV_STYLE = `
.shell-nav-btn { border: none; background: transparent; padding: 0; cursor: pointer;
  appearance: none; -webkit-appearance: none; outline: none;
  width: 52px; height: 52px; border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 23px; color: rgba(255,255,255,0.52);
  transition: color .2s, background .2s, box-shadow .2s, transform .2s; }
.shell-nav-btn:hover, .shell-nav-btn:focus, .shell-nav-btn:active,
.shell-nav-btn:focus-visible { box-shadow: none; }
.shell-nav-btn:hover { color: rgba(255,255,255,0.92); background: rgba(255,255,255,0.06); transform: translateY(-1px); }
.shell-nav-btn:focus-visible { color: rgba(255,255,255,0.92); }
.shell-nav-btn:active { transform: scale(0.95); }
.shell-nav-btn.is-active { color: #ffa940; background: rgba(250,140,22,0.14); box-shadow: inset 0 0 0 1px rgba(250,140,22,0.30); }
.shell-avatar { transition: transform .2s, filter .2s; }
.shell-avatar:hover { transform: scale(1.07); filter: brightness(1.15); }
`

// 彩色光晕：毛玻璃卡片 blur 后透出的色彩来源（iOS 控制中心式背景），铺满主窗口整窗
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
  // 激活页索引：驱动侧栏左缘滑动指示条的位移
  const NAV_IDX = Math.max(0, PAGES.findIndex((p) => p.key === page))

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
    <div
      style={{
        display: 'flex',
        height: '100vh',
        // 光晕背景铺满整窗（含左侧栏）：侧栏透明，整条能与内容区融为一体；
        // 工单/爬虫页自身不铺底，光晕从页面透出。
        // 不能加 background-attachment: fixed：壳层本就不滚动，fixed 无意义，反而触发
        // Chromium 渲染 bug——backdrop-filter 毛玻璃元素（爬虫节点等）周围会重采样出
        // 一圈光晕矩形框（画布透明后尤其明显）
        background: '#0d0d0f',
        backgroundImage: GLOW_BACKGROUND,
      }}
    >
      <style>{NAV_STYLE}</style>
      <aside
        style={{
          width: 64,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '14px 0 12px',
          background: 'transparent',
          borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* 左上角用户头像：点击展开「更多」菜单（管理类弹窗 + 下载最新版本）。
            彩色渐变占位图（无图标），悬停放大提亮 */}
        <Dropdown
          placement="bottomLeft"
          trigger={['click']}
          menu={{ items: menuItems, onClick: ({ key }) => menuApi?.run?.(key) }}
        >
          <Tooltip title="更多操作" placement="right">
            <Avatar
              size={36}
              className="shell-avatar"
              style={{
                cursor: 'pointer',
                background: 'linear-gradient(135deg, #1677ff 0%, #722ed1 48%, #fa8c16 100%)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22), 0 2px 8px rgba(0,0,0,0.35)',
              }}
            />
          </Tooltip>
        </Dropdown>
        <span style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.10)', marginTop: 12 }} />

        {/* 页面导航：垂直居中占满剩余空间；指示条贴侧栏左缘，随激活项平滑滑动 */}
        <nav
          style={{
            flex: 1,
            position: 'relative',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: '50%',
              width: 3,
              height: 20,
              borderRadius: '0 3px 3px 0',
              background: 'linear-gradient(180deg, #ffb84d, #fa8c16)',
              boxShadow: '0 0 8px rgba(250,140,22,0.55)',
              // 按钮高 52 + 间距 10 → 步长 62；自身 -50% 居中后再按激活索引平移
              transform: `translateY(calc(-50% + ${(NAV_IDX - 1) * 62}px))`,
              transition: 'transform .3s cubic-bezier(.4,0,.2,1)',
            }}
          />
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
        </nav>

        {/* 底部版本号：低调展示，悬停 Tooltip 看完整信息 */}
        <Tooltip title={`Shopify 工具箱 v${version}`} placement="right">
          <span
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.28)',
              letterSpacing: 0.5,
              userSelect: 'none',
              cursor: 'default',
            }}
          >
            v{version}
          </span>
        </Tooltip>
      </aside>

      {/* 内容区：光晕背景已铺满整窗（本地项目页整页滚动）；TAPD / 爬虫页高度撑满、内部自管滚动 */}
      <main style={{ flex: 1, minWidth: 0, height: '100vh' }}>
        <div
          style={{
            height: '100%',
            overflowY: 'auto',
            padding: 20,
            display: page === 'repos' ? 'block' : 'none',
          }}
        >
          <Repos registerMenu={setMenuApi} />
        </div>
        {visited.tapd && (
          <div style={{ height: '100%', display: page === 'tapd' ? 'block' : 'none' }}>
            {/* active 驱动 TAPD 页的实时同步启停（切走即暂停轮询） */}
            <TapdPage active={page === 'tapd'} />
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
