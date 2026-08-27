// 编辑器中枢：nodes/edges 状态 + 自动保存（防抖 1.2s）+ 运行控制 + 四路推送消费
// （节点状态高亮写回 node.data.status / 日志 / 结果 / 变量快照）。画布细节在 FlowCanvas，配置在 ConfigDrawer。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  CaretRightOutlined,
  LoginOutlined,
  DownloadOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react'
import ModulePanel from './ModulePanel.jsx'
import FlowCanvas from './FlowCanvas.jsx'
import ConfigDrawer from './ConfigDrawer.jsx'
import BottomPanel from './BottomPanel.jsx'
import { MODULES, collectVariableOptions, requiredMissing } from './constants.js'
import { INK, MAT } from './theme.js'

const AUTOSAVE_DELAY = 1200
const MAX_LOGS = 500
const EMPTY_VIEWPORT = { x: 0, y: 0, zoom: 1 }

/** 保存前剥离运行态字段（status/summary/error/iteration 是主进程推送的临时高亮，不落盘）。 */
function cleanNodes(nodes) {
  return nodes.map((n) => {
    const { status, summary, error, iteration, ...data } = n.data || {}
    return { ...n, data, selected: undefined }
  })
}

/** 连线同理：选中态（selected）不落盘，否则重开项目时连线自带高亮和 ✕ 按钮。 */
function cleanEdges(edges) {
  return edges.map(({ selected, ...e }) => e)
}

function EditorInner({ projectId, onBack }) {
  const { message, modal } = AntdApp.useApp()
  const { fitView } = useReactFlow()
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedId, setSelectedId] = useState(null)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState([])
  const [rows, setRows] = useState([])
  const [table, setTable] = useState(null) // 表格快照 { columns, rows }：导入表格读入、表格编辑写入时实时推送
  const [vars, setVars] = useState(null) // 变量快照（null=还没跑过；{} 已起跑，随提取/拦截/表格行变化实时更新）
  const [panelMode, setPanelMode] = useState('normal') // 控制台三档：collapsed | normal | expanded
  const [panelHeight, setPanelHeight] = useState(230) // 常规档高度（顶缘拖拽调）
  const [saveState, setSaveState] = useState('saved') // saved | dirty | saving
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  // 「打开窗口」：勾选后 webpage 模块打开网址时显示执行窗口（默认隐藏跑）；偏好跨会话记住
  const [showWindow, setShowWindow] = useState(() => localStorage.getItem('crawler:showWindow') === '1')

  const viewportRef = useRef(EMPTY_VIEWPORT)
  const loadedViewportRef = useRef(null) // 初始 viewport（RF defaultViewport 只在挂载时生效）
  const nameRef = useRef('')
  const saveTimerRef = useRef(null)
  const stateRef = useRef({ nodes: [], edges: [] })

  nameRef.current = name
  stateRef.current = { nodes, edges }

  /* -------- 加载项目 -------- */
  useEffect(() => {
    let alive = true
    ; (async () => {
      const res = await window.api.crawler.get(projectId)
      if (!alive) return
      if (!res.ok) {
        message.error(res.error || '项目加载失败')
        onBack()
        return
      }
      const graph = res.data.graph || {}
      setNodes(graph.nodes || [])
      // 老项目连线没存过 type，补上 'crawler'（自定义连线：悬停 ✕ 删除）；RF 的
      // defaultEdgeOptions 只作用于 onConnect 新连线，救不了已落盘数据
      setEdges((graph.edges || []).map((e) => (e.type ? e : { ...e, type: 'crawler' })))
      setName(res.data.name)
      loadedViewportRef.current = graph.viewport || null
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [projectId])

  /* -------- 保存 -------- */
  const doSave = useCallback(async () => {
    const graph = { nodes: cleanNodes(stateRef.current.nodes), edges: cleanEdges(stateRef.current.edges), viewport: viewportRef.current }
    setSaveState('saving')
    const res = await window.api.crawler.save({ id: projectId, name: nameRef.current, graph })
    if (!res.ok) {
      message.error(res.error || '保存失败')
      setSaveState('dirty')
      return
    }
    setSaveState('saved')
  }, [projectId])

  // 自动保存：nodes/edges/name 变更后防抖落盘（加载阶段跳过）
  useEffect(() => {
    if (loading) return
    setSaveState('dirty')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(doSave, AUTOSAVE_DELAY)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [nodes, edges, name, loading, doSave])

  // 离开编辑器时冲掉未落盘的防抖保存
  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        const graph = { nodes: cleanNodes(stateRef.current.nodes), edges: cleanEdges(stateRef.current.edges), viewport: viewportRef.current }
        window.api.crawler.save({ id: projectId, name: nameRef.current, graph })
      }
    },
    [projectId],
  )

  /* -------- 运行与推送消费 -------- */
  const run = async () => {
    const graph = { nodes: cleanNodes(nodes), edges: cleanEdges(edges), viewport: viewportRef.current }
    setLogs([])
    setRows([])
    setTable(null)
    setVars(null) // 起跑清空，等主进程推第一份快照（runCrawler 起步即推空表）
    setNodes((nds) =>
      nds.map((n) => ({ ...n, data: { ...n.data, status: undefined, summary: undefined, error: undefined, iteration: undefined } })),
    )
    const res = await window.api.crawler.run({ id: projectId, graph, showWindow })
    if (!res.ok) return message.error(res.error || '启动失败')
    setRunning(true)
  }

  const stop = async () => {
    await window.api.crawler.stop()
  }

  useEffect(() => {
    const offLog = window.api.crawler.onLog((p) => {
      if (p.projectId !== projectId) return
      setLogs((prev) => {
        const next = [...prev, p]
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
      })
    })
    const offNode = window.api.crawler.onNode((p) => {
      if (p.projectId !== projectId) return
      setNodes((nds) =>
        nds.map((n) =>
          n.id === p.nodeId
            ? { ...n, data: { ...n.data, status: p.status, summary: p.summary, error: p.error, iteration: p.iteration } }
            : n,
        ),
      )
    })
    const offRun = window.api.crawler.onRun((p) => {
      if (p.projectId !== projectId) return
      if (p.status !== 'running') {
        setRunning(false)
        // 停止/失败时正在执行的节点不会再收到自己的终态事件，清掉转圈残留——
        // 否则画布上节点永远亮着蓝呼吸灯，看着像「还在等」
        setNodes((nds) =>
          nds.map((n) => (n.data.status === 'running' ? { ...n, data: { ...n.data, status: undefined } } : n)),
        )
        if (Array.isArray(p.rows)) setRows(p.rows)
        if (p.table) setTable(p.table)
        if (p.status === 'failed') message.error(`执行失败：${p.error || '未知错误'}`)
        else if (p.status === 'stopped') message.warning('任务已停止')
        else if (p.status === 'done') {
          const parts = []
          if (p.rows?.length) parts.push(`提取 ${p.rows.length} 行`)
          if (p.table?.rows?.length) parts.push(`表格 ${p.table.rows.length} 行`)
          message.success(`执行完成${parts.length ? `，${parts.join('，')}` : ''}`)
        }
      }
    })
    // 变量快照：主进程每次变量变化全量推（渲染层直接整体替换，无需合并）
    const offVars = window.api.crawler.onVars((p) => {
      if (p.projectId !== projectId) return
      setVars(p.vars || {})
    })
    // 表格快照：导入表格读入、表格编辑每次写入后全量推（控制台「表格」Tab 随跑随看）
    const offTable = window.api.crawler.onTable((p) => {
      if (p.projectId !== projectId) return
      setTable(p.table || null)
    })
    return () => {
      offLog()
      offNode()
      offRun()
      offVars()
      offTable()
    }
  }, [projectId])

  /* -------- 画布交互 -------- */
  const onAddNode = useCallback((type, position) => {
    const meta = MODULES[type]
    const id = crypto.randomUUID()
    setNodes((nds) =>
      nds.concat([{ id, type, position, data: { ...meta.defaultData() }, style: { width: 220 } }]),
    )
    setSelectedId(id) // 新节点直接打开配置抽屉
  }, [setNodes])

  /**
   * 一键整理布局：最长路分层（起点=第 0 层，层 = max(前驱层)+1；环上的回环边不抬层，
   * DFS 在途节点即回环目标），层内按现有上下顺序排——正向流程左→右一条线，回环连线
   * 由 CrawlerEdge 自动从下方绕行。手动微调后重按一次即可重新整理。
   */
  const arrange = useCallback(() => {
    if (nodes.length === 0) return
    const out = new Map(nodes.map((n) => [n.id, []]))
    const indeg = new Map(nodes.map((n) => [n.id, 0]))
    const byId = new Set(nodes.map((n) => n.id))
    for (const e of edges) {
      if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
      out.get(e.source).push(e.target)
      indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
    }
    const layer = new Map()
    const onPath = new Set()
    const dfs = (id, dep) => {
      if (onPath.has(id)) return // 回环边：目标还在展开路径上，不抬层（否则 A→B→A 会把起点顶高）
      if ((layer.get(id) ?? -1) >= dep) return // 已排到更深层的路径，剪枝
      layer.set(id, dep)
      onPath.add(id)
      for (const t of out.get(id)) dfs(t, dep + 1)
      onPath.delete(id)
    }
    for (const n of nodes) if ((indeg.get(n.id) || 0) === 0) dfs(n.id, 0)
    for (const n of nodes) if (!layer.has(n.id)) dfs(n.id, 0) // 纯环簇：当独立起点重排

    const layers = new Map()
    for (const n of nodes) {
      const l = layer.get(n.id) ?? 0
      if (!layers.has(l)) layers.set(l, [])
      layers.get(l).push(n)
    }
    const COL = 330 // 节点宽 220 + 横向间距
    const ROW = 150 // 行高：节点 ~90 + 纵向间距
    const pos = new Map()
    for (const [l, arr] of layers) {
      arr.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0)) // 层内保留用户上下顺序
      arr.forEach((n, i) => pos.set(n.id, { x: l * COL, y: i * ROW }))
    }
    setNodes((nds) => nds.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id) } : n)))
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 60)
  }, [nodes, edges, setNodes, fitView])

  // 逻辑判断节点的连线带上「是/否」标签（sourceHandle 由 React Flow 从连接点自动带出）；
  // type: 'crawler' = 自定义连线（悬停 ✕ 删除），与加载路径保持一致
  const onConnect = useCallback(
    (params) => {
      const src = stateRef.current.nodes.find((n) => n.id === params.source)
      const label =
        src?.type === 'condition' ? (params.sourceHandle === 'no' ? '否' : '是') : undefined
      setEdges((eds) =>
        addEdge(
          label
            ? { ...params, id: crypto.randomUUID(), type: 'crawler', label, labelStyle: { fill: 'rgba(255,255,255,0.75)', fontSize: 11 } }
            : { ...params, id: crypto.randomUUID(), type: 'crawler' },
          eds,
        ),
      )
    },
    [setEdges],
  )

  const onDataPatch = useCallback(
    (nodeId, fields) => setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...fields } } : n))),
    [setNodes],
  )

  // 删除二次确认（React Flow 的 onBeforeDelete）：节点右上 🗑、连线悬停 ✕ 与 Delete 键
  // 删选中都走这里；只删连线不打扰。resolve(false) 则整个删除动作取消。
  const confirmDelete = useCallback(
    ({ nodes: delNodes }) => {
      if (!delNodes.length) return true
      const names = delNodes.map((n) => `「${n.data?.label || MODULES[n.type]?.name || n.type}」`).join('、')
      return new Promise((resolve) => {
        modal.confirm({
          title: `确定删除 ${delNodes.length > 1 ? `这 ${delNodes.length} 个模块` : '该模块'}？`,
          content: `${names} 与其相连的连线会一并删除，不可恢复。`,
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
    },
    [modal],
  )

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId])

  // 已定义变量的下拉数据源：画布静态定义（拦截/提取/表格列/当前项）+ 上次运行的变量快照
  // 下钻（跑过一次后能直接选到 接口数据.list 这类真实嵌套路径）
  const variableOptions = useMemo(() => collectVariableOptions(nodes, vars), [nodes, vars])

  /* -------- 必填校验：任一模块缺必填 → 运行禁用 + 对应节点红色闪烁 -------- */
  // invalidMap 纯派生：展示层把缺失文案写进 data.invalid 交给 CrawlerNode，不进 nodes state
  // （autosave 走 stateRef 原始数据，天然不被运行态/校验态污染）
  const invalidMap = useMemo(() => {
    const m = {}
    for (const n of nodes) {
      const miss = requiredMissing(n)
      if (miss) m[n.id] = miss
    }
    return m
  }, [nodes])
  const invalidCount = Object.keys(invalidMap).length
  // 登录窗口的默认地址：画布第一个「打开网页」模块的网址（没放则按钮禁用）
  const loginUrl = useMemo(
    () => String(nodes.find((n) => n.type === 'webpage')?.data?.url || '').trim(),
    [nodes],
  )
  const displayNodes = useMemo(
    () =>
      invalidCount === 0
        ? nodes
        : nodes.map((n) => (invalidMap[n.id] ? { ...n, data: { ...n.data, invalid: invalidMap[n.id] } } : n)),
    [nodes, invalidMap, invalidCount],
  )

  /* -------- 顶栏动作 -------- */
  const doExport = async () => {
    // 先冲保存，导出的才是最新画布
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      await doSave()
    }
    const res = await window.api.crawler.exportGraph(projectId)
    if (res.canceled) return
    if (res.ok) message.success(`已导出：${res.path}`)
    else message.error(res.error || '导出失败')
  }

  const doSaveAs = async () => {
    const newName = saveAsName.trim() || `${name} 副本`
    const graph = { nodes: cleanNodes(nodes), edges: cleanEdges(edges), viewport: viewportRef.current }
    const res = await window.api.crawler.saveAs({ name: newName, graph })
    if (!res.ok) return message.error(res.error || '另存失败')
    setSaveAsOpen(false)
    message.success(`已另存为「${newName}」`)
    onBack() // 回列表（新项目已在列表里，避免同画布双开编辑互相覆盖）
  }

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin tip="加载项目…" />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 画布动画集中定义（CrawlerNode 按 animation 名引用）：必填缺失红色闪烁 + 运行态蓝色呼吸 */}
      <style>{`
        @keyframes crawler-invalid-blink {
          0%, 100% { border-color: #ff453a; box-shadow: 0 0 0 3px rgba(255,69,58,0.28), 0 0 16px rgba(255,69,58,0.32); }
          50% { border-color: rgba(255,69,58,0.3); box-shadow: 0 0 0 3px rgba(255,69,58,0.05); }
        }
        @keyframes crawler-run-breath {
          0%, 100% { box-shadow: 0 0 0 3px rgba(10,132,255,0.22), 0 0 18px rgba(10,132,255,0.24), 0 1px 2px rgba(0,0,0,0.4), 0 6px 20px rgba(0,0,0,0.32); }
          50% { box-shadow: 0 0 0 3px rgba(10,132,255,0.08), 0 0 8px rgba(10,132,255,0.1), 0 1px 2px rgba(0,0,0,0.4), 0 6px 20px rgba(0,0,0,0.32); }
        }
      `}</style>
      {/* 顶栏：毛玻璃工具条 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 14px',
          borderBottom: `1px solid ${MAT.line}`,
          background: MAT.bar,
          backdropFilter: MAT.blur,
          WebkitBackdropFilter: MAT.blur,
          flexShrink: 0,
        }}
      >
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          variant="borderless"
          maxLength={50}
          style={{ maxWidth: 260, fontSize: 15, fontWeight: 600, letterSpacing: '-0.2px', color: INK[1] }}
          placeholder="项目名称"
        />
        {running && <Tag color="processing" style={{ borderRadius: 999 }}>运行中</Tag>}
        <div style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: saveState === 'saved' ? '#30d158' : saveState === 'saving' ? '#ff9f0a' : 'rgba(255,255,255,0.3)',
              boxShadow: saveState === 'saving' ? '0 0 6px rgba(255,159,10,0.6)' : 'none',
            }}
          />
          {saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : '已自动保存'}
        </span>
        <Space size={8}>
          <Tooltip title="立即保存到本地">
            <Button icon={<SaveOutlined />} onClick={doSave} disabled={saveState === 'saved'}>
              保存
            </Button>
          </Tooltip>
          <Button
            icon={<DownloadOutlined />}
            onClick={() => {
              setSaveAsName(`${name} 副本`)
              setSaveAsOpen(true)
            }}
          >
            另存为
          </Button>
          <Button icon={<DownloadOutlined />} onClick={doExport}>
            导出画布
          </Button>
          <Tooltip title="按执行方向分层重排节点（起点最左、后继逐层向右），回环连线自动从下方绕行，流程一目了然">
            <Button icon={<ApartmentOutlined />} onClick={arrange}>
              整理布局
            </Button>
          </Tooltip>
          <Tooltip
            title={
              loginUrl
                ? `打开登录窗口：${loginUrl}（与执行窗口共用登录态，登录一次即可）`
                : '画布上先放一个「打开网页」模块，即可在这里登录目标网站'
            }
          >
            <span>
              <Button icon={<LoginOutlined />} disabled={!loginUrl} onClick={() => window.api.crawler.openLogin(loginUrl)}>
                登录
              </Button>
            </span>
          </Tooltip>
          {running ? (
            <Button danger icon={<StopOutlined />} onClick={stop}>
              停止
            </Button>
          ) : (
            <Tooltip
              title={invalidCount > 0 ? `还有 ${invalidCount} 个模块必填项未配置完整（画布上红色闪烁的节点），补全后可运行` : undefined}
            >
              {/* span 包一层：antd Button disabled 不触发 Tooltip */}
              <span>
                <Button
                  type="primary"
                  icon={<CaretRightOutlined />}
                  onClick={run}
                  disabled={invalidCount > 0}
                  style={{ borderRadius: 8, boxShadow: '0 4px 14px rgba(10,132,255,0.35)' }}
                >
                  运行
                </Button>
              </span>
            </Tooltip>
          )}
        </Space>
      </div>

      {/* 三栏：模块面板 + 画布（+抽屉） */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ModulePanel />
        <FlowCanvas
          nodes={displayNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          onAddNode={onAddNode}
          onBeforeDelete={confirmDelete}
          defaultViewport={loadedViewportRef.current || undefined}
          onMoveEnd={(_, vp) => (viewportRef.current = vp)}
        />
        <ConfigDrawer
          node={selectedNode}
          open={!!selectedNode}
          onClose={() => setSelectedId(null)}
          onDataPatch={onDataPatch}
          variableOptions={variableOptions}
        />
      </div>

      <BottomPanel
        logs={logs}
        rows={rows}
        table={table}
        vars={vars}
        running={running}
        showWindow={showWindow}
        onShowWindowChange={(v) => {
          setShowWindow(v)
          localStorage.setItem('crawler:showWindow', v ? '1' : '0')
        }}
        mode={panelMode}
        height={panelHeight}
        onToggle={() => setPanelMode((m) => (m === 'collapsed' ? 'normal' : 'collapsed'))}
        onExpand={() => setPanelMode((m) => (m === 'expanded' ? 'normal' : 'expanded'))}
        onResize={(h) => {
          setPanelHeight(h)
          setPanelMode('normal') // 从最大化拖拽：切回常规档并承接当前像素高度
        }}
      />

      <Modal
        title="另存为新项目"
        open={saveAsOpen}
        onOk={doSaveAs}
        onCancel={() => setSaveAsOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          autoFocus
          value={saveAsName}
          onChange={(e) => setSaveAsName(e.target.value)}
          onPressEnter={doSaveAs}
          maxLength={50}
          placeholder="新项目名称"
        />
      </Modal>
    </div>
  )
}

export default function Editor(props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  )
}
