/**
 * TAPD 工单页（需求/缺陷/任务列表 + 详情 + 手动流转）。
 *
 * 内嵌在主窗口左侧栏切换（App.jsx MainShell），不再是独立窗口。
 * 布局：顶栏（项目名 + 当前账号 + 刷新）→ 统计卡片（全部/待办/进行中/已完成，点击筛选）
 *   → Tab + 过滤行（只看我的/状态/迭代/关键字）→ 工单表格（名称/状态/处理人/规模点/截止时间；类型列缀优先级圆点徽标；点状态 Tag 流转、点行开详情）。
 * 点表格行打开详情抽屉（关键字段 + 流转路径轨道 + 描述富文本 + 评论历史，可直接回评论）；
 * 「流转」弹窗仿 TAPD 网页端：状态按钮组 + 处理人选择（项目成员候选）+ 评论。
 * 数据走 tapd:list（默认读缓存秒开，「只看我的」走服务端 owner 过滤）；
 * 状态映射/流转细则/终态集合/成员列表走各自 IPC（有缓存）。
 * 凭据为个人访问令牌（TAPD「个人设置 → 个人访问令牌」创建，Bearer 认证）：缺失时 core 抛
 * NO_TAPD_AUTH，页面显示凭据表单而非报错；保存后自动校验并重试加载。
 */
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckOutlined,
  CommentOutlined,
  CopyOutlined,
  EditOutlined,
  ExportOutlined,
  LeftOutlined,
  MessageOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  ShareAltOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import * as echarts from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { GraphicComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// echarts 按需注册：只用饼图 + 图例/提示/自定义文本 + canvas 渲染（同 DepGraph 的按需模式）
echarts.use([PieChart, LegendComponent, TooltipComponent, GraphicComponent, CanvasRenderer])

const { Text } = Typography

// 三类工单（key 与 core WORK_ITEM_META 对应；三类合并展示在同一张表，靠 _type 标记区分）
const TYPES = [
  { key: 'story', label: '需求' },
  { key: 'bug', label: '缺陷' },
  { key: 'task', label: '任务' },
]

// 快速筛选项（统计卡片）：key 对应 bucketOf 的分类
const BUCKETS = [
  { key: 'all', label: '全部', color: '#dcdcdc' },
  { key: 'todo', label: '待办', color: '#faad14' },
  { key: 'doing', label: '进行中', color: '#1677ff' },
  { key: 'done', label: '已完成', color: '#52c41a' },
]

// 状态专属色（每个状态一种颜色，流转链/Tag/时间线统一使用）。
// key 为 TAPD 状态英文值，覆盖本项目 story/bug/task 工作流的全部状态
const STATUS_COLOR = {
  planning: '#faad14', // 规划中
  developing: '#1677ff', // 实现中
  status_3: '#fa8c16', // 修改中
  status_4: '#722ed1', // 待测试
  status_5: '#2f54eb', // 测试中
  status_2: '#13c2c2', // 待反馈
  resolved: '#52c41a', // 已实现
  status_6: '#95de64', // 已通过
  rejected: '#ff4d4f', // 已拒绝
  workflow_suspended: '#8c8c8c', // 流程挂起
  workflow_end: '#595959', // 流程终止
  // task 三态 / bug 常见状态兜底
  open: '#faad14',
  progressing: '#1677ff',
  done: '#52c41a',
  new: '#faad14',
  in_progress: '#1677ff',
  verified: '#95de64',
  closed: '#52c41a',
}

// 流转链只展示主线流程：规划中→实现中→待测试→测试中→已通过（本项目实际链路，
// 旁路状态如 修改中/待反馈/已实现/已拒绝 不进链）；task 为固定三态。
// story/bug 的自定义状态英文值随项目配置变化，中文名稳定，故按中文名从 statusMap 反查
const MAIN_FLOW_CN = ['规划中', '实现中', '待测试', '测试中', '已通过']
const TASK_MAIN_FLOW = ['open', 'progressing', 'done']

// 状态取色：专属色优先，未收录的状态按中英文关键词兜底
function colorOf(status, cn = '') {
  if (STATUS_COLOR[status]) return STATUS_COLOR[status]
  const s = `${status} ${cn}`.toLowerCase()
  if (/reject|拒绝/.test(s)) return '#ff4d4f'
  if (/完成|实现|解决|通过|关闭|上线|done|closed|resolve/.test(s)) return '#52c41a'
  if (/测试/.test(s)) return '#722ed1'
  if (/进行|开发|progress|develop/.test(s)) return '#1677ff'
  if (/规划|待|未|open|new|plan/.test(s)) return '#faad14'
  return '#8c8c8c'
}

// 工单的规模点：本项目存在自定义字段 custom_field_four（TAPD 内置 size 字段未启用），size 作兜底
function pointOf(it) {
  const v = parseFloat(it?.custom_field_four ?? it?.size ?? '')
  return Number.isFinite(v) ? v : 0
}

// 工单的截止时间（story/task 为 due，bug 为 deadline）：表格列/详情抽屉展示用
const dueOf = (it) => it?.due || it?.deadline || ''

// 富文本评论转纯文本用于编辑框（本项目发的评论均为纯文本；他人富文本评论编辑保存后格式变为纯文本）
const plainOf = (html) => {
  const s = String(html || '')
  return /<[a-z][\s\S]*>/i.test(s) ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') : s
}

// 数字展示（规模点求和后去浮点尾差）
const fmtPoint = (v) => Math.round((v || 0) * 100) / 100

// 缓存时间的人类可读描述（同 DepGraph 的 depTimeAgo）
function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString()
}

// 状态 Tag：圆点 + 文字 + 状态专属色（详情抽屉/表格/流转弹窗共用）；
// 传 onClick 即可点击（表格里点状态 Tag 直接流转）
function StatusTag({ status, cn, style, className, onClick, title }) {
  const color = colorOf(status, cn)
  return (
    <span
      className={className}
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '1px 10px',
        borderRadius: 12,
        fontSize: 12,
        background: `${color}1f`,
        color,
        border: `1px solid ${color}55`,
        ...style,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' }} />
      {cn || status}
    </span>
  )
}

// 优先级圆点：圆形 + 中间字母，颜色对齐 TAPD 优先级配置（紧急 橙红 / High 红 / Middle 绿 /
// Low 灰 / Nice To Have 蓝灰）；未收录的值兜底取首字母 + 灰色
const PRIORITY_META = {
  High: { letter: 'H', color: '#ff4d4f' },
  Middle: { letter: 'M', color: '#52c41a' },
  Low: { letter: 'L', color: '#8c8c8c' },
  'Nice To Have': { letter: 'N', color: '#7d9eb8' },
}

// 优先级取色：先精确命中已知英文值，再按关键词归一匹配（大小写不同、中文「高/中/低/紧急」、
// 带序号前缀如 "4-High" 都能对上色，避免非标准取值全落灰色看起来同色）；顺序即优先级
const PRIORITY_COLOR_RULES = [
  [/紧急|urgent|critical/i, '#fa541c'],
  [/high|高/i, '#ff4d4f'],
  [/middle|medium|中/i, '#52c41a'],
  [/low|低/i, '#8c8c8c'],
  [/nice|可选/i, '#7d9eb8'],
]
function priorityColorOf(p) {
  const s = String(p || '').trim()
  return PRIORITY_META[s]?.color || PRIORITY_COLOR_RULES.find(([re]) => re.test(s))?.[1] || '#8c8c8c'
}

// 优先级徽标（表格类型列缀用 / 详情抽屉）：悬浮显示完整优先级名
function PriorityDot({ priority, style }) {
  const p = String(priority || '').trim()
  if (!p) return null
  return (
    <span
      title={`优先级 ${p}`}
      style={{
        flex: 'none',
        width: 16,
        height: 16,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        color: '#fff',
        background: priorityColorOf(p),
        ...style,
      }}
    >
      {PRIORITY_META[p]?.letter || p.charAt(0).toUpperCase()}
    </span>
  )
}

// TAPD 富文本图片的 src 是根相对路径（如 /tfl/captures/2026-08/xxx.png），且 file.tapd.cn
// 只认 TAPD 网页登录 Cookie（直连会 302 到登录页，个人访问令牌也不被文件域名接受）。
// 统一重写成 tapd-img:// 协议：主进程代理请求并附上应用会话里的 Cookie（见 ipc/tapd.js）；
// tapd.cn 的绝对/协议相对地址一并代理，外站图片（figma 等）保持原样。
function proxiedTapdImages(html) {
  return String(html || '')
    .replace(
      /(<img\b[^>]*\bsrc=["'])(?:https?:)?\/\/((?:[\w-]+\.)*tapd\.cn)(\/[^"']*)(["'])/gi,
      '$1tapd-img://$2$3$4',
    )
    .replace(/(<img\b[^>]*\bsrc=["'])\/(?!\/)([^"']*)(["'])/g, '$1tapd-img://file.tapd.cn/$2$3')
}

// 富文本里的 <a> 不能让它在工单窗口内导航（会把整个应用页面顶掉）：拦截后交给系统浏览器
function onRichContentClick(e) {
  const a = e.target.closest && e.target.closest('a[href]')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (/^https?:/i.test(href)) window.api.shell.openExternal(href)
}

// 图片加载失败时（未登录 / 文件过期）给出可见的占位样式，而不是不可见的空白
function onRichImageError(e) {
  const img = e.target
  if (!img || img.tagName !== 'IMG' || img.dataset.tapdFallback) return
  img.dataset.tapdFallback = '1'
  img.style.minWidth = '48px'
  img.style.minHeight = '32px'
  img.style.outline = '1px dashed rgba(250,173,20,0.5)'
  img.alt = '图片加载失败（需登录 TAPD 网页版）'
}

// 富文本/纯文本统一渲染（TAPD description 两种都可能返回；纯文本保留换行）。
// 暗色主题下富文本内联的深灰字色由页面级 .tapd-rich 规则强制覆盖，保证可读
function RichContent({ html, style }) {
  const s = String(html || '').trim()
  if (!s) return <Text type="secondary">（无）</Text>
  if (!/[<>]/.test(s)) {
    return <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }}>{s}</div>
  }
  return (
    <div
      className="tapd-rich"
      style={style}
      onClick={onRichContentClick}
      onErrorCapture={onRichImageError}
      dangerouslySetInnerHTML={{ __html: proxiedTapdImages(s) }}
    />
  )
}

// 从用户输入提取 workspace_id：纯数字直接用；否则按 TAPD 链接格式提取
// （tapd.cn/60171234/... 与 tapd.cn/tapd_fe/23436281/... 都支持，与 core 的
// parseWorkspaceIdFromLink 同规则；渲染层不能 import core（会带进 node:fs），本地实现一份）
function extractWorkspaceId(input) {
  const s = String(input || '').trim()
  if (/^\d{6,}$/.test(s)) return s
  const m = s.match(/https?:\/\/(?:www\.)?tapd\.cn\/(?:[^/?#]+\/)*?(\d{6,})/i)
  return m ? m[1] : null
}

/* ---------------- 状态分布饼图（我的工单按状态聚合，颜色与状态专属色一致） ---------------- */

function StatusPie({ items, statusMap }) {
  const ref = useRef(null)

  const data = useMemo(() => {
    const counts = new Map()
    items.forEach((it) => counts.set(it.status, (counts.get(it.status) || 0) + 1))
    return [...counts.entries()].map(([s, n]) => ({
      name: statusMap?.[s] || s,
      value: n,
      itemStyle: { color: colorOf(s, statusMap?.[s]) },
    }))
  }, [items, statusMap])

  useEffect(() => {
    if (!ref.current || !data.length) return
    const chart = echarts.init(ref.current)
    chart.setOption({
      // confine：右列容器 overflow 会裁掉越界 tooltip，限定在画布内不被遮挡；
      // 配色同步暗色主题（默认白底在暗色页面里突兀）
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: '{b}: {c} 条 ({d}%)',
        backgroundColor: 'rgba(20,20,24,0.94)',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
        extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.45); border-radius: 8px;',
      },
      legend: {
        bottom: 0,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },
      },
      series: [
        {
          type: 'pie',
          radius: ['58%', '78%'],
          center: ['50%', '42%'],
          itemStyle: { borderColor: '#0d0d0f', borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          emphasis: { scaleSize: 4 },
          data,
        },
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: '35%',
          style: { text: String(items.length), textAlign: 'center', fill: 'rgba(255,255,255,0.88)', fontSize: 22, fontWeight: 700 },
        },
        {
          type: 'text',
          left: 'center',
          top: '45%',
          style: { text: '我的工单', textAlign: 'center', fill: 'rgba(255,255,255,0.45)', fontSize: 11 },
        },
      ],
    })
    return () => chart.dispose()
  }, [data, items.length])

  return (
    <div ref={ref} style={{ height: 216 }}>
      {!data.length && (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            暂无数据
          </Text>
        </div>
      )}
    </div>
  )
}

/* ---------------- 月度完成规模点日历（年视图 12 宫格，热力深浅 = 当月完成规模点） ---------------- */

function PointsCalendar({ monthlyPoints, currentMonthKey }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const vals = months.map((k) => monthlyPoints[k] || 0)
  const maxV = Math.max(...vals, 1)
  const yearTotal = vals.reduce((a, b) => a + b, 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <Button size="small" type="text" icon={<LeftOutlined />} onClick={() => setYear(year - 1)} />
        <Text strong style={{ fontSize: 13, flex: 1, textAlign: 'center' }}>
          {year} 年 · {fmtPoint(yearTotal)} 点
        </Text>
        <Button
          size="small"
          type="text"
          icon={<RightOutlined />}
          disabled={year >= now.getFullYear()}
          onClick={() => setYear(year + 1)}
        />
      </div>
      {/* 从下到上依次是 1-12 月（底行 1-4 月，向上 5-8、9-12）：时间自下而上生长，
          最新月份（当月/年底）在顶部，视线自然落在右上 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {months.slice().reverse().map((k) => {
          const m = Number(k.slice(5, 7)) // 月份（1-12），由 key 解析（数组已倒序，不能用下标）
          const v = monthlyPoints[k] || 0
          const isCur = k === currentMonthKey
          const future = year === now.getFullYear() && m - 1 > now.getMonth()
          return (
            <Tooltip key={k} title={v ? `${k} 完成 ${fmtPoint(v)} 点` : `${k} 无完成记录`}>
              <div
                style={{
                  position: 'relative',
                  padding: '8px 4px',
                  borderRadius: 8,
                  textAlign: 'center',
                  cursor: 'default',
                  border: `1px solid ${isCur ? '#1677ff' : 'rgba(255,255,255,0.08)'}`,
                  background: v ? `rgba(22,119,255,${(0.06 + 0.32 * (v / maxV)).toFixed(2)})` : 'rgba(255,255,255,0.03)',
                  opacity: future ? 0.35 : 1,
                }}
              >
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{m}月</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: v ? '#8cc5ff' : 'rgba(255,255,255,0.3)' }}>
                  {v ? fmtPoint(v) : '·'}
                </div>
                {isCur && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 6,
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: '#1677ff',
                    }}
                  />
                )}
              </div>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- 凭据表单（NO_TAPD_AUTH 或点「凭据设置」打开） ---------------- */

function TapdAuthModal({ open, config, onClose, onSaved, onWebLoginChange }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [suggests, setSuggests] = useState([])
  const [webLogin, setWebLogin] = useState(null) // 网页登录态：null=检测中，true/false=已/未登录
  const [webBusy, setWebBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      token: config?.token || '',
      workspaceId: config?.workspaceId || '',
    })
    // 本地项目 _tapd 链接解析出的 workspace_id，作默认项目的推荐项（零配置可用）
    window.api.tapd.suggestWorkspaces().then((res) => {
      if (res.ok) setSuggests(res.data || [])
    })
    // 打开即探测网页登录态（Cookie 探测，见 ipc/tapd.js checkLogin）
    setWebLogin(null)
    window.api.tapd.checkLogin().then((res) => setWebLogin(!!(res.ok && res.data?.loggedIn)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config])

  // 去登录：openLogin 在登录窗口关闭时 resolve，随后复检登录态更新展示
  const doLogin = async () => {
    setWebBusy(true)
    const res = await window.api.tapd.openLogin()
    if (!res?.ok) {
      setWebBusy(false)
      message.error(res.error || '打开登录窗口失败')
      return
    }
    const c = await window.api.tapd.checkLogin()
    setWebBusy(false)
    const ok = !!(c.ok && c.data?.loggedIn)
    setWebLogin(ok)
    onWebLoginChange?.(ok) // 同步页面级登录态（详情抽屉的登录提示条随之显隐）
    if (ok) message.success('TAPD 登录成功，工单图片将正常显示')
    else message.warning('仍未检测到登录态，请确认已在窗口中完成登录后重试')
  }

  // 退出网页登录：清掉会话里的 tapd.cn Cookie，图片回到占位框（列表/流转/评论不受影响）
  const doLogout = async () => {
    setWebBusy(true)
    const res = await window.api.tapd.logout()
    setWebBusy(false)
    if (!res.ok) {
      message.error(res.error || '退出失败')
      return
    }
    setWebLogin(false)
    onWebLoginChange?.(false)
    message.success('已退出 TAPD 网页登录')
  }

  const submit = async (vals) => {
    setSaving(true)
    // workspace_id 容错：粘整条工单链接也能识别出项目 ID
    const ws = extractWorkspaceId(vals.workspaceId)
    if (vals.workspaceId && !ws) {
      setSaving(false)
      message.warning('默认项目请填数字 workspace_id，或直接粘贴 TAPD 工单链接自动识别')
      return
    }
    const res = await window.api.tapd.saveConfig({ ...vals, workspaceId: ws || '' })
    if (!res.ok) {
      setSaving(false)
      message.error(res.error || '保存失败')
      return
    }
    // 保存后立即校验凭据（GET /users/info）给出即时反馈；校验失败不阻塞（可能是网络抖动，列表加载仍会兜底报错）
    const user = await window.api.tapd.user()
    setSaving(false)
    if (user.ok) message.success(user.data?.nick ? `已保存并验证：${user.data.nick}` : '已保存，凭据有效')
    else message.warning(`已保存，但校验失败：${user.error}`)
    onSaved?.(res.data)
  }

  return (
    <Modal title="TAPD 访问令牌" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="访问令牌在 TAPD「个人设置 → 个人访问令牌」里创建"
        description={
          <Text type="secondary" style={{ fontSize: 12 }}>
            令牌明文保存在本机数据目录 tapd.json，仅本机自用、不上传任何服务器；泄露风险与密码等同，请妥善保管。
          </Text>
        }
      />
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="token"
          label="访问令牌"
          rules={[{ required: true, message: '请粘贴访问令牌' }]}
          extra="创建后仅展示一次，若忘记可删除重建"
        >
          <Input.Password placeholder="粘贴个人访问令牌" autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="workspaceId" label="项目 workspace_id">
          <AutoComplete
            allowClear
            placeholder="可从本地项目的工单链接自动识别，也可手填"
            options={suggests.map((s) => ({
              value: s.workspaceId,
              label: `${s.workspaceId}（本地 ${s.count} 个项目引用）`,
            }))}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存并校验
        </Button>
      </Form>

      {/* 网页登录区：与令牌分开（用途不同——Cookie 只服务富文本图片），随时可登录/退出 */}
      <Divider style={{ margin: '20px 0 12px' }}>网页登录（工单图片）</Divider>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {webLogin === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            正在检测登录态…
          </Text>
        ) : (
          <Tag
            bordered={false}
            style={
              webLogin
                ? { marginInlineEnd: 0, background: 'rgba(82,196,26,0.12)', color: '#95de64' }
                : { marginInlineEnd: 0, background: 'rgba(250,173,20,0.12)', color: '#ffd666' }
            }
          >
            {webLogin ? '已登录' : '未登录'}
          </Tag>
        )}
        <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 180 }}>
          Cookie 保存在本机应用会话，登录后工单图片自动显示；退出后图片显示占位框，列表/流转/评论不受影响
        </Text>
        {webLogin === false && (
          <Button loading={webBusy} onClick={doLogin}>
            去登录
          </Button>
        )}
        {webLogin === true && (
          <Button danger loading={webBusy} onClick={doLogout}>
            退出登录
          </Button>
        )}
      </div>
    </Modal>
  )
}

/* ---------------- 网页登录引导（进门检查：令牌之外，富文本图片需要网页登录态） ---------------- */

function LoginGuideModal({ open, onDone }) {
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)

  // openLogin 在登录窗口关闭时才 resolve；随后复检登录态，成功才放行
  const go = async () => {
    setBusy(true)
    const res = await window.api.tapd.openLogin()
    if (!res?.ok) {
      setBusy(false)
      message.error(res.error || '打开登录窗口失败')
      return
    }
    const c = await window.api.tapd.checkLogin()
    setBusy(false)
    if (c.ok && c.data?.loggedIn) {
      message.success('TAPD 登录成功，工单图片将正常显示')
      onDone(true)
    } else {
      message.warning('仍未检测到登录态，请确认已在窗口中完成登录后重试')
    }
  }

  return (
    <Modal title="登录 TAPD 网页版" open={open} onCancel={() => onDone(false)} footer={null} destroyOnClose width={480}>
      <div style={{ fontSize: 13, lineHeight: 1.8 }}>
        <p style={{ margin: '0 0 8px' }}>
          工单数据（列表/流转/评论）走<b>访问令牌</b>，已就绪；但富文本里的<b>图片</b>存放在 TAPD 文件域，
          只认网页登录态，需要再登录一次网页版。
        </p>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
          登录一次即可，Cookie 保存在本机应用会话中，之后工单里的图片自动显示。不登录也不影响列表、流转和评论，仅图片显示占位框。
        </Text>
        <Space>
          <Button type="primary" loading={busy} onClick={go}>
            去登录
          </Button>
          <Button disabled={busy} onClick={() => onDone(false)}>
            暂不登录
          </Button>
        </Space>
      </div>
    </Modal>
  )
}

/* ---------------- 共享样式（本页与主窗口的工单详情抽屉共用） ---------------- */

// 富文本内容样式：暗色下强制可读的字色 + 自适应图片；流转路径动效
// （--nc* 为节点状态色的十六进制 alpha 变体，由内联 style 注入）。
// 抽成组件是因为主窗口（仓库页本地项目彩带）也会渲染 DetailDrawer/FlowModal，
// 其中的 tapd-* class 依赖这里的定义
export function TapdStyles() {
  return (
    <style>{`
      .tapd-rich, .tapd-rich * { color: rgba(255,255,255,0.82) !important; }
      .tapd-rich a { color: #4096ff !important; }
      .tapd-rich p { margin: 0 0 8px; line-height: 1.7; }
      .tapd-rich img { max-width: 100%; border-radius: 6px; }
      .tapd-rich pre, .tapd-rich code { white-space: pre-wrap; word-break: break-word; }
      @keyframes tapd-node-pulse {
        0% { box-shadow: 0 0 0 0 var(--nc-a, rgba(255,255,255,0.4)); }
        75%, 100% { box-shadow: 0 0 0 9px var(--nc-0, transparent); }
      }
      @keyframes tapd-dash-flow { to { background-position: 9px 0; } }
      .tapd-node-current { animation: tapd-node-pulse 1.6s ease-out infinite; }
      .tapd-node-target:hover { background: var(--nc-1f, rgba(255,255,255,0.1)) !important; transform: translateY(-1px); }
      .tapd-dash-lit { animation: tapd-dash-flow .5s linear infinite; }
      .tapd-path-current { animation: tapd-node-pulse 1.6s ease-out infinite; }
      .tapd-status-flow { cursor: pointer; transition: filter .15s, transform .15s; }
      .tapd-status-flow:hover { filter: brightness(1.35); transform: translateY(-1px); }
      .tapd-name-acts { opacity: 0; transition: opacity .15s; }
      .tapd-name-cell:hover .tapd-name-acts { opacity: 1; }
      .tapd-name-cell .tapd-name-acts button:hover { color: rgba(255,255,255,0.9) !important; }
      .tapd-stat-card { transition: transform .18s, filter .18s, background .2s, border-color .2s, box-shadow .2s; }
      .tapd-stat-card:hover { transform: translateY(-1px); filter: brightness(1.18); }
    `}</style>
  )
}

/* ---------------- 流转路径轨道（详情抽屉的视觉主线） ---------------- */

// 垂直步进轨道：创建 → flows 途经状态 → 当前 → 完成。
// 左侧「首状态色 → 末状态色」渐变轨道串起节点；当前节点放大发光脉冲，
// 其余节点实心圆点 + 状态色胶囊，时间缀在胶囊右侧
function FlowPath({ item, statusMap }) {
  // 相邻同状态合并（flows 末尾常与当前状态重复），时间取有值的一方
  const steps = [
    { key: '__created', label: '创建', color: '#8c8c8c', time: item.created },
    ...String(item.flows || '')
      .split('|')
      .filter(Boolean)
      .map((s) => ({ key: s, label: statusMap?.[s] || s, color: colorOf(s, statusMap?.[s]) })),
    {
      key: item.status,
      label: statusMap?.[item.status] || item.status,
      color: colorOf(item.status, statusMap?.[item.status]),
      current: true,
    },
    ...(item.completed ? [{ key: '__done', label: '完成', color: '#52c41a', time: item.completed }] : []),
  ].reduce((acc, s) => {
    const prev = acc[acc.length - 1]
    if (prev && prev.key === s.key) acc[acc.length - 1] = { ...s, time: s.time || prev.time }
    else acc.push(s)
    return acc
  }, [])
  const first = steps[0]?.color || '#8c8c8c'
  const last = steps[steps.length - 1]?.color || '#8c8c8c'

  return (
    <div
      style={{
        marginBottom: 16,
        padding: '12px 16px 10px 14px',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.09)',
        background: 'linear-gradient(135deg, rgba(22,119,255,0.08), rgba(255,255,255,0.02) 55%)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <SwapOutlined style={{ color: '#69b1ff', fontSize: 13 }} />
        <Text strong style={{ fontSize: 12, letterSpacing: 1 }}>
          流转路径
        </Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {steps.length} 步
        </Text>
      </div>
      <div style={{ position: 'relative', padding: '4px 0' }}>
        {/* 渐变轨道：从首个节点色过渡到末节点色，置于节点圆心正下方（left 7 + width 2 = 圆心 8px） */}
        <div
          style={{
            position: 'absolute',
            left: 7,
            top: 12,
            bottom: 12,
            width: 2,
            borderRadius: 1,
            background: `linear-gradient(180deg, ${first}, ${last})`,
            opacity: 0.45,
          }}
        />
        {steps.map((s, i) => (
          <div key={`${s.key}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <span
              className={s.current ? 'tapd-path-current' : undefined}
              style={{
                flex: 'none',
                width: s.current ? 14 : 10,
                height: s.current ? 14 : 10,
                marginLeft: s.current ? 1 : 3,
                borderRadius: '50%',
                background: s.color,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: s.current ? `0 0 10px ${s.color}aa` : 'none',
                zIndex: 1,
              }}
            >
              {s.current && <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff' }} />}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: s.current ? 600 : 400,
                color: s.current ? s.color : 'rgba(255,255,255,0.78)',
                padding: s.current ? '2px 10px' : '2px 8px',
                borderRadius: 10,
                background: s.current ? `${s.color}26` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${s.current ? `${s.color}88` : 'rgba(255,255,255,0.07)'}`,
              }}
            >
              {s.label}
              {s.current ? ' · 当前' : ''}
            </span>
            {s.time && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {s.time}
              </Text>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 详情抽屉（全字段 + 描述 + 评论历史 / 回评论） ---------------- */

export function DetailDrawer({ open, item, type, statusMap, workspaceId, myName, webLogin, onWebLogin, onClose, onFlow }) {
  const { message } = App.useApp()
  const [comments, setComments] = useState([])
  const [cmtsLoading, setCmtsLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState(null) // 回复目标 { author, id }：发送时在内容前加「回复 @作者：」
  const [editingId, setEditingId] = useState(null) // 正在内联编辑的评论 id
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  // 图片重载 nonce：登录 TAPD 后点「重新加载」bump 一次，key 变化强制 <img> 重新请求
  const [imgNonce, setImgNonce] = useState(0)
  const hasImages =
    /<img\b/i.test(String(item?.description || '')) || comments.some((c) => /<img\b/i.test(c.description || ''))

  // 打开/切换工单时拉评论（实时，不缓存）；失败静默为空（评论是增强信息）
  useEffect(() => {
    if (!open || !item) return
    setDraft('')
    setReplyTo(null)
    setEditingId(null)
    let alive = true
    setCmtsLoading(true)
    window.api.tapd
      .comments({ type, workspaceId, id: item.id })
      .then((res) => {
        if (alive) setComments(res.ok ? res.data || [] : [])
      })
      .finally(() => {
        if (alive) setCmtsLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, type, workspaceId])

  const send = async () => {
    const content = draft.trim()
    if (!content || !myName) return
    setSending(true)
    // 官方添加评论接口无回复参数，回复用「回复 @作者：」前缀表达（与 TAPD 网页端展示习惯一致）
    const finalContent = replyTo ? `回复 @${replyTo.author}：${content}` : content
    const res = await window.api.tapd.addComment({ type, workspaceId, id: item.id, content: finalContent, author: myName })
    setSending(false)
    if (!res.ok) {
      message.error(res.error || '评论失败')
      return
    }
    setDraft('')
    setReplyTo(null)
    const list = await window.api.tapd.comments({ type, workspaceId, id: item.id })
    if (list.ok) setComments(list.data || [])
  }

  // 保存内联编辑的评论（官方 API 仅支持改内容，删除需去 TAPD 网页端）
  const saveEdit = async () => {
    const content = editDraft.trim()
    if (!content || !editingId) return
    setSavingEdit(true)
    const res = await window.api.tapd.updateComment({ workspaceId, commentId: editingId, content, author: myName })
    setSavingEdit(false)
    if (!res.ok) {
      message.error(res.error || '修改失败')
      return
    }
    setEditingId(null)
    const list = await window.api.tapd.comments({ type, workspaceId, id: item.id })
    if (list.ok) setComments(list.data || [])
  }

  const rowItem = (label, value) => (
    <Descriptions.Item key={label} label={label}>
      {value ?? '-'}
    </Descriptions.Item>
  )

  return (
    <Drawer open={open} onClose={onClose} width={620} title="工单详情" styles={{ body: { padding: '12px 20px 24px' } }}>
      {item && (
        <div>
          {/* 头部：状态 + 标题 + 操作 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <StatusTag status={item.status} cn={statusMap?.[item.status]} />
            {/* 优先级与表格徽标同色系：底色/描边/圆点统一按优先级取色 */}
            {item.priority && (
              <Tag
                bordered={false}
                style={{
                  marginInlineEnd: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: `${priorityColorOf(item.priority)}1f`,
                  color: priorityColorOf(item.priority),
                  border: `1px solid ${priorityColorOf(item.priority)}55`,
                }}
              >
                <PriorityDot priority={item.priority} style={{ width: 12, height: 12, fontSize: 8 }} />
                优先级 {item.priority}
              </Tag>
            )}
            <div style={{ flex: 1 }} />
            <Button size="small" type="primary" ghost onClick={() => onFlow(item)}>
              流转
            </Button>
            <Button size="small" icon={<ExportOutlined />} onClick={() => window.api.shell.openExternal(item._url)}>
              TAPD 打开
            </Button>
          </div>
          <Text strong style={{ fontSize: 16, lineHeight: 1.5, display: 'block', marginBottom: 12 }}>
            {item.name || item.title}
          </Text>

          <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
            {rowItem('处理人', String(item.owner || '').split(';').filter(Boolean).join('、') || '-')}
            {rowItem('规模点', pointOf(item) || '-')}
            {rowItem('截止时间', dueOf(item) || '-')}
            {rowItem('创建人', item.creator || '-')}
            {rowItem('创建时间', item.created || '-')}
            {rowItem('修改时间', item.modified || '-')}
            {rowItem('完成时间', item.completed || '未完成')}
          </Descriptions>

          {/* 流转路径轨道：创建 → flows 途经状态 → 当前 → 完成（本抽屉的视觉主线） */}
          <FlowPath item={item} statusMap={statusMap} />

          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            描述
          </Text>
          {/* 图片登录提示只在「明确未登录」时显示（webLogin 由页面级状态下发，
              登录成功/退出都会同步），已登录时不再打扰 */}
          {hasImages && webLogin === false && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
                padding: '4px 10px',
                background: 'rgba(250,173,20,0.08)',
                border: '1px solid rgba(250,173,20,0.25)',
                borderRadius: 8,
              }}
            >
              <PictureOutlined style={{ color: '#faad14', fontSize: 13 }} />
              <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', flex: 1 }}>
                描述/评论含 TAPD 图片，需登录网页版后显示
              </Text>
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: 'auto' }}
                onClick={async () => {
                  // openLogin 在登录窗口关闭（或登录成功自动关窗）时 resolve，届时 Cookie 已入会话
                  const res = await window.api.tapd.openLogin()
                  if (!res?.ok) return
                  setImgNonce((n) => n + 1)
                  // 复检并上报页面级登录态：成功则本提示条随 webLogin 变 true 消失
                  const c = await window.api.tapd.checkLogin()
                  onWebLogin?.(!!(c.ok && c.data?.loggedIn))
                }}
              >
                去登录
              </Button>
              <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => setImgNonce((n) => n + 1)}>
                重新加载
              </Button>
            </div>
          )}
          <div
            style={{
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 8,
              padding: '10px 14px',
              marginBottom: 16,
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            <RichContent key={`desc-${imgNonce}`} html={item.description} />
          </div>

          {/* 评论区：历史 + 回复框 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <CommentOutlined style={{ color: 'rgba(255,255,255,0.45)' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              评论 {comments.length ? `· ${comments.length} 条` : ''}
            </Text>
          </div>
          {cmtsLoading ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              评论加载中…
            </Text>
          ) : comments.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {comments.map((c, i) => {
                const mine = !!myName && c.author === myName
                return (
                  <div key={c.id || i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: 600 }}>{c.author}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {c.created}
                        {c.modified && c.modified !== c.created ? ' · 已修改' : ''}
                      </Text>
                      <div style={{ flex: 1 }} />
                      {/* 回复/修改：小号文字按钮贴在右侧，不抢内容视线 */}
                      <Button
                        type="text"
                        size="small"
                        style={{ height: 20, padding: '0 4px', fontSize: 12 }}
                        onClick={() => setReplyTo({ author: c.author, id: c.id })}
                      >
                        回复
                      </Button>
                      {mine && (
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined style={{ fontSize: 11 }} />}
                          style={{ height: 20, padding: '0 4px', fontSize: 12 }}
                          onClick={() => {
                            setEditingId(c.id)
                            setEditDraft(plainOf(c.description))
                          }}
                        >
                          修改
                        </Button>
                      )}
                    </div>
                    {editingId === c.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <Input.TextArea
                          rows={2}
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          placeholder="修改评论内容…"
                          onPressEnter={(e) => {
                            if (!e.shiftKey) {
                              e.preventDefault()
                              saveEdit()
                            }
                          }}
                        />
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <Button size="small" onClick={() => setEditingId(null)}>
                            取消
                          </Button>
                          <Button size="small" type="primary" loading={savingEdit} disabled={!editDraft.trim()} onClick={saveEdit}>
                            保存
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <RichContent key={`cmt-${i}-${imgNonce}`} html={c.description} style={{ fontSize: 13 }} />
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              暂无评论
            </Text>
          )}
          {/* 回复目标条：点评论「回复」后出现，发送内容自动加「回复 @作者：」前缀，可取消 */}
          {replyTo && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
                padding: '3px 10px',
                background: 'rgba(22,119,255,0.10)',
                border: '1px solid rgba(22,119,255,0.28)',
                borderRadius: 6,
              }}
            >
              <MessageOutlined style={{ color: '#69b1ff', fontSize: 12 }} />
              <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', flex: 1 }}>
                回复 @{replyTo.author}
              </Text>
              <Button
                type="text"
                size="small"
                style={{ height: 20, padding: '0 4px', fontSize: 12 }}
                onClick={() => setReplyTo(null)}
              >
                取消
              </Button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Input.TextArea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                !myName ? '配置访问令牌后可评论' : replyTo ? `回复 @${replyTo.author}…` : '添加评论 / 处理意见…'
              }
              disabled={!myName}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim() || !myName} onClick={send}>
              发送
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  )
}

/* ---------------- 流转弹窗（仿 TAPD 网页端：状态按钮组 + 处理人 + 评论） ---------------- */

export function FlowModal({ open, item, type, statusMap, transitions, members, workspaceId, myName, onClose, onDone }) {
  const { message } = App.useApp()
  const [saving, setSaving] = useState(false)
  const [target, setTarget] = useState('') // 目标状态英文值
  const [owners, setOwners] = useState([]) // 处理人（数组，提交时 ; 连接）
  const [comment, setComment] = useState('')
  const [extraVals, setExtraVals] = useState({}) // 工作流其它必填附加字段

  const typeCn = TYPES.find((t) => t.key === type)?.label || '工单'

  // 接口确认的可流转目标（all_transitions 实测只返回无条件边：本项目 story 主链
  // 规划中→实现中→待测试→测试中配了条件/角色，接口不吐，但服务端实际放行——
  // 评论流水账可见这些流转高频发生）。因此链上全部状态放开可点，提交以 TAPD
  // 服务端校验为准；接口确认过的目标实线强调，其余虚线提示「服务端校验」。
  const apiTargets = useMemo(() => {
    if (!item) return []
    return [...new Set(transitions.filter((t) => t.from === item.status).map((t) => t.to))].filter(
      (s) => s !== item.status,
    )
  }, [transitions, item])

  // 流转链：只展示主线（规划中→实现中→待测试→测试中→已通过；task 三态），
  // 旁路状态（修改中/待反馈/已实现/已拒绝等）不进链；当前状态或可流转目标
  // 不在主线时追加尾部，保证位置可见、目标仍可选
  const chainStatuses = useMemo(() => {
    if (!item) return []
    const main =
      type === 'task'
        ? TASK_MAIN_FLOW
        : MAIN_FLOW_CN.map((cn) => Object.keys(statusMap || {}).find((k) => statusMap[k] === cn)).filter(Boolean)
    const extra = [item.status, ...apiTargets].filter((k) => !main.includes(k))
    return [...new Set([...main, ...extra])]
  }, [type, statusMap, item, apiTargets])

  // 路径点亮段：选中目标后按链上位置取「当前 → 目标」区间（含往回流转的场景）
  const curIdx = chainStatuses.indexOf(item?.status)
  const selIdx = target ? chainStatuses.indexOf(target) : -1
  const lo = selIdx >= 0 ? Math.min(curIdx, selIdx) : -1
  const hi = selIdx >= 0 ? Math.max(curIdx, selIdx) : -1

  // 选中目标对应的必填附加字段（owner 由固定的处理人控件承担，排除避免重复）
  const requiredFields = useMemo(() => {
    if (!item || !target) return []
    const t = transitions.find((x) => x.from === item.status && x.to === target)
    return (t?.requiredFields || []).filter((f) => f.field !== 'owner')
  }, [transitions, item, target])

  // 处理人候选：项目成员（账号名即 owner 字段格式）∪ 当前工单处理人
  const ownerOptions = useMemo(() => {
    const map = new Map()
    ;(members || []).forEach((m) => map.set(m.user, `${m.name}（${m.user}）`))
    String(item?.owner || '')
      .split(';')
      .filter(Boolean)
      .forEach((o) => {
        if (!map.has(o)) map.set(o, o)
      })
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [members, item])

  useEffect(() => {
    if (open && item) {
      setTarget('')
      setOwners(String(item.owner || '').split(';').filter(Boolean))
      setComment('')
      setExtraVals({})
    }
  }, [open, item])

  const submit = async () => {
    if (!target) {
      message.warning('请选择要流转到的状态')
      return
    }
    if (!owners.length) {
      message.warning('请选择处理人')
      return
    }
    const missing = requiredFields.find((f) => !String(extraVals[f.field] || '').trim())
    if (missing) {
      message.warning(`请填写 ${missing.label || missing.field}`)
      return
    }
    setSaving(true)
    // owner 字段格式与 TAPD 一致（分号分隔、尾分号），如 fred.liu;klay.ye;
    const extraFields = { owner: `${owners.filter(Boolean).join(';')};` }
    requiredFields.forEach((f) => {
      extraFields[f.field] = extraVals[f.field]
    })
    const res = await window.api.tapd.updateStatus({
      type,
      workspaceId,
      id: item.id,
      status: target,
      extraFields,
    })
    if (!res.ok) {
      setSaving(false)
      // TAPD 的 info 通常已是中文明细（如缺必填字段、不允许的流转）
      message.error(res.error || '流转失败')
      return
    }
    // 有评论则追加（评论失败不回滚流转，仅提示）
    if (comment.trim() && myName) {
      const c = await window.api.tapd.addComment({
        type,
        workspaceId,
        id: item.id,
        content: comment.trim(),
        author: myName,
      })
      if (!c.ok) message.warning(`流转成功，但评论发送失败：${c.error}`)
    }
    setSaving(false)
    message.success(`已流转为「${statusMap?.[target] || target}」`)
    onDone?.()
  }

  // 小节标签（流转弹窗的统一字段标签样式）
  const fieldLabel = (text, required = false) => (
    <div style={{ marginBottom: 6 }}>
      <Text style={{ fontSize: 13 }}>
        {text}
        {required && (
          <Text type="danger" style={{ marginLeft: 4 }}>
            *
          </Text>
        )}
      </Text>
    </div>
  )

  return (
    <Modal
      title={`${typeCn}流转`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      width={640}
    >
      {item && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <StatusTag status={item.status} cn={statusMap?.[item.status]} />
            <Text style={{ fontSize: 13 }} ellipsis={{ tooltip: item.name || item.title }}>
              {item.name || item.title}
            </Text>
          </div>

          {/* 流转路径图（状态链）：当前状态发光脉冲、目标点选后实色 + 对勾；
              当前状态之前为「已走过」完成态（绿色 + 对勾，文案不变，仍可点选回退）；
              实线边框为接口确认可流转，虚线为接口未返回的流转（工作流配了条件/角色，
              服务端实际放行——本项目 story 主链即属此类）；选中后路径点亮、连线流动 */}
          {fieldLabel('流转到', true)}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, rowGap: 10, marginBottom: 4 }}>
            {chainStatuses.map((k, i) => {
              const color = colorOf(k, statusMap?.[k])
              const isCur = k === item.status
              const isSel = k === target
              const confirmed = apiTargets.includes(k) // all_transitions 返回的边（无条件流转）
              const inPath = lo >= 0 && i >= lo && i <= hi // 位于「当前 → 目标」点亮段
              const litNext = lo >= 0 && i >= lo && i + 1 <= hi // 节点右侧连线点亮（流动虚线）
              // 已走过（当前状态之前）：绿色完成态；点选回退被点亮/选中时让位给路径高亮
              const passed = !isCur && i < curIdx
              const passedDim = passed && !inPath && !isSel
              return (
                <React.Fragment key={k}>
                  <Tooltip
                    title={
                      isCur
                        ? '当前状态'
                        : confirmed
                          ? `流转到「${statusMap?.[k] || k}」（接口确认可流转）`
                          : `流转到「${statusMap?.[k] || k}」（未在接口返回，以 TAPD 服务端校验为准）`
                    }
                  >
                    <div
                      onClick={() => !isCur && setTarget(k)}
                      className={isCur ? 'tapd-node-current' : 'tapd-node-target'}
                      style={{
                        '--nc-a': `${color}66`,
                        '--nc-0': `${color}00`,
                        '--nc-1f': `${color}1f`,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        flex: 'none',
                        padding: '4px 12px',
                        borderRadius: 999,
                        fontSize: 13,
                        cursor: isCur ? 'default' : 'pointer',
                        opacity: isCur || isSel || confirmed ? 1 : 0.85,
                        border: `1.5px ${isCur || isSel || inPath || confirmed ? 'solid' : 'dashed'} ${isCur || isSel ? color : inPath ? `${color}99` : passedDim ? '#52c41a66' : confirmed ? `${color}55` : 'rgba(255,255,255,0.22)'}`,
                        background: isCur || isSel ? color : inPath ? `${color}24` : passedDim ? 'rgba(82,196,26,0.08)' : 'transparent',
                        color: isCur || isSel ? '#fff' : passedDim ? '#95de64' : color,
                        fontWeight: isCur || isSel ? 600 : 400,
                        transition: 'all .18s',
                      }}
                    >
                      {passed ? (
                        <CheckOutlined style={{ fontSize: 11, color: passedDim ? '#52c41a' : color, flex: 'none' }} />
                      ) : (
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: isCur || isSel ? '#fff' : color, flex: 'none' }} />
                      )}
                      {statusMap?.[k] || k}
                      {isCur && <span style={{ fontSize: 11, opacity: 0.8 }}>当前</span>}
                      {isSel && !isCur && <CheckOutlined style={{ fontSize: 11 }} />}
                    </div>
                  </Tooltip>
                  {i < chainStatuses.length - 1 && (
                    <span
                      className={litNext ? 'tapd-dash-lit' : undefined}
                      style={{
                        flex: 'none',
                        width: 14,
                        height: 2,
                        margin: '0 3px',
                        borderRadius: 1,
                        backgroundSize: '9px 100%',
                        // 已走过的连线实线绿色（步进器语义），点选目标后的流动虚线优先
                        background: litNext
                          ? 'repeating-linear-gradient(90deg, #69b1ff 0 5px, transparent 5px 9px)'
                          : curIdx > 0 && i + 1 <= curIdx
                            ? '#52c41a99'
                            : 'rgba(255,255,255,0.14)',
                      }}
                    />
                  )}
                </React.Fragment>
              )
            })}
            {!chainStatuses.length && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                未获取到可用流转，可关闭后点「刷新」重试
              </Text>
            )}
          </div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 16 }}>
            点选目标后路径点亮流动；虚线状态未在流转接口返回（工作流可能配了条件），提交以 TAPD 服务端校验为准，不允许会提示原因
          </Text>

          {/* 处理人：项目成员候选 + 支持手输（分号/逗号分隔多选） */}
          {fieldLabel('处理人', true)}
          <Select
            mode="tags"
            style={{ width: '100%', marginBottom: 16 }}
            value={owners}
            onChange={setOwners}
            options={ownerOptions}
            tokenSeparators={[';', '，']}
            placeholder="选择或输入处理人（可多个）"
            allowClear
            showSearch
            optionFilterProp="label"
          />

          {/* 工作流其它必填附加字段（如「处理人」之外 TAPD 要求的字段） */}
          {requiredFields.map((f) => (
            <React.Fragment key={f.field}>
              {fieldLabel(
                <Tooltip title="TAPD 工作流要求此流转必须填写该字段">
                  {f.label || f.field}
                  <Text type="warning" style={{ marginLeft: 4, fontSize: 12 }}>
                    （必填）
                  </Text>
                </Tooltip>,
                true,
              )}
              <Input
                style={{ marginBottom: 16 }}
                value={extraVals[f.field] ?? ((f.defaultValueFrom && item?.[f.defaultValueFrom]) || '')}
                onChange={(e) => setExtraVals({ ...extraVals, [f.field]: e.target.value })}
                placeholder={`工作流要求的附加字段 ${f.label || f.field}`}
              />
            </React.Fragment>
          ))}

          {/* 评论：流转成功后作为工单评论追加 */}
          {fieldLabel('评论')}
          <Input.TextArea
            rows={3}
            style={{ marginBottom: 18 }}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="@通知他人，增加评论/处理意见"
          />

          <Space>
            <Button type="primary" loading={saving} disabled={!chainStatuses.length} onClick={submit}>
              流转
            </Button>
            <Button onClick={onClose}>取消</Button>
          </Space>
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 页面主体 ---------------- */

export default function TapdPage() {
  const { message } = App.useApp()
  const [config, setConfig] = useState(null)
  const [needAuth, setNeedAuth] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [loginGuideOpen, setLoginGuideOpen] = useState(false)
  const [webLogin, setWebLogin] = useState(null) // 页面级网页登录态：详情抽屉的图片登录提示按此显隐
  const [workspaceId, setWorkspaceId] = useState('')
  const [wsName, setWsName] = useState('') // workspace 对应项目名（getWorkspaceInfo 校验+展示）
  const [myName, setMyName] = useState('') // 当前账号标识（users/info 的 name，与 owner 字段同格式）
  const [onlyMine, setOnlyMine] = useState(() => localStorage.getItem('tapd:onlyMine') !== '0') // 只看我的（默认开，记忆选择）
  const [members, setMembers] = useState([]) // 项目成员（流转选处理人候选）
  const [items, setItems] = useState([]) // 三类工单合并列表（每条带 _type 标记来源类型）
  const [baseItems, setBaseItems] = useState([]) // 我的全部工单（固定 owner 过滤；统计卡片/规模点日历用，不随筛选变）
  const [total, setTotal] = useState(0)
  const [savedAt, setSavedAt] = useState(null)
  const [loading, setLoading] = useState(false)
  const [statusMaps, setStatusMaps] = useState({}) // 状态映射按类型存（story/bug/task 的状态值集不同）
  const [transitionsByType, setTransitionsByType] = useState({}) // 流转细则按类型存（流转弹窗按工单类型取用）
  const [lastSteps, setLastSteps] = useState([]) // 工作流终态集合（三类合并，「已完成」分类依据）
  const [tableBodyY, setTableBodyY] = useState(320) // 表格体滚动高度（容器实测，分页固定在滚动区外）
  const tableWrapRef = useRef(null)
  const [bucket, setBucket] = useState('all') // 快速筛选：all / todo / doing / done
  const [statusFilter, setStatusFilter] = useState(undefined) // 服务端过滤（状态英文值）
  const [iterationInput, setIterationInput] = useState('')
  const [iterationId, setIterationId] = useState('') // 服务端过滤（回车提交）
  const [keyword, setKeyword] = useState('') // 客户端过滤（名称/ID，TAPD 列表接口无关键字搜索）
  const [flowItem, setFlowItem] = useState(null)
  const [detailItem, setDetailItem] = useState(null)

  // 本页内嵌在主窗口左侧栏切换（不再独立窗口）：标题沿用主窗口，页面切换由左侧栏负责

  // 进门三连检（顺序引导，任一缺失都先引导再加载）：
  // ① 令牌 —— 无效直接弹令牌表单，不往下走；
  // ② 网页登录态 —— 富文本图片需要，未登录弹登录引导（可跳过，只影响图片）；
  // ③ 都就绪 → 设 workspaceId 触发列表加载
  useEffect(() => {
    ;(async () => {
      const res = await window.api.tapd.loadConfig()
      const cfg = res.ok ? res.data : {}
      setConfig(cfg)
      const user = await window.api.tapd.user()
      if (!user.ok) {
        setNeedAuth(true)
        setAuthOpen(true)
        return
      }
      setMyName(user.data?.name || '')
      const lg = await window.api.tapd.checkLogin()
      const loggedIn = !!(lg.ok && lg.data?.loggedIn)
      setWebLogin(loggedIn)
      if (!loggedIn) {
        setLoginGuideOpen(true)
        return // 等引导结束（登录成功或跳过）再放行
      }
      startLoading(cfg)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 校验并展示项目名；ID 无效时给出提示，凭据缺失不算错
  useEffect(() => {
    if (!workspaceId) {
      setWsName('')
      return
    }
    let alive = true
    window.api.tapd.workspaceInfo(workspaceId).then((res) => {
      if (!alive) return
      if (res.ok) {
        setWsName(res.data?.name || '')
      } else {
        setWsName('')
        if (res.error !== 'NO_TAPD_AUTH') message.warning(res.error || `未找到项目 ${workspaceId}`)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // 加载列表 + 元信息；force=false 读缓存（无则请求），force=true 强制重拉。
  // 不分 Tab：需求/缺陷/任务三类合并进一张表（每条带 _type），「只看我的」开且已拿到账号时带 owner 服务端过滤
  const load = useCallback(
    async (force = false) => {
      if (!workspaceId) return
      setLoading(true)
      try {
        // 统计基线：固定按我的处理人拉三类全量（与状态/迭代/只看我的筛选无关），
        // 卡片与规模点日历始终展示我的全部任务；参数与主请求相同时命中 IPC 缓存，无额外网络
        if (myName) {
          Promise.all(
            TYPES.map((t) => window.api.tapd.list({ type: t.key, workspaceId, owner: myName, force })),
          ).then((rs) =>
            setBaseItems(
              rs.flatMap((res, i) =>
                res.ok ? (res.data?.items || []).map((it) => ({ ...it, _type: TYPES[i].key })) : [],
              ),
            ),
          )
        } else {
          setBaseItems([])
        }
        // 主列表：三类串行拉取后合并（TAPD 按账号限流，避免并发突发；列表接口有分页，请求量最大）
        const merged = []
        let totalSum = 0
        let savedAtMax = 0
        for (const t of TYPES) {
          const res = await window.api.tapd.list({
            type: t.key,
            workspaceId,
            status: statusFilter,
            iterationId: iterationId || undefined,
            owner: onlyMine && myName ? myName : undefined,
            force,
          })
          if (!res.ok) {
            if (res.error === 'NO_TAPD_AUTH') {
              setNeedAuth(true)
              setAuthOpen(true)
              setItems([])
              setTotal(0)
            } else {
              message.error(res.error || '加载失败')
            }
            return
          }
          setNeedAuth(false)
          merged.push(...(res.data?.items || []).map((it) => ({ ...it, _type: t.key })))
          totalSum += res.data?.total ?? res.data?.items?.length ?? 0
          savedAtMax = Math.max(savedAtMax, res.savedAt || 0)
        }
        merged.sort((a, b) => Number(b.id) - Number(a.id)) // id 越大越新，合并后统一按时间倒序
        setItems(merged)
        setTotal(totalSum)
        setSavedAt(savedAtMax || null)
        // 状态映射/流转细则/终态按类型拉取（IPC 层有缓存），失败不阻塞列表；
        // 状态值三类不重叠（story 的 planning/status_*、bug 的 new/resolved、task 三态），映射可安全合并
        const maps = {}
        const trs = {}
        const steps = []
        for (const t of TYPES) {
          const meta = await window.api.tapd.statusMap({ type: t.key, workspaceId })
          if (meta.ok && meta.data) maps[t.key] = meta.data
          const tr = await window.api.tapd.transitions({ type: t.key, workspaceId })
          trs[t.key] = tr.ok ? tr.data || [] : []
          const ls = await window.api.tapd.lastSteps({ type: t.key, workspaceId })
          steps.push(...(ls.ok ? ls.data || [] : []))
        }
        setStatusMaps(maps)
        setTransitionsByType(trs)
        setLastSteps([...new Set(steps)])
        const mem = await window.api.tapd.members({ workspaceId })
        setMembers(mem.ok ? mem.data || [] : [])
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, statusFilter, iterationId, onlyMine, myName],
  )

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // 放行列表加载：设置 workspaceId（load 随之自动触发）；项目变化或被清空都先清旧数据
  // （清空时 load 对空 workspaceId 直接 return，页面回到「未配置项目」空态，旧列表不残留）。
  // 供「进门三连检」和登录引导结束后统一调用（定义在 load 之后——依赖数组引用了它）
  const startLoading = useCallback(
    (cfg) => {
      const ws = cfg?.workspaceId || ''
      if (ws !== workspaceId) {
        setItems([])
        setBaseItems([])
        setTotal(0)
        setSavedAt(null) // 顶栏「数据缓存于」不随 workspaceId 块隐藏，须一并清掉
        setWorkspaceId(ws)
        return
      }
      if (!ws) return // 新旧都为空：维持空态
      load(true)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, load],
  )

  // 合并后的状态映射（三类状态值不重叠）与流转全集（起点判定用）；流转弹窗按工单类型取 transitionsByType
  const statusMap = useMemo(() => {
    const m = {}
    TYPES.forEach((t) => Object.assign(m, statusMaps[t.key] || {}))
    return m
  }, [statusMaps])
  const transitions = useMemo(
    () => TYPES.flatMap((t) => transitionsByType[t.key] || []),
    [transitionsByType],
  )

  // 表格体高度自适应：容器剩余高度 - 表头/分页（约 100px）为滚动区，分页固定在滚动区外不随内容滚走
  useEffect(() => {
    const el = tableWrapRef.current
    if (!el) return
    const apply = () => setTableBodyY(Math.max(el.clientHeight - 100, 160))
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // 起点（待办）状态：transitions 里只作为 from 出现、从不作为 to 出现的入度 0 状态
  const firstSteps = useMemo(() => {
    const tos = new Set(transitions.map((t) => t.to))
    return [...new Set(transitions.map((t) => t.from))].filter((s) => !tos.has(s))
  }, [transitions])

  // 状态三分类：已完成优先按 last_steps 终态、待办按入度 0 起点；元数据缺失时降级关键词判断；
  // task 无 workflow 接口，按写死三态归类（t 为工单类型，来自每条数据的 _type）
  const bucketOf = useCallback(
    (s, t) => {
      if (t === 'task') return s === 'done' ? 'done' : s === 'open' ? 'todo' : 'doing'
      if (lastSteps.length
        ? lastSteps.includes(s)
        : /完成|实现|解决|通过|关闭|上线|done|closed|resolved|reject/i.test(statusMap?.[s] || s)) return 'done'
      if (firstSteps.length
        ? firstSteps.includes(s)
        : /规划|待开始|未开始|open|planning|new/i.test(statusMap?.[s] || s)) return 'todo'
      return 'doing'
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSteps, firstSteps, statusMap],
  )

  // 月度完成规模点：我的工单中「已完成」的，按完成时间（completed）所在月汇总
  // （年视图日历 + 卡片已完成同一口径；无完成时间的终态工单无法归属月份，跳过）
  const monthlyPoints = useMemo(() => {
    const map = {}
    baseItems.forEach((it) => {
      if (bucketOf(it.status, it._type) !== 'done') return // 只算已完成
      const key = String(it.completed || '').slice(0, 7) // YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(key)) return
      map[key] = (map[key] || 0) + pointOf(it)
    })
    return map
  }, [baseItems, bucketOf])

  // 当月 key（YYYY-MM）：卡片「已完成」口径与日历当月高亮共用
  const monthKey = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }, [])

  // 卡片统计（当月口径）：待办/进行中为当前状态全量；已完成只计「本月完成」的工单
  // （与月度日历同一归属规则），条数 + 规模点并列展示
  const cardStats = useMemo(() => {
    const s = { todo: { n: 0, pts: 0 }, doing: { n: 0, pts: 0 }, done: { n: 0, pts: 0 } }
    baseItems.forEach((it) => {
      const b = bucketOf(it.status, it._type)
      const p = pointOf(it)
      if (b === 'todo' || b === 'doing') {
        s[b].n += 1
        s[b].pts += p
      } else if (String(it.completed || '').slice(0, 7) === monthKey) {
        s.done.n += 1
        s.done.pts += p
      }
    })
    return s
  }, [baseItems, bucketOf, monthKey])

  // 客户端过滤链：分类快速筛选 → 关键字（名称/ID 包含，大小写不敏感；bug 名称字段是 title）
  const filtered = useMemo(() => {
    let list = items
    if (bucket !== 'all') list = list.filter((it) => bucketOf(it.status, it._type) === bucket)
    const q = keyword.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (it) =>
          String(it.name || it.title || '').toLowerCase().includes(q) || String(it.id || '').includes(q),
      )
    }
    return list
  }, [items, bucket, bucketOf, keyword])

  // 已加载工单里实际出现的状态集合（主列表 + 我的全量，后者保证已选状态过滤时
  // 下拉不全缩水成当前一项）
  const usedStatuses = useMemo(() => {
    const set = new Set()
    items.forEach((it) => set.add(it.status))
    baseItems.forEach((it) => set.add(it.status))
    return set
  }, [items, baseItems])

  // 状态筛选下拉：按 待办/进行中/已完成 分组，与顶部卡片同一套分类（选状态时卡片分类自动跟随）。
  // statusMap 是工作流全量配置（含未启用/历史状态），且三类映射可能含相同状态值（如 story/bug
  // 都有 resolved）——只保留数据里实际出现的状态、按值去重，同名不同值时缀类型名区分
  const statusOptions = useMemo(() => {
    const groups = { todo: [], doing: [], done: [] }
    const seen = new Set()
    const list = []
    TYPES.forEach((t) => {
      Object.entries(statusMaps[t.key] || {}).forEach(([value, label]) => {
        if (seen.has(value) || !usedStatuses.has(value)) return
        seen.add(value)
        list.push({ value, label, type: t })
      })
    })
    const dupNames = new Set(list.map((c) => c.label).filter((l, i, a) => a.indexOf(l) !== i))
    list.forEach((c) => {
      groups[bucketOf(c.value, c.type.key)].push({
        value: c.value,
        label: dupNames.has(c.label) ? `${c.label}（${c.type.label}）` : c.label,
      })
    })
    return [
      { label: '待办', options: groups.todo },
      { label: '进行中', options: groups.doing },
      { label: '已完成', options: groups.done },
    ].filter((g) => g.options.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusMaps, bucketOf, usedStatuses])

  // 状态值所属的工单类型（选中状态让卡片分类跟随时用；映射缺失时返回 undefined 走关键词兜底）
  const typeOfStatus = useCallback(
    (v) => TYPES.find((t) => statusMaps[t.key]?.[v] !== undefined)?.key,
    [statusMaps],
  )

  const columns = useMemo(
    () => [
      {
        title: '类型',
        dataIndex: '_type',
        width: 92,
        // 优先级并进本列（原独立列已删）：圆形字母徽标 + 类型 Tag 并排展示
        render: (t, r) => {
          const color = t === 'story' ? '#69b1ff' : t === 'bug' ? '#ff7875' : '#95de64'
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <PriorityDot priority={r.priority} />
              <Tag bordered={false} style={{ marginInlineEnd: 0, background: `${color}1f`, color }}>
                {TYPES.find((x) => x.key === t)?.label || t}
              </Tag>
            </span>
          )
        },
      },
      {
        title: '名称',
        dataIndex: 'name',
        // bug 实体的名称字段是 title（story/task 是 name），两边都兜；
        // hover 显示「复制标题 / 分享（复制工单链接）」小按钮（.tapd-name-acts 控制显隐）
        render: (name, r) => {
          const title = name || r.title || ''
          const copyText = async (text, tip) => {
            const res = await window.api.shell.copy(text)
            if (res?.ok) message.success(tip)
          }
          return (
            <div className="tapd-name-cell" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <Tooltip placement="topLeft" title={title}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title}
                </span>
              </Tooltip>
              <span className="tapd-name-acts" style={{ display: 'inline-flex', gap: 2, flex: 'none' }}>
                <Tooltip title="复制标题">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined style={{ fontSize: 12 }} />}
                    style={{ height: 20, width: 20, padding: 0, color: 'rgba(255,255,255,0.45)' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      copyText(title, '标题已复制')
                    }}
                  />
                </Tooltip>
                <Tooltip title="分享（复制工单链接）">
                  <Button
                    type="text"
                    size="small"
                    icon={<ShareAltOutlined style={{ fontSize: 12 }} />}
                    style={{ height: 20, width: 20, padding: 0, color: 'rgba(255,255,255,0.45)' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (r._url) copyText(r._url, '工单链接已复制')
                      else message.warning('该工单暂无链接')
                    }}
                  />
                </Tooltip>
              </span>
            </div>
          )
        },
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 110,
        // 状态 Tag 即流转入口（原「操作」列已移除）：点击弹流转窗，行点击开详情互不干扰
        render: (s, r) => (
          <StatusTag
            status={s}
            cn={statusMap?.[s]}
            className="tapd-status-flow"
            title="点击流转状态"
            onClick={(e) => {
              e.stopPropagation()
              setFlowItem(r)
            }}
          />
        ),
      },
      {
        title: '处理人',
        dataIndex: 'owner',
        width: 150,
        ellipsis: true,
        render: (owner) => String(owner || '').split(';').filter(Boolean).join('、') || '-',
      },
      { title: '规模点', key: 'point', width: 76, render: (_, r) => pointOf(r) || '-' },
      {
        title: '截止/完成时间',
        key: 'due',
        width: 150,
        ellipsis: true,
        // 优先截止时间（story/task 为 due，bug 为 deadline），没有则显示完成时间（绿色），都没有才显示 -
        // 截止时间：未完成且已过期标红、3 天内到期标橙
        render: (_, r) => {
          const due = dueOf(r)
          if (!due) {
            if (!r.completed) return <Text type="secondary">-</Text>
            return (
              <Tooltip title="完成时间">
                <span style={{ color: '#95de64' }}>{String(r.completed).slice(0, 16)}</span>
              </Tooltip>
            )
          }
          const ts = new Date(String(due).replace(' ', 'T')).getTime()
          const days = Number.isFinite(ts) ? (ts - Date.now()) / 86_400_000 : null
          const overdue = days !== null && days < 0 && !r.completed
          const soon = days !== null && days >= 0 && days <= 3 && !r.completed
          return (
            <Tooltip title={overdue ? `已逾期 ${Math.max(1, Math.ceil(-days))} 天` : String(due)}>
              <span style={{ color: overdue ? '#ff7875' : soon ? '#ffa940' : 'rgba(255,255,255,0.7)' }}>
                {String(due).slice(0, 16)}
                {overdue ? ' · 逾期' : ''}
              </span>
            </Tooltip>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusMap],
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        // 内嵌主窗口：高度撑满内容区（壳层容器已定高），不再是独立窗口的 100vh
        height: '100%',
        background: '#0d0d0f',
        color: 'rgba(255,255,255,0.88)',
      }}
    >
      {/* 富文本/流转动效样式（抽成 TapdStyles 与主窗口的工单抽屉共用） */}
      <TapdStyles />

      {/* 顶栏：标题 + 项目名 + 当前账号 + 缓存时间 + 凭据设置 + 刷新（页面切换在左侧栏） */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Text strong style={{ fontSize: 15 }}>
          TAPD 工单
        </Text>
        {wsName && (
          <Tag bordered={false} style={{ marginInlineEnd: 0, background: 'rgba(22,119,255,0.15)', color: '#69b1ff' }}>
            {wsName}
            {workspaceId ? ` · ${workspaceId}` : ''}
          </Tag>
        )}
        {myName && (
          <Tooltip title="当前账号（只看我的按此过滤）">
            <Tag bordered={false} style={{ marginInlineEnd: 0, background: 'rgba(82,196,26,0.12)', color: '#95de64' }}>
              {myName}
            </Tag>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        {savedAt && !loading && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            数据缓存于 {timeAgo(savedAt)}
          </Text>
        )}
        <Button icon={<SettingOutlined />} onClick={() => setAuthOpen(true)}>
          凭据设置
        </Button>
        <Tooltip title="清缓存重新拉取最新工单（流转后自动刷新）">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
            刷新
          </Button>
        </Tooltip>
      </div>

      {/* 凭据缺失提示（关闭凭据弹窗后仍在，方便重新打开） */}
      {needAuth && (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '12px 16px 0' }}
          message="尚未配置 TAPD 访问令牌"
          description="在 TAPD「个人设置 → 个人访问令牌」里创建后粘贴到「凭据设置」即可。"
          action={
            <Button size="small" type="primary" onClick={() => setAuthOpen(true)}>
              去配置
            </Button>
          }
        />
      )}

      {/* 未配置项目引导（换项目在「凭据设置」里改 workspace_id） */}
      {!workspaceId && !loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description="尚未设置 TAPD 项目（workspace_id）">
            <Button type="primary" onClick={() => setAuthOpen(true)}>
              打开凭据设置
            </Button>
          </Empty>
        </div>
      )}

      {workspaceId && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* 左列：统计卡片 + Tab + 过滤 + 表格 */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '0 0 16px 16px' }}>
          {/* 统计卡片（当月口径，我的工单、不随筛选变化）：待办/进行中=当前状态全量，已完成=本月完成。
              点击卡片筛选表格并清掉具体状态筛选（两者同维度，卡片优先） */}
          <Tooltip title="统计口径：我的工单（已完成只计本月完成的），不随筛选变化；点击卡片会重置状态筛选" placement="right">
            <Text type="secondary" style={{ fontSize: 12, display: 'inline-block', marginTop: 10 }}>
              我的工单 · 当月总览
            </Text>
          </Tooltip>
          {/* 「全部」跨满第一行作总览横幅，待办/进行中/已完成均分第二行：内容全部居中 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: '6px 0' }}>
            {BUCKETS.map((b) => {
              const total = cardStats.todo.n + cardStats.doing.n + cardStats.done.n
              const st =
                b.key === 'all'
                  ? { n: total, pts: cardStats.todo.pts + cardStats.doing.pts + cardStats.done.pts }
                  : cardStats[b.key]
              const sel = bucket === b.key
              return (
                <div
                  key={b.key}
                  className="tapd-stat-card"
                  onClick={() => {
                    setBucket(b.key)
                    setStatusFilter(undefined) // 卡片与状态筛选同维度：点卡片即以卡片为准
                  }}
                  style={{
                    gridColumn: b.key === 'all' ? '1 / -1' : undefined,
                    position: 'relative',
                    overflow: 'hidden',
                    padding: b.key === 'all' ? '12px 16px' : '12px 10px',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'center',
                    background: sel ? `${b.color}14` : 'rgba(255,255,255,0.035)',
                    border: `1px solid ${sel ? `${b.color}99` : 'rgba(255,255,255,0.08)'}`,
                    boxShadow: sel ? `0 4px 16px ${b.color}1f` : 'none',
                  }}
                >
                  {/* 顶部状态色柔光：给数字一层氛围底色 */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 48,
                      background: `radial-gradient(64% 100% at 50% 0%, ${b.color}1f, transparent 72%)`,
                      pointerEvents: 'none',
                    }}
                  />
                  {b.key === 'all' ? (
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 10 }}>
                      <span style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.25, color: b.color }}>{st.n}</span>
                      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
                        全部工单 · {fmtPoint(st.pts)} 点
                      </span>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: b.color }} />
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
                          {b.key === 'done' ? '已完成(本月)' : b.label}
                        </span>
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.25, color: b.color }}>
                        {st.n}
                        <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.4)', marginLeft: 3 }}>条</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{fmtPoint(st.pts)} 点</div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          <Space wrap style={{ marginBottom: 8, marginTop: 8 }}>
            <Tooltip
              title={myName ? `服务端按处理人（${myName}）过滤` : '尚未获取到账号信息，需先在「凭据设置」配置有效令牌'}
            >
              <span>
                <Select
                  size="small"
                  style={{ width: 110 }}
                  value={onlyMine ? 'mine' : 'all'}
                  onChange={(v) => {
                    const nv = v === 'mine'
                    setOnlyMine(nv)
                    localStorage.setItem('tapd:onlyMine', nv ? '1' : '0')
                  }}
                  disabled={!myName}
                  options={[
                    { value: 'mine', label: '只看我的' },
                    { value: 'all', label: '全部工单' },
                  ]}
                />
              </span>
            </Tooltip>
            <Select
              style={{ width: 170 }}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v)
                // 选中具体状态时，卡片分类自动跟随该状态所属的 待办/进行中/已完成（按状态所属类型判定）
                if (v) setBucket(bucketOf(v, typeOfStatus(v)))
              }}
              options={statusOptions}
              loading={loading && !statusMap}
              placeholder="状态过滤（全部）"
              allowClear
              showSearch
              optionFilterProp="label"
            />
            <Input.Search
              style={{ width: 210 }}
              placeholder="迭代 ID 过滤（回车生效）"
              allowClear
              value={iterationInput}
              onChange={(e) => {
                setIterationInput(e.target.value)
                if (!e.target.value) setIterationId('') // 清空立即取消过滤
              }}
              onSearch={(v) => setIterationId(String(v || '').trim())}
            />
            <Input
              style={{ width: 220 }}
              prefix={<SearchOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />}
              placeholder="关键字过滤名称 / ID（本地）"
              allowClear
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {total} 条 · 已加载 {items.length} 条
              {(bucket !== 'all' || keyword.trim()) && filtered.length !== items.length
                ? ` · 命中 ${filtered.length} 条`
                : ''}
            </Text>
          </Space>
          {/* 表格体内部滚动（scroll.y 按容器实测高度），分页固定在滚动区外不随内容滚走 */}
          <div ref={tableWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <Table
              size="small"
              rowKey="id"
              loading={loading}
              columns={columns}
              dataSource={filtered}
              scroll={{ x: 740, y: tableBodyY }}
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 条` }}
              locale={{ emptyText: loading ? '加载中…' : '暂无工单' }}
              onRow={(record) => ({
                onClick: () => setDetailItem(record),
                style: { cursor: 'pointer' },
              })}
            />
          </div>
          </div>

          {/* 右列：状态分布饼图 + 月度完成规模点日历（口径同卡片：我的工单、不随筛选变化） */}
          <div
            style={{
              width: 288,
              flex: 'none',
              borderLeft: '1px solid rgba(255,255,255,0.08)',
              padding: '14px 14px 18px',
              overflowY: 'auto',
            }}
          >
            <Text strong style={{ fontSize: 13 }}>
              状态分布
            </Text>
            <StatusPie items={baseItems} statusMap={statusMap} />

            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                margin: '10px 0 8px',
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(22,119,255,0.08)',
                border: '1px solid rgba(22,119,255,0.25)',
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                本月完成
              </Text>
              <Text style={{ color: '#69b1ff', fontSize: 20, fontWeight: 700 }}>
                {fmtPoint(monthlyPoints[monthKey] || 0)}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                点 · {cardStats.done.n} 条
              </Text>
            </div>

            <Text strong style={{ fontSize: 13, display: 'block', margin: '10px 0 8px' }}>
              月度完成规模点
            </Text>
            <PointsCalendar monthlyPoints={monthlyPoints} currentMonthKey={monthKey} />

            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 10 }}>
              口径：我的工单，仅统计已完成，按完成时间所在月汇总
            </Text>
          </div>
        </div>
      )}

      <TapdAuthModal
        open={authOpen}
        config={config}
        onClose={() => setAuthOpen(false)}
        onSaved={(cfg) => {
          setConfig(cfg)
          setAuthOpen(false)
          // 保存凭据后重新过「三连检」的后两步：拉账号（「只看我的」依赖 users/info 的 name）
          // → 检查网页登录态（未登录弹引导）→ 都就绪才加载列表
          ;(async () => {
            const u = await window.api.tapd.user()
            if (u.ok && u.data?.name) setMyName(u.data.name)
            const lg = await window.api.tapd.checkLogin()
            const loggedIn = !!(lg.ok && lg.data?.loggedIn)
            setWebLogin(loggedIn)
            if (!loggedIn) {
              setLoginGuideOpen(true)
              return
            }
            startLoading(cfg)
          })()
        }}
        onWebLoginChange={setWebLogin}
      />
      <LoginGuideModal
        open={loginGuideOpen}
        onDone={(ok) => {
          setLoginGuideOpen(false)
          setWebLogin(!!ok)
          // 登录成功或主动跳过都放行列表加载（未登录仅影响图片显示）
          startLoading(config)
        }}
      />
      <DetailDrawer
        open={!!detailItem}
        item={detailItem}
        type={detailItem?._type || 'story'}
        statusMap={statusMap}
        workspaceId={workspaceId}
        myName={myName}
        webLogin={webLogin}
        onWebLogin={setWebLogin}
        onClose={() => setDetailItem(null)}
        onFlow={(it) => setFlowItem(it)}
      />
      <FlowModal
        open={!!flowItem}
        item={flowItem}
        type={flowItem?._type || 'story'}
        statusMap={statusMap}
        transitions={transitionsByType[flowItem?._type] || []}
        members={members}
        workspaceId={workspaceId}
        myName={myName}
        onClose={() => setFlowItem(null)}
        onDone={() => {
          setFlowItem(null)
          setDetailItem(null) // 详情数据已过时，一并关闭（load(true) 后重新点开）
          load(true) // core 已清缓存，force 重拉立即生效
        }}
      />
    </div>
  )
}
