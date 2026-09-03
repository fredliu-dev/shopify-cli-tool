import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Button, Space, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { switchShellPage } from '../shell-events.js'

const { Text } = Typography

// 类型标签配色与 TAPD 工单页的类型列一致
const TYPE_COLOR = { story: 'geekblue', bug: 'volcano', task: 'cyan' }

// 状态配色：已知状态映射优先，否则按中文名关键词归类（与 TAPD 工单页 colorOf 同规则）
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
}

function statusColorOf(status, cn = '') {
  if (STATUS_COLOR[status]) return STATUS_COLOR[status]
  const s = `${status} ${cn}`.toLowerCase()
  if (/reject|拒绝/.test(s)) return '#ff4d4f'
  if (/完成|实现|解决|通过|关闭|上线|done|closed|resolve/.test(s)) return '#52c41a'
  if (/测试/.test(s)) return '#722ed1'
  if (/进行|开发|progress|develop/.test(s)) return '#1677ff'
  if (/规划|待|未|open|new|plan/.test(s)) return '#faad14'
  return '#8c8c8c'
}

// 状态胶囊（同 Tapd.jsx 的 StatusTag：半透明底 + 同色描边的 pill）
function StatusPill({ status, cn }) {
  const color = statusColorOf(status, cn)
  return (
    <span
      style={{
        padding: '1px 10px',
        borderRadius: 12,
        fontSize: 12,
        lineHeight: '20px',
        background: `${color}1f`,
        color,
        border: `1px solid ${color}55`,
        flexShrink: 0,
      }}
    >
      {cn || status}
    </span>
  )
}

// 手输内容是否像一条工单引用（TAPD 详情链接或纯数字 id），是才走解析
const looksLikeRef = (s) => /^https?:\/\/\S+$/i.test(s) || /^\d{6,}$/.test(s)

/**
 * TAPD 工单选择器：初始化配置里代替手填 project_desc。
 * 值为 { title, url } | null —— title 作为 project_desc，url 为工单链接（写 toml _tapd，供后续回显/带出）。
 * 三种输入路径：下拉选自己的未完成工单（候选 = 当前账号 owner 过滤 + 客户端剔除终态）、
 * 粘贴工单链接、输入工单 ID（后两者由主进程解析后回填标题）。
 * 未配置工单系统（无令牌 / workspace）时不渲染输入框，改为「去登录并配置」按钮打开 TAPD 窗口；
 * 主窗口重新聚焦（用户配置完切回来）或点「重新检测」自动重查。
 *
 * initialUrl：已有工单链接时仅回填链接原文（不自动解析标题），供编辑弹窗等
 * 「只存链接」的场景复用；footerHint 覆盖默认底部说明文案。
 *
 * freeText：值改为纯字符串且受控（配合 Form.Item 的 value/onChange）——手填任意文本合法，
 * 选中/解析工单后回填「标题\n链接」两行文本（本地保存弹窗的 project_desc 用：
 * 保存时 splitDesc 自动把链接拆为 _tapd）。此模式下未配置工单系统仍可手填，只是无下拉候选。
 *
 * titleOnly：在 freeText 行为基础上（纯字符串值 + 可手填），选中/解析工单后只回填工单标题、
 * 不附链接 —— 供「活动名称」这类只要标题的字段（复制线上主题弹窗）复用。
 */
export default function WorkItemSelect({ value, onChange, initialUrl = '', footerHint, freeText = false, titleOnly = false }) {
  // titleOnly 隐含自由文本能力：值同样是纯字符串、未配置工单系统也可手填
  const stringMode = freeText || titleOnly
  const [text, setText] = useState('')
  const [items, setItems] = useState([])
  const [phase, setPhase] = useState('loading') // loading | ready | unconfigured | error
  const [err, setErr] = useState('')
  const [hint, setHint] = useState({ level: 'secondary', text: '' })
  const timer = useRef(null)

  const detect = async (force = false) => {
    setPhase('loading')
    setErr('')
    const cfgRes = await window.api.tapd.loadConfig()
    const cfg = cfgRes.ok ? cfgRes.data : null
    if (!cfg?.token || !cfg?.workspaceId) {
      setPhase('unconfigured')
      return
    }
    const res = await window.api.tapd.myOpenItems({ workspaceId: cfg.workspaceId, force })
    if (res.ok) {
      setItems(res.data || [])
      setPhase('ready')
      return
    }
    if (res.error === 'NO_TAPD_AUTH') {
      setPhase('unconfigured')
      return
    }
    setPhase('error')
    setErr(res.error || '工单列表获取失败')
  }

  useEffect(() => {
    detect()
    return () => timer.current && clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 回填已有链接：输入框只显示链接原文（不解析标题），重新选择/粘贴即覆盖（freeText 模式回显走注入的 value，跳过）
  useEffect(() => {
    if (!freeText && initialUrl) {
      setText(initialUrl)
      setHint({ level: 'secondary', text: '当前已关联的工单链接；重新选择或粘贴新链接可替换' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl])

  // 未配置态：用户去 TAPD 窗口配好令牌/登录后切回主窗口（focus）自动重查
  useEffect(() => {
    if (phase !== 'unconfigured') return
    const onFocus = () => detect(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // 选中后输入框显示的文本（同时也是命中匹配的键）：标题重名时后缀 #id 末 4 位消歧
  const entries = useMemo(() => {
    const seen = new Set()
    return items.map((it) => {
      const display = seen.has(it.title) ? `${it.title} #${it.id.slice(-4)}` : it.title
      seen.add(it.title)
      return { it, display }
    })
  }, [items])

  const options = useMemo(
    () =>
      entries.map(({ it, display }) => ({
        value: display,
        display,
        item: it,
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <StatusPill status={it.status} cn={it.statusCn} />
              <Tag color={TYPE_COLOR[it.type] || 'default'} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                {it.typeCn}
              </Tag>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
            </span>
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, flexShrink: 0 }}>#{it.id.slice(-6)}</span>
          </div>
        ),
      })),
    [entries],
  )

  const onText = (v) => {
    if (timer.current) clearTimeout(timer.current)
    const raw = String(v ?? '')
    setText(raw)
    const trimmed = raw.trim()
    if (!trimmed) {
      onChange?.(stringMode ? '' : null)
      setHint({ level: 'secondary', text: '' })
      return
    }
    // 命中下拉候选（按显示文本 / 链接 / ID 完全匹配）
    const hit = entries.find(({ it, display }) => display === trimmed || it.url === trimmed || String(it.id) === trimmed)
    if (hit) {
      if (stringMode) {
        // freeText：拼「标题\n链接」回填（保存时 splitDesc 拆出 _tapd）；titleOnly：只要标题
        const filled = titleOnly ? hit.it.title : `${hit.it.title}\n${hit.it.url}`
        setText(filled)
        onChange?.(filled)
      } else {
        onChange?.({ title: hit.it.title, url: hit.it.url })
      }
      setHint({ level: 'success', text: `已关联${hit.it.typeCn}：${hit.it.title}` })
      return
    }
    // 手输引用（链接 / ID）：防抖后走主进程解析，成功回填标题
    if (looksLikeRef(trimmed)) {
      setHint({ level: 'secondary', text: '正在解析工单…' })
      timer.current = setTimeout(async () => {
        const cfgRes = await window.api.tapd.loadConfig()
        const res = await window.api.tapd.resolveWorkItem({
          input: trimmed,
          workspaceId: cfgRes.ok ? cfgRes.data?.workspaceId : undefined,
        })
        if (res.ok) {
          if (stringMode) {
            const filled = titleOnly ? res.data.title : `${res.data.title}\n${res.data.url}`
            setText(filled)
            onChange?.(filled)
          } else {
            setText(res.data.title)
            onChange?.({ title: res.data.title, url: res.data.url })
          }
          setHint({ level: 'success', text: `已关联${res.data.typeCn}：${res.data.title}` })
        } else {
          // 自由文本模式允许任意文本，解析失败不清空，保留用户输入
          if (!stringMode) onChange?.(null)
          setHint({ level: 'danger', text: res.error || '未找到该工单' })
        }
      }, 500)
      return
    }
    onChange?.(stringMode ? raw : null)
    setHint({ level: 'secondary', text: '从下拉选择工单，或粘贴工单链接 / 输入工单 ID' })
  }

  // 未配置态只在对象值模式拦住输入：字符串模式（freeText/titleOnly）的字段是必填自由文本，不能没有输入框
  if (phase === 'unconfigured' && !stringMode) {
    return (
      <div>
        <Space>
          <Button type="primary" onClick={() => switchShellPage('tapd')}>
            去登录并配置工单系统
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => detect(true)}>
            重新检测
          </Button>
        </Space>
        <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
          切到左侧 TAPD 工单页完成令牌配置与登录后，回到此处会自动刷新
        </Text>
      </div>
    )
  }

  return (
    <div>
      <AutoComplete
        value={stringMode ? String(value ?? '') : text}
        onChange={onText}
        options={options}
        disabled={phase === 'loading'}
        placeholder={
          phase === 'loading'
            ? '正在检测工单系统配置…'
            : titleOnly
              ? '手填名称，或选择/粘贴工单自动填标题'
              : freeText
                ? '手填标题，或选择/粘贴工单自动填「标题 + 链接」'
                : '选择我的工单，或粘贴工单链接 / 输入工单 ID'
        }
        filterOption={(v, o) => {
          const q = String(v || '').toLowerCase()
          return (
            o.display.toLowerCase().includes(q) ||
            String(o.item.id).includes(q) ||
            o.item.title.toLowerCase().includes(q)
          )
        }}
        notFoundContent={
          phase === 'error' ? '工单列表获取失败' : stringMode && phase === 'unconfigured' ? '未配置工单系统，可手填' : '暂无进行中的工单'
        }
        style={{ width: '100%' }}
      />
      {stringMode && phase === 'unconfigured' ? (
        <Space style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            未配置 TAPD 工单系统：可先手填标题，或
          </Text>
          <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => switchShellPage('tapd')}>
            去配置
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            后从下拉选工单（自动带出标题与链接），配置完成回到此处自动刷新
          </Text>
        </Space>
      ) : phase === 'error' ? (
        <Space style={{ marginTop: 6 }}>
          <Text type="danger" style={{ fontSize: 12 }}>
            {err}
          </Text>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => detect(true)}>
            重试
          </Button>
          <Button size="small" type="text" onClick={() => switchShellPage('tapd')}>
            去检查工单系统配置
          </Button>
        </Space>
      ) : hint.text ? (
        <Text
          type={hint.level === 'danger' ? 'danger' : hint.level === 'success' ? 'success' : 'secondary'}
          style={{ display: 'block', marginTop: 6, fontSize: 12 }}
        >
          {hint.text}
        </Text>
      ) : (
        <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
          {footerHint || '候选为当前账号未完成的工单；选中后工单标题作为 project_desc，链接随配置保存供后续回显'}
        </Text>
      )}
    </div>
  )
}
