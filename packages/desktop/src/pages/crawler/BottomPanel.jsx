// 底部控制台：抽屉式三档高度——收起（36px 细条，整条点击展开）/ 常规（默认 230px，
// 顶缘手柄可拖拽调高）/ 最大化（78vh 大视野看日志）。Tab：日志（实时、时间/级别徽标/
// 模块徽标/正文四段行结构，级别整行淡染，上限 500 条）+ 结果（提取数据）+ 变量（当前
// 变量快照，随提取/接口拦截/表格行切换实时更新；点击变量弹窗看完整内容——结构树点
// key 复制 {{变量.路径}} 引用、格式化 JSON 全文）+ 表格（导入表格模块跑完的整表，含
// 编辑列）。Tab 栏右侧「打开窗口」开关：勾选后运行到「网页」模块打开网址时显示执行
// 浏览器窗口（默认隐藏执行）。
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, Badge, Button, Modal, Space, Switch, Tabs, Tag, Tooltip, Typography } from 'antd'
import {
  CopyOutlined,
  DownOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LoadingOutlined,
  CheckCircleFilled,
  RightOutlined,
  UpOutlined,
} from '@ant-design/icons'
import ResultsPanel from './ResultsPanel.jsx'
import { MODULES } from './constants.js'
import { ACCENT, EASE, INK, MAT, MONO, STATUS } from './theme.js'

const { Text } = Typography

const COLLAPSED_H = 36
const MIN_H = 140

// 日志级别元数据：徽标文案/徽标底色/整行淡染底色/正文色（warn·error 整行染色，异常一眼扫到）
const LEVEL_META = {
  info: { text: '信息', color: 'rgba(255,255,255,0.55)', chipBg: 'rgba(255,255,255,0.08)', bg: 'transparent', msg: 'rgba(255,255,255,0.78)' },
  success: { text: '成功', color: STATUS.success, chipBg: 'rgba(48,209,88,0.14)', bg: 'rgba(48,209,88,0.07)', msg: 'rgba(255,255,255,0.85)' },
  warn: { text: '警告', color: '#ffd60a', chipBg: 'rgba(255,214,10,0.12)', bg: 'rgba(255,214,10,0.07)', msg: '#ffd60a' },
  error: { text: '错误', color: STATUS.failed, chipBg: 'rgba(255,69,58,0.16)', bg: 'rgba(255,69,58,0.1)', msg: STATUS.failed },
}

// Tabs 改 macOS 分段控件样式：去 ink-bar 下划线，活动段浅白填充圆角，
// 非活动段弱化文字；作用域挂在 .crawler-console-tabs 下避免外泄
const CONSOLE_TABS_CSS = `
.crawler-console-tabs .ant-tabs-nav { margin: 10px 12px 0 !important; }
.crawler-console-tabs .ant-tabs-nav::before { display: none !important; }
.crawler-console-tabs .ant-tabs-tab {
  margin: 0 1px !important;
  padding: 4px 12px !important;
  border-radius: 8px;
  transition: background 0.2s ${EASE}, color 0.2s ${EASE};
}
.crawler-console-tabs .ant-tabs-tab:first-child { margin-left: 0 !important; }
.crawler-console-tabs .ant-tabs-tab:hover { color: rgba(255,255,255,0.85) !important; }
.crawler-console-tabs .ant-tabs-tab .ant-tabs-tab-btn { font-size: 12px; color: ${INK[2]}; }
.crawler-console-tabs .ant-tabs-tab-active { background: rgba(255,255,255,0.1); }
.crawler-console-tabs .ant-tabs-tab-active .ant-tabs-tab-btn { color: rgba(255,255,255,0.95) !important; font-weight: 600; }
.crawler-console-tabs .ant-tabs-ink-bar { display: none !important; }
.crawler-console-tabs .ant-tabs-extra-content { margin-right: 8px; margin-left: 10px; }
/* 高度链：Tabs 根 → 内容仓 → 面板逐层撑满，内层 overflowY:auto 才拿得到有界高度，
   日志/结果/变量/表格四个 Tab 才能各自竖向滚动（否则内容被外层裁掉、不出现滚动条） */
.crawler-console-tabs { height: 100%; display: flex; flex-direction: column; }
.crawler-console-tabs .ant-tabs-nav { flex: 0 0 auto; }
.crawler-console-tabs .ant-tabs-content-holder { flex: 1 1 auto; min-height: 0; }
.crawler-console-tabs .ant-tabs-content,
.crawler-console-tabs .ant-tabs-tabpane { height: 100%; }
`

const fmtTs = (ts) => {
  const d = new Date(ts || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 单条日志行：时间 → 级别徽标 → 模块徽标（图标+节点名，模块色）→ 正文。
 * warn/error/success 整行淡染；与日志关联的模块由主进程随日志推送 nodeType/nodeLabel。
 * 循环明细弹窗里的行也复用本渲染。
 */
function LogRow({ l }) {
  const lv = LEVEL_META[l.level] || LEVEL_META.info
  const meta = MODULES[l.nodeType]
  const Icon = meta?.icon
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 8px', borderRadius: 6, background: lv.bg }}>
      <span style={{ fontSize: 11, fontFamily: MONO, color: INK[3], flexShrink: 0 }}>{fmtTs(l.ts)}</span>
      <span
        style={{ flexShrink: 0, width: 36, textAlign: 'center', fontSize: 10.5, lineHeight: '16px', borderRadius: 4, color: lv.color, background: lv.chipBg }}
      >
        {lv.text}
      </span>
      {meta && (
        <span
          title={l.nodeLabel || meta.name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
            maxWidth: 150,
            padding: '0 7px',
            fontSize: 10.5,
            lineHeight: '16px',
            borderRadius: 4,
            color: meta.color,
            background: `${meta.color}1a`,
          }}
        >
          {Icon && <Icon style={{ fontSize: 10 }} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {l.nodeLabel || meta.name}
          </span>
        </span>
      )}
      <span style={{ color: lv.msg, wordBreak: 'break-all' }}>{l.message}</span>
    </div>
  )
}

/**
 * 循环聚合行：环状转圈（运行中）+ 当前循环项数据，覆盖更新不往下叠；完成后变绿勾。
 * 点击打开弹窗查看本循环的逐条明细日志。
 */
function LoopAggRow({ l, running, onClick }) {
  const meta = MODULES.loop
  const Icon = meta?.icon
  const done = l.agg?.done || !running
  return (
    <div
      onClick={onClick}
      title="点击查看本循环的逐条日志"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: 'rgba(255,255,255,0.035)',
      }}
    >
      <span style={{ fontSize: 11, fontFamily: MONO, color: INK[3], flexShrink: 0 }}>{fmtTs(l.ts)}</span>
      {done ? (
        <CheckCircleFilled style={{ fontSize: 12, color: STATUS.success, flexShrink: 0 }} />
      ) : (
        <LoadingOutlined spin style={{ fontSize: 12, color: STATUS.running, flexShrink: 0 }} />
      )}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          maxWidth: 150,
          padding: '0 7px',
          fontSize: 10.5,
          lineHeight: '16px',
          borderRadius: 4,
          color: meta.color,
          background: `${meta.color}1a`,
        }}
      >
        {Icon && <Icon style={{ fontSize: 10 }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {l.agg?.label || '数据循环'}
        </span>
      </span>
      {l.agg?.iteration && (
        <span style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO, color: INK[2] }}>
          {l.agg.iteration.row}/{l.agg.iteration.total}
        </span>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: MONO,
          fontSize: 11.5,
          color: 'rgba(255,255,255,0.72)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {l.agg?.item || ''}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10.5, color: INK[3] }}>{l.details?.length || 0} 条</span>
      <RightOutlined style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
    </div>
  )
}

/** 循环明细弹窗：逐条展示聚合行里攒下的日志（超上限时只保留最近 2000 条）。 */
function LoopDetailModal({ row, running, onClose }) {
  const bodyRef = useRef(null)
  const details = row.details || []
  // 新明细自动滚到底（用户往上翻历史时不打扰）
  useEffect(() => {
    const el = bodyRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [details.length])
  const done = row.agg?.done || !running
  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={760}
      title={
        <span style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {done ? (
            <CheckCircleFilled style={{ fontSize: 13, color: STATUS.success }} />
          ) : (
            <LoadingOutlined spin style={{ fontSize: 13, color: STATUS.running }} />
          )}
          循环「{row.agg?.label || '数据循环'}」逐条日志 · {details.length} 条
        </span>
      }
      styles={{ body: { height: '64vh', overflow: 'hidden', paddingTop: 4 } }}
    >
      <div ref={bodyRef} style={{ height: '100%', overflowY: 'auto', padding: '4px 8px', fontSize: 12, lineHeight: 1.7 }}>
        {details.length === 0 && <Text type="secondary">暂无明细</Text>}
        {details.map((d) => (
          <LogRow key={d.seq} l={d} />
        ))}
      </div>
    </Modal>
  )
}

/**
 * 日志列表：普通行逐条排；循环聚合行按 aggKey 去重、覆盖更新（转圈环 + 当前项数据）。
 * running=false 时所有聚合行的转圈停住（运行结束统一收口）。
 */
function LogList({ logs, running }) {
  const boxRef = useRef(null)
  const [viewingKey, setViewingKey] = useState(null)
  // 新日志自动滚到底（用户往上翻历史时不打扰：距底 <80px 才跟随）
  useEffect(() => {
    const el = boxRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  const viewing = viewingKey ? logs.find((l) => l.aggKey === viewingKey) : null

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '6px 10px 10px', fontSize: 12, lineHeight: 1.7 }} ref={boxRef}>
      {logs.length === 0 && <Text type="secondary">运行日志会实时输出到这里</Text>}
      {logs.map((l) =>
        l.aggKey ? (
          <LoopAggRow key={l.aggKey} l={l} running={running} onClick={() => setViewingKey(l.aggKey)} />
        ) : (
          <LogRow key={l.seq} l={l} />
        ),
      )}
      {viewing && <LoopDetailModal row={viewing} running={running} onClose={() => setViewingKey(null)} />}
    </div>
  )
}

// 变量值单行预览：对象/数组 JSON 化，超长截断（完整内容点击行弹窗查看）
function fmtVar(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

const varToString = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))

// 剪贴板：优先异步 API，不可用时降级 execCommand
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

// 叶子值预览：字符串绿 / 数字蓝 / 布尔·null 橙（Apple 暗色系统色），超长单行截断
function LeafValue({ value }) {
  const text = varToString(value)
  const color = typeof value === 'string' ? STATUS.success : typeof value === 'number' ? '#64d2ff' : ACCENT
  return <span style={{ color, fontFamily: MONO, wordBreak: 'break-all' }}>{text.length > 160 ? `${text.slice(0, 160)}…` : text}</span>
}

/** 结构树子项每页渲染数：大响应先渲染前 50 项，「加载更多」按需铺开，防 DOM 一次撑爆。 */
const TREE_PAGE = 50

/**
 * JSON 结构树节点：分支可折叠（默认展开前 2 层）。行点击复制 {{变量.路径}} 引用——
 * 路径段拼接与主进程 lookupVar 的下钻规则一致（对象键 / 数组下标均可）；
 * 折叠箭头单独点击只展开不复制。
 */
function TreeNode({ varName, path, label, value, depth, onCopyRef }) {
  const isBranch = value !== null && typeof value === 'object'
  const isArray = Array.isArray(value)
  const [open, setOpen] = useState(depth < 2)
  const [shown, setShown] = useState(TREE_PAGE)
  const entries = isBranch ? (isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value)) : []
  const ref = `{{${[varName, ...path].join('.')}}}`
  const isIndex = isArray && /^\d+$/.test(label)
  return (
    <div>
      <div
        onClick={() => onCopyRef(ref)}
        title={`点击复制引用 ${ref}，粘贴到后续模块即可取该值`}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingLeft: depth * 16, paddingRight: 4, cursor: 'pointer', lineHeight: 1.8, borderRadius: 4 }}
      >
        {isBranch ? (
          <span
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
            title={open ? '折叠' : '展开'}
            // 高度钉在一行文本的行高上（内部再垂直居中）：后面的值折成多少行，
            // 箭头都贴着 key 所在的第一行，不会跟着整行居中漂移
            style={{ flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', height: '1.8em', padding: '0 3px 0 0', margin: '0 -3px 0 0' }}
          >
            <RightOutlined style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
          </span>
        ) : (
          <span style={{ width: 9, flexShrink: 0, height: '1.8em' }} />
        )}
        <span style={{ color: isIndex ? 'rgba(255,255,255,0.35)' : ACCENT, fontFamily: MONO, flexShrink: 0 }}>{label}:</span>
        {isBranch ? (
          // 收起时不铺内容预览（长 JSON 挤成一行太乱），只给项数提示；点行照样复制引用
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, flexShrink: 0 }}>
            {entries.length === 0 ? (isArray ? '[ ]' : '{ }') : isArray ? `[${entries.length} 项]` : `{${entries.length} 个键}`}
          </span>
        ) : (
          <LeafValue value={value} />
        )}
      </div>
      {isBranch && open && (
        <div>
          {entries.slice(0, shown).map(([k, v]) => (
            <TreeNode key={k} varName={varName} path={[...path, k]} label={k} value={v} depth={depth + 1} onCopyRef={onCopyRef} />
          ))}
          {entries.length > shown && (
            <Button size="small" type="link" style={{ paddingLeft: (depth + 1) * 16, height: 22 }} onClick={() => setShown(shown + 200)}>
              还有 {entries.length - shown} 项，加载更多
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 变量完整内容弹窗：结构树（点击 key 复制 {{变量.路径}} 引用）+ 格式化 JSON 全文两个 Tab。
 * value 优先取 vars 里的实时值（运行中拦截/换行更新时弹窗内容跟着变），变量已被清掉时用打开时的快照。
 */
function VarValueModal({ viewing, liveValue, onClose }) {
  const { message } = App.useApp()
  if (!viewing) return null
  const value = liveValue !== undefined ? liveValue : viewing.value
  const name = viewing.name
  let pretty
  try {
    pretty = value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : varToString(value)
  } catch {
    pretty = varToString(value)
  }
  const wholeRef = `{{${name}}}`
  const copy = async (text, tip) => {
    if (await copyText(text)) message.success(tip)
    else message.error('复制失败，请手动选择复制')
  }
  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={780}
      title={
        <span style={{ fontSize: 14 }}>
          变量 <span style={{ color: ACCENT, fontFamily: MONO }}>{name}</span> · 完整内容
        </span>
      }
      styles={{ body: { height: '68vh', overflow: 'hidden', paddingTop: 4 } }}
    >
      <Tabs
        size="small"
        tabBarExtraContent={{
          right: (
            <Space size={4}>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copy(wholeRef, `已复制引用 ${wholeRef}`)}>
                复制引用
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copy(pretty, '已复制格式化 JSON')}>
                复制 JSON
              </Button>
            </Space>
          ),
        }}
        items={[
          {
            key: 'tree',
            label: '结构树（点 key 复制引用）',
            children: (
              <div style={{ height: 'calc(68vh - 56px)', overflowY: 'auto', fontSize: 12 }}>
                <TreeNode
                  varName={name}
                  path={[]}
                  label={name}
                  value={value}
                  depth={0}
                  onCopyRef={(ref) => copy(ref, `已复制 ${ref}，可粘贴到后续模块取该值`)}
                />
              </div>
            ),
          },
          {
            key: 'json',
            label: '格式化 JSON',
            children: (
              <pre
                style={{ height: 'calc(68vh - 56px)', overflowY: 'auto', margin: 0, fontSize: 12, lineHeight: 1.7, color: 'rgba(255,255,255,0.82)', fontFamily: MONO, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {pretty}
              </pre>
            ),
          },
        ]}
      />
    </Modal>
  )
}

function VarsList({ vars }) {
  const [viewing, setViewing] = useState(null)
  const entries = useMemo(() => Object.entries(vars || {}), [vars])
  if (vars === null) return <Text type="secondary">运行后，变量会在这里实时显示（提取 / 接口拦截 / 表格行切换都会更新）</Text>
  if (entries.length === 0) return <Text type="secondary">暂无变量：「提取」「接口拦截」模块运行后会写入变量</Text>
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '6px 10px', fontSize: 12, lineHeight: 1.9 }}>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
        点击变量看完整内容；后续模块用 {'{{变量名.字段.下标}}'} 取内部值
      </Text>
      {entries.map(([k, v]) => (
        <div
          key={k}
          onClick={() => setViewing({ name: k, value: v })}
          title="点击查看完整内容"
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', cursor: 'pointer', padding: '0 6px', borderRadius: 6 }}
        >
          <span style={{ color: ACCENT, fontFamily: MONO, flexShrink: 0 }}>{k}</span>
          <span style={{ color: 'rgba(255,255,255,0.78)', fontFamily: MONO, wordBreak: 'break-all' }}>{fmtVar(v)}</span>
          <RightOutlined style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
        </div>
      ))}
      <VarValueModal viewing={viewing} liveValue={viewing ? vars?.[viewing.name] : undefined} onClose={() => setViewing(null)} />
    </div>
  )
}

export default function BottomPanel({
  logs,
  rows,
  table,
  vars,
  running,
  showWindow,
  onShowWindowChange,
  mode = 'normal',
  height = 230,
  onToggle,
  onExpand,
  onResize,
}) {
  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs])
  const panelRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  // 顶缘拖拽调高：从面板当前像素高度起算（最大化状态拖拽会切回常规档并承接当前高度）
  const startDrag = (e) => {
    if (mode === 'collapsed') return
    e.preventDefault()
    const startY = e.clientY
    const startH = panelRef.current?.getBoundingClientRect().height || height
    const maxH = Math.max(MIN_H + 60, window.innerHeight - 140) // 给顶栏和画布留最小空间
    setDragging(true)
    const move = (ev) => onResize(Math.min(Math.max(startH - (ev.clientY - startY), MIN_H), maxH))
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pxHeight = mode === 'collapsed' ? COLLAPSED_H : mode === 'expanded' ? '78vh' : height

  return (
    <div
      ref={panelRef}
      style={{
        height: pxHeight,
        flexShrink: 0,
        borderTop: `1px solid ${MAT.line}`,
        background: MAT.bar,
        backdropFilter: MAT.blur,
        WebkitBackdropFilter: MAT.blur,
        transition: dragging ? 'none' : `height 0.28s ${EASE}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {mode !== 'collapsed' && (
        <div
          title="拖拽调整高度，双击最大化 / 还原"
          onPointerDown={startDrag}
          onDoubleClick={onExpand}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 5, cursor: 'row-resize', zIndex: 10 }}
        />
      )}
      {mode === 'collapsed' ? (
        <div
          onClick={onToggle}
          title="展开控制台"
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer' }}
        >
          <UpOutlined style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }} />
          <Text style={{ fontSize: 12 }}>控制台</Text>
          {running && <Badge status="processing" />}
          {errorCount > 0 && (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              {errorCount} 错误
            </Tag>
          )}
          {logs.length > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {logs.length} 条日志
            </Text>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, padding: '0 4px' }}>
          <style>{CONSOLE_TABS_CSS}</style>
          <Tabs
            size="small"
            className="crawler-console-tabs"
            tabBarExtraContent={{
              right: (
                <Space size={0}>
                  {/* 「打开窗口」：运行中锁死（本次运行参数已定，下次运行生效） */}
                  <Tooltip title="勾选后，运行到「网页」模块打开网址时会显示执行浏览器窗口（默认隐藏执行）。本次运行中不可切换。">
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        color: 'rgba(255,255,255,0.65)',
                        marginRight: 6,
                        cursor: running ? 'not-allowed' : 'default',
                      }}
                    >
                      打开窗口
                      <Switch size="small" checked={showWindow} disabled={running} onChange={onShowWindowChange} />
                    </span>
                  </Tooltip>
                  <Button
                    type="text"
                    size="small"
                    icon={mode === 'expanded' ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                    onClick={onExpand}
                    title={mode === 'expanded' ? '还原' : '最大化'}
                  />
                  <Button type="text" size="small" icon={<DownOutlined />} onClick={onToggle} title="收起" />
                </Space>
              ),
            }}
            items={[
              {
                key: 'logs',
                label: (
                  <span>
                    日志
                    {running && <Badge status="processing" style={{ marginLeft: 6 }} />}
                    {errorCount > 0 && (
                      <Tag color="red" style={{ marginLeft: 6, marginRight: 0 }}>
                        {errorCount}
                      </Tag>
                    )}
                  </span>
                ),
                children: <LogList logs={logs} running={running} />,
              },
              {
                key: 'results',
                label: <span>结果{rows.length > 0 && <Tag color="green" style={{ marginLeft: 6, marginRight: 0 }}>{rows.length} 行</Tag>}</span>,
                children: (
                  <div style={{ height: 'calc(100% - 10px)', overflowY: 'auto' }}>
                    <ResultsPanel rows={rows} emptyText="运行后提取的数据会显示在这里" />
                  </div>
                ),
              },
              {
                key: 'vars',
                label: (
                  <span>
                    变量
                    {vars && Object.keys(vars).length > 0 && (
                      <Tag color="geekblue" style={{ marginLeft: 6, marginRight: 0 }}>
                        {Object.keys(vars).length} 个
                      </Tag>
                    )}
                  </span>
                ),
                children: <VarsList vars={vars} />,
              },
              {
                key: 'table',
                label: (
                  <span>
                    表格
                    {table?.rows?.length > 0 && (
                      <Tag color="magenta" style={{ marginLeft: 6, marginRight: 0 }}>
                        {table.rows.length} 行
                      </Tag>
                    )}
                  </span>
                ),
                children: (
                  <div style={{ height: 'calc(100% - 10px)', overflowY: 'auto' }}>
                    <ResultsPanel
                      rows={table?.rows || []}
                      columns={table?.columns}
                      emptyText="表格数据实时显示在这里：「导入表格」的整表；循环遍历表格行时「表格编辑」直接写当前行，其余场景自动建表新行"
                    />
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}
