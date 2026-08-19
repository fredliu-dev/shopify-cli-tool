/**
 * 文件引用关系图独立窗口页（echarts graph）。
 *
 * 由仓库卡片「引用图」按钮经 IPC repos:openDepGraph 打开，URL 形如：
 *   index.html#/dep-graph?dir=<仓库路径>&name=<仓库名>
 * 数据走 repos:depGraph（默认读缓存，秒开）；「重新扫描」force 重扫覆盖缓存。
 * 顶栏支持文件名模糊搜索（fzf 风格子序列匹配，如 hro 命中 hero.liquid），选中后高亮定位节点。
 */
import { Alert, App, AutoComplete, Button, Descriptions, Empty, Progress, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// echarts 按需注册：只用关系图（graph）+ 图例/提示 + canvas 渲染，减小打包体积
echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])

const { Text } = Typography

// 节点分类（按主题目录）与配色：legend 与圆点颜色同源
const DEP_DIR_META = [
  { key: 'layout', color: '#fa8c16' },
  { key: 'templates', color: '#4096ff' },
  { key: 'sections', color: '#9254de' },
  { key: 'snippets', color: '#13c2c2' },
  { key: 'assets', color: '#52c41a' },
]

// 节点 id / path（仓库相对路径）取首段即所属主题目录；path 缺失（旧缓存）时回退 id
const depDirOf = (id = '') => (id.includes('/') ? id.slice(0, id.indexOf('/')) : id)

// 关系图限制说明（静态扫描的边界），侧栏常驻展示
const DEP_LIMITS = [
  "只识别字面量引用：{% render 'x' %} / include / section / sections 标签、asset_url 过滤器、CSS 的 @import 与 url()；用变量或拼接出来的动态引用（如 {% render name %}）无法识别，图中会缺失。",
  'JSON 模板与 section 分组只取 sections.<key>.type 指向的 section 文件；其中 blocks[].type 是区块类型、不指向具体文件，不计入引用。',
  '翻译（locales 的 t 过滤器）与 settings_schema / settings_data 按「键」引用而非文件级引用，不进入关系图；JS 文件之间的 import 依赖同样不在扫描范围。',
  '图只包含 layout / templates / sections / snippets / assets 目录内的主题文件；引用了但当前分支磁盘上不存在的文件不会出现（计入「不存在的引用」统计）。',
  '箭头方向固定为「被引用文件 → 引用它的文件」；数据来自最近一次扫描并缓存，切换分支或修改文件后请点「重新扫描」更新。',
]

// 缓存时间的人类可读描述（刚刚 / n 分钟前 / n 小时前 / 具体日期时间）
function depTimeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString()
}

/**
 * fzf 风格子序列模糊匹配：query 各字符按顺序出现在目标即命中（大小写不敏感，支持跳字）。
 * 如 hro 命中 hero.liquid、ic 命中 icon-cart.liquid。
 */
function fuzzyMatch(query, target) {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let i = 0
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) i++
  }
  return i === q.length
}

/**
 * 搜索匹配（两档），候选列表与图过滤共用同一结果：
 * 1) 优先「输入连续出现」在文件名或路径里（大小写不敏感）—— 搜 index.json 只命中 index.json，
 *    不会把 index-list.json 这种跳字匹配的文件带出来；
 * 2) 一个包含命中都没有时，才退化为子序列模糊（hro → hero.liquid）。
 */
function matchNodes(nodes, q) {
  const s = q.toLowerCase()
  const contains = nodes.filter((n) => n.name.toLowerCase().includes(s) || n.id.toLowerCase().includes(s))
  if (contains.length) return contains
  return nodes.filter((n) => fuzzyMatch(q, n.name) || fuzzyMatch(q, n.id))
}

// 解析 #/dep-graph?dir=...&name=... 的启动参数
function parseDepParams() {
  const h = window.location.hash.replace(/^#/, '')
  if (!h.startsWith('/dep-graph')) return { dir: '', name: '' }
  const p = new URLSearchParams(h.split('?')[1] || '')
  return { dir: p.get('dir') || '', name: p.get('name') || '' }
}

/** 组装 echarts 节点：name 用完整路径保证唯一（links 按名字关联），label 经 formatter 显示文件名。 */
function buildChartNodes(data) {
  const catIndex = new Map(DEP_DIR_META.map((d, i) => [d.key, i]))
  return data.nodes.map((n) => ({
    name: n.id,
    fileName: n.name,
    path: n.path || n.id, // 旧缓存节点没有 path，回退 id（同为仓库相对路径）
    desc: n.desc,
    refIn: n.refIn || 0,
    refOut: n.refOut || 0,
    category: catIndex.get(depDirOf(n.id)) ?? 0,
    symbolSize: 9 + Math.min(15, (n.refIn || 0) * 1.5), // 被引用越多圆点越大
  }))
}

// 每个 chart 实例的辅助状态：最近送入的数据（用于按 dataIndex 反查节点名）、
// 节点坐标缓存（按名字，过滤增删节点后恢复时不跳位）
const lastSentData = new WeakMap()
const nodePosCache = new WeakMap()

/** 读当前图内各节点布局坐标（name → [x,y]）；读不到/未就绪（NaN）的跳过。 */
function livePositions(chart) {
  const out = new Map()
  try {
    const nodes = chart.getModel().getSeriesByIndex(0)?.getGraph()?.nodes
    const last = lastSentData.get(chart) || []
    if (!nodes?.length) return out
    nodes.forEach((n) => {
      const l = (typeof n.getLayout === 'function' ? n.getLayout() : n.layout) || []
      const name = last[n.dataIndex]?.name
      if (name && Number.isFinite(l[0]) && Number.isFinite(l[1])) out.set(name, [l[0], l[1]])
    })
  } catch {
    /* 读不到就当没有 */
  }
  return out
}

/**
 * 全量重设 series 数据，三件事一起做：
 * 1) 搜索过滤：未命中（含一跳关联）的节点/边直接从图里移除 —— 不能用透明占位，
 *    graph 节点的 per-item silent 不生效，透明节点照样会被 hover 出 tooltip；
 * 2) 命中节点标签加粗，与仅为「关联」保留的邻居区分；清空搜索恢复全部；
 * 3) 坐标固化：setOption 的 data 是整体替换，坐标按名字缓存后每次带上，
 *    过滤/恢复/拖拽后节点都不跳位。
 * freeze=true 时同时把布局切成 none（初始力导向排布完成后冻结：拖拽不被弹回、不触发全场重收敛）。
 */
function applySeries(chart, data, keep, match, freeze = false) {
  let cache = nodePosCache.get(chart)
  if (!cache) {
    cache = new Map()
    nodePosCache.set(chart, cache)
  }
  for (const [name, p] of livePositions(chart)) cache.set(name, p)

  const dataArray = buildChartNodes(data)
    .filter((n) => !keep || keep.has(n.name))
    .map((n) => {
      const item = { ...n, label: { fontWeight: match?.has(n.name) ? 600 : 400 } }
      const p = cache.get(n.name)
      if (p) {
        item.x = p[0]
        item.y = p[1]
      }
      return item
    })
  const links = keep ? data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) : data.edges

  lastSentData.set(chart, dataArray)
  chart.setOption({ series: [{ ...(freeze ? { layout: 'none' } : {}), data: dataArray, links }] })
}

export default function DepGraphPage() {
  const { message } = App.useApp()
  const [params] = useState(parseDepParams)
  const [data, setData] = useState(null) // { nodes, edges, stats, missing, savedAt }
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(null) // { current, total } 扫描进度
  const [empty, setEmpty] = useState(false) // 非主题仓库（无主题目录）
  const [sel, setSel] = useState(null) // 点击/搜索选中的节点（侧栏详情）
  const [search, setSearch] = useState('')
  const chartDivRef = useRef(null)
  const chartRef = useRef(null) // 供搜索选中时 dispatchAction 高亮
  const lastHighlightRef = useRef(null) // 上一个高亮节点（切换前先 downplay）
  const searchMatchRef = useRef(null) // 当前搜索命中的节点 id 集合（冻结布局时也要带上）

  const stats = data?.stats || {}

  // 窗口标题 = 仓库名（原生标题主进程已设；同步页面 title 防被 React 入口的默认标题覆盖）
  useEffect(() => {
    if (params.name) document.title = params.name
  }, [params.name])

  // 加载数据：force=false 读缓存（无则扫描），force=true 清缓存重扫；进度按 dir 过滤
  const load = useCallback(
    async (force = false) => {
      if (!params.dir) return
      setLoading(true)
      setProgress(null)
      setEmpty(false)
      const off = window.api.repos.onDepGraphProgress((p) => {
        if (p?.dir === params.dir && p.stage === 'parse') setProgress({ current: p.current, total: p.total })
      })
      try {
        const res = await window.api.repos.depGraph({ dir: params.dir, force })
        if (!res.ok) {
          message.error(res.error || '扫描失败')
          return
        }
        if (!res.data?.nodes?.length) {
          setEmpty(true)
          setData(null)
          return
        }
        setData({ ...res.data, savedAt: res.savedAt })
        setSel(null)
      } finally {
        off?.()
        setLoading(false)
        setProgress(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.dir],
  )

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // 渲染关系图：数据变化（首次打开/重新扫描）时重建。
  // 力导向只负责初始排布（layoutAnimation:false 一次性算完，避免大图节点乱飞好几秒）；
  // 排布完成（finished）即冻结为 layout:none —— 之后拖拽节点停在哪就是哪，不被模拟弹回。
  useEffect(() => {
    if (!data?.nodes?.length) return
    const el = chartDivRef.current
    if (!el) return
    // useDirtyRect:false —— 全帧重绘：快速悬停切换强调态时，脏矩形增量渲染偶发漏重绘，
    // 表现为部分线「消失」；图规模不大，全帧重绘的代价可以接受
    const chart = echarts.init(el, null, { useDirtyRect: false })
    chartRef.current = chart
    const chartNodes = buildChartNodes(data)
    const fileNameOf = {}
    chartNodes.forEach((n) => {
      fileNameOf[n.name] = n.fileName
    })
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        confine: true,
        textStyle: { fontSize: 12 },
        formatter: (p) =>
          p.dataType === 'edge'
            ? `${fileNameOf[p.data.target] ?? p.data.target} 引用了 ${fileNameOf[p.data.source] ?? p.data.source}`
            : `${p.data.fileName}<br/><span style="opacity:.65">${p.data.path}</span>`,
      },
      legend: [
        {
          top: 0,
          data: DEP_DIR_META.map((d) => d.key),
          textStyle: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },
        },
      ],
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          categories: DEP_DIR_META.map((d) => ({ name: d.key, itemStyle: { color: d.color } })),
          data: chartNodes,
          links: data.edges, // source=被引用文件 → target=引用它的文件（箭头指向引用方）
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 7,
          lineStyle: { color: 'source', curveness: 0.15, opacity: 0.45, width: 1.2 },
          label: {
            show: true,
            position: 'right',
            distance: 3,
            color: 'rgba(255,255,255,0.82)',
            fontSize: 10,
            formatter: (p) => p.data.fileName,
          },
          // 不用 focus:'adjacency'：悬停节点时其余线会被打入 blur 态近乎消失，
          // 快速在不同圆点间移动时该状态偶发不恢复，表现为「线不见了」；
          // 悬停只放大节点本身、加粗压着的线，其余画面保持原样
          emphasis: { scale: 1.3, lineStyle: { width: 2.6 } },
          force: { repulsion: 170, edgeLength: [50, 110], gravity: 0.12, layoutAnimation: false },
        },
      ],
    })
    chart.on('click', (p) => {
      if (p.dataType === 'node') setSel(p.data)
    })
    // 登记初始数据，供 livePositions 按 dataIndex 反查节点名（bake 冻结时要读全部坐标）
    lastSentData.set(chart, chartNodes)
    // 力导向排布完成（图表首次空闲）后冻结布局；带上当前搜索过滤状态
    let baked = false
    const onFinished = () => {
      if (baked) return
      baked = true
      applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, true)
    }
    chart.on('finished', onFinished)
    // 窗口缩放时重算画布
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.off('finished', onFinished)
      chart.dispose()
      chartRef.current = null
      lastHighlightRef.current = null
    }
  }, [data])

  // 搜索命中集合 + 一跳关联（它引用的文件 + 引用它的文件）。
  // 只保留命中节点的话，恰好看不到它自己的引用关系 —— 边因为另一端不匹配被滤掉了，
  // 比如搜 index.json 只剩一个孤点；故把直接关联的邻居一并保留（命中节点标签加粗区分）。
  const searchMatch = useMemo(() => {
    const q = search.trim()
    if (!q || !data) return null
    const match = new Set(matchNodes(data.nodes, q).map((n) => n.id))
    const keep = new Set(match)
    for (const e of data.edges) {
      if (match.has(e.target)) keep.add(e.source)
      if (match.has(e.source)) keep.add(e.target)
    }
    return { match, keep }
  }, [search, data])

  // 搜索过滤：输入即过滤，图中保留命中节点及其一跳关联，清空恢复全部
  useEffect(() => {
    searchMatchRef.current = searchMatch
    const chart = chartRef.current
    if (!chart || !data?.nodes?.length) return
    applySeries(chart, data, searchMatch?.keep ?? null, searchMatch?.match ?? null)
  }, [searchMatch, data])

  // 搜索候选：与图过滤共用 matchNodes（完整包含优先，无命中才模糊），短文件名优先，最多 50 条
  const searchOptions = useMemo(() => {
    const q = search.trim()
    if (!q || !data) return []
    return matchNodes(data.nodes, q)
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((n) => ({
        value: n.id,
        node: n,
        label: (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span title={n.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.name}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, flexShrink: 0 }}>{n.dir}</span>
          </div>
        ),
      }))
  }, [search, data])

  // 搜索选中：回填文件名到输入框、侧栏展示详情，并在图上高亮该节点（含邻接，先取消上一个高亮）
  const onSearchSelect = (id) => {
    const node = data?.nodes.find((n) => n.id === id)
    if (!node) return
    setSearch(node.name)
    setSel(node)
    const chart = chartRef.current
    if (chart) {
      try {
        if (lastHighlightRef.current) chart.dispatchAction({ type: 'downplay', seriesIndex: 0, name: lastHighlightRef.current })
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0, name: id })
        lastHighlightRef.current = id
      } catch {
        /* 节点可能刚被重新扫描移除：忽略 */
      }
    }
  }

  const selDir = sel ? depDirOf(sel.path || sel.id) : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0d0f', color: 'rgba(255,255,255,0.88)' }}>
      {/* 顶栏：仓库名 + 统计 + 缓存时间 + 模糊搜索 + 重新扫描 */}
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
          {params.name || '文件引用关系'}
        </Text>
        {!!data && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 <Text strong>{stats.files ?? 0}</Text> 个文件 · <Text strong>{stats.edges ?? 0}</Text> 条引用 · 箭头方向：被引用 → 引用
          </Text>
        )}
        {!!data && stats.missing > 0 && (
          <Tooltip title={(data.missing || []).join('\n')}>
            <Tag color="warning">{stats.missing} 处引用的文件不存在</Tag>
          </Tooltip>
        )}
        {data?.savedAt && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            数据缓存于 {depTimeAgo(data.savedAt)}
          </Text>
        )}
        {searchMatch && (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            已筛选 {searchMatch.match.size}/{stats.files ?? 0} · 关联 {searchMatch.keep.size}
          </Tag>
        )}
        <div style={{ flex: 1 }} />
        <AutoComplete
          style={{ width: 320 }}
          value={search}
          onChange={setSearch}
          onSelect={onSearchSelect}
          options={searchOptions}
          filterOption={false}
          allowClear
          disabled={!data}
          placeholder="搜索文件名（完整匹配优先，无命中才模糊）"
          suffixIcon={<SearchOutlined />}
          notFoundContent={search.trim() ? '无匹配文件' : '输入文件名，如 hro 命中 hero.liquid'}
        />
        <Tooltip title="清除旧缓存，按当前磁盘文件重新扫描">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
            {loading && progress ? `${progress.current}/${progress.total}` : '重新扫描'}
          </Button>
        </Tooltip>
      </div>

      {/* 扫描进度条（仅在扫描中显示；读缓存秒开时不出现） */}
      {loading && progress && (
        <Progress
          percent={Math.round((progress.current / Math.max(1, progress.total)) * 100)}
          size="small"
          showInfo={false}
          style={{ padding: '0 16px', margin: '6px 0 0' }}
        />
      )}

      {/* 主体：左侧关系图 + 右侧详情/限制侧栏 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {empty ? (
            <Empty description="未在该仓库发现 Shopify 主题目录（layout/templates/sections/snippets/assets）">
              <Button type="primary" loading={loading} onClick={() => load(true)}>
                重新扫描
              </Button>
            </Empty>
          ) : !data ? (
            <Space direction="vertical" align="center">
              <Spin />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {progress ? `正在解析文件 ${progress.current}/${progress.total}…` : '正在加载…'}
              </Text>
            </Space>
          ) : (
            <div ref={chartDivRef} style={{ width: '100%', height: '100%' }} />
          )}
          {searchMatch && searchMatch.match.size === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <Text type="secondary">无匹配文件，清空搜索恢复全部</Text>
            </div>
          )}
        </div>

        {/* 侧栏：选中节点详情 + 限制说明 */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            padding: 12,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {sel ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="文件名">
                <Space size={8}>
                  <Text strong>{sel.fileName ?? sel.name}</Text>
                  <Tag style={{ marginInlineEnd: 0 }} color={DEP_DIR_META.find((d) => d.key === selDir)?.color}>
                    {selDir}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="文件路径">
                <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {sel.path || sel.id}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="文件描述">
                {sel.desc ? <Text>{sel.desc}</Text> : <Text type="secondary">（无）</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="引用统计">
                <Text style={{ fontSize: 12 }}>
                  被引用 {sel.refIn ?? 0} 次 · 引用 {sel.refOut ?? 0} 个文件
                </Text>
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              点击圆点或搜索选中文件查看详情；搜索时图中保留匹配的文件及其直接关联（引用/被引用，命中文件标签加粗），清空恢复；圆点越大被引用越多，支持拖拽节点（停在哪就在哪）、滚轮缩放，点图例可隐藏对应目录。
            </Text>
          )}

          <Alert
            type="info"
            showIcon
            message="关系图的限制（静态扫描，仅供参考）"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {DEP_LIMITS.map((t, i) => (
                  <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                    {'一二三四五'[i]}、{t}
                  </li>
                ))}
              </ul>
            }
          />
        </div>
      </div>
    </div>
  )
}
