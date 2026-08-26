// 底部控制台：抽屉式三档高度——收起（36px 细条，整条点击展开）/ 常规（默认 230px，
// 顶缘手柄可拖拽调高）/ 最大化（78vh 大视野看日志）。Tab：日志（实时、级别着色、
// 上限 500 条）+ 结果（提取数据）+ 变量（当前变量快照，随提取/接口拦截/表格行切换
// 实时更新）+ 表格（导入表格模块跑完的整表，含编辑列）。Tab 栏右侧「打开窗口」开关：
// 勾选后运行到「网页」模块打开网址时显示执行浏览器窗口（默认隐藏执行）。
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Space, Switch, Tabs, Tag, Tooltip, Typography } from 'antd'
import { DownOutlined, FullscreenExitOutlined, FullscreenOutlined, UpOutlined } from '@ant-design/icons'
import ResultsPanel from './ResultsPanel.jsx'

const { Text } = Typography

const COLLAPSED_H = 36
const MIN_H = 140

const LEVEL_COLOR = {
  info: 'rgba(255,255,255,0.55)',
  success: '#95de64',
  warn: '#ffc069',
  error: '#ff7875',
}

const fmtTs = (ts) => {
  const d = new Date(ts || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function LogList({ logs }) {
  const boxRef = useRef(null)
  // 新日志自动滚到底（用户往上翻历史时不打扰：距底 <80px 才跟随）
  useEffect(() => {
    const el = boxRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  return (
    <div ref={boxRef} style={{ height: '100%', overflowY: 'auto', padding: '6px 10px', fontSize: 12, lineHeight: 1.9 }}>
      {logs.length === 0 && <Text type="secondary">运行日志会实时输出到这里</Text>}
      {logs.map((l) => (
        <div key={l.seq} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
            {fmtTs(l.ts)}
          </Text>
          <span style={{ color: LEVEL_COLOR[l.level] || LEVEL_COLOR.info, wordBreak: 'break-all' }}>{l.message}</span>
        </div>
      ))}
    </div>
  )
}

// 变量值展示：对象/数组 JSON 化，超长截断（接口拦截的响应体可能非常大，完整值悬停 title 可看前 2000 字符）
function fmtVar(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

function VarsList({ vars }) {
  const entries = useMemo(() => Object.entries(vars || {}), [vars])
  if (vars === null) return <Text type="secondary">运行后，变量会在这里实时显示（提取 / 接口拦截 / 表格行切换都会更新）</Text>
  if (entries.length === 0) return <Text type="secondary">暂无变量：「提取」「接口拦截」模块运行后会写入变量</Text>
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '6px 10px', fontSize: 12, lineHeight: 1.9 }}>
      {entries.map(([k, v]) => {
        const raw = typeof v === 'string' ? v : JSON.stringify(v)
        return (
          <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ color: '#ffa940', fontFamily: 'ui-monospace, Menlo, monospace', flexShrink: 0 }}>{k}</span>
            <span
              title={raw?.length > 2000 ? `${raw.slice(0, 2000)}…` : raw}
              style={{ color: 'rgba(255,255,255,0.78)', fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' }}
            >
              {fmtVar(v)}
            </span>
          </div>
        )
      })}
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
        borderTop: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(13,13,15,0.75)',
        transition: dragging ? 'none' : 'height 0.2s',
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
        <div style={{ flex: 1, minHeight: 0, padding: '0 8px' }}>
          <Tabs
            size="small"
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
                children: <LogList logs={logs} />,
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
                      emptyText="「导入表格」模块跑完后，整张表格（含编辑模块写入的列）会显示在这里"
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
