/**
 * 文件引用关系图独立窗口页（echarts graph）。
 *
 * 由仓库卡片「引用图」按钮经 IPC repos:openDepGraph 打开，URL 形如：
 *   index.html#/dep-graph?dir=<仓库路径>&name=<仓库名>
 * 数据走 repos:depGraph（默认读缓存，秒开）；「重新扫描」force 重扫覆盖缓存。
 * 顶栏支持文件名模糊搜索（fzf 风格子序列匹配，如 hro 命中 hero.liquid），选中后高亮定位节点。
 * 图铺满整个画布，整体半透明（0.5）：悬停或选中任一文件时，它与直接相邻的节点/边高亮为不透明；
 * 画布任意空白处可拖拽平移、滚轮缩放（echarts 6.1 默认只在图内容包围盒内允许 roam，需 roamTrigger 解除）。
 * 拖拽节点后圆点仍是正圆 —— view 坐标系默认把数据包围盒非等比拉伸铺满画布（圆点会被拉成椭圆），
 * 由两个隐形锚点节点把包围盒钉成画布等比框来保证等比拟合（见 frameAnchors）。
 */
import { Alert, App, AutoComplete, Button, Descriptions, Empty, Progress, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { CloseOutlined, InfoCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
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

// 半透明基调：整个图默认 0.5；标签按 0.82×0.5 折算，保持原有「标签略淡于圆点」的层级
const DIM_OPACITY = 0.5
const LABEL_DIM_COLOR = 'rgba(255,255,255,0.41)'
const LABEL_LIT_COLOR = 'rgba(255,255,255,0.95)'

// 关系图限制说明（静态扫描的边界），浮层面板常驻展示
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

const sameHover = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// —— 等比适配锚点 ——
// view 坐标系把「数据包围盒」拉伸铺满画布（graph 无 preserveAspect，宽高各自缩放），
// 数据宽高比 ≠ 画布宽高比时圆点被拉成椭圆 —— 拖拽节点把包围盒往一侧撑长后尤其明显（变扁）。
// 解法：附加两个隐形锚点数据项，把包围盒钉成与画布等宽高比的框（内容变大时框按内容等比外扩），
// 拟合恒为等比，圆点始终是正圆；包围盒尺寸不变时视图也完全不动。
const FRAME_ANCHOR_A = '__frame_a__'
const FRAME_ANCHOR_B = '__frame_b__'
const FRAME_MARGIN = 1.04 // 框比内容大 4%，内容不贴边（标签也能露出）

/** 按当前内容包围盒 + 画布宽高比计算锚点框的两个角点数据项；无有效坐标时返回 null。 */
function frameAnchors(chart, items) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let seen = 0
  for (const it of items) {
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) continue
    seen++
    if (it.x < minX) minX = it.x
    if (it.x > maxX) maxX = it.x
    if (it.y < minY) minY = it.y
    if (it.y > maxY) maxY = it.y
  }
  if (!seen) return null
  const aspect = chart.getWidth() / chart.getHeight()
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const fw = Math.max((maxX - minX) * FRAME_MARGIN, (maxY - minY) * aspect * FRAME_MARGIN, 60)
  const fh = fw / aspect
  const mk = (name, x, y) => ({
    name,
    x,
    y,
    category: 0,
    symbolSize: 0.01,
    silent: true,
    itemStyle: { opacity: 0 },
    label: { show: false },
  })
  return [mk(FRAME_ANCHOR_A, cx - fw / 2, cy - fh / 2), mk(FRAME_ANCHOR_B, cx + fw / 2, cy + fh / 2)]
}

/**
 * 全量重设 series 数据，四件事一起做：
 * 1) 搜索过滤：未命中（含一跳关联）的节点/边直接从图里移除 —— 不能用透明占位，
 *    graph 节点的 per-item silent 不生效，透明节点照样会被 hover 出 tooltip；
 * 2) 命中节点标签加粗，与仅为「关联」保留的邻居区分；清空搜索恢复全部；
 * 3) 坐标固化：setOption 的 data 是整体替换，坐标按名字缓存后每次带上，
 *    过滤/恢复/拖拽后节点都不跳位；
 * 4) 高亮（半透明主题的核心）：opts.hover（悬停的节点/边）与 opts.pinned（点击/搜索选中的文件）
 *    的「一跳关系子图」—— 本身 + 直接相邻的节点和边 —— 以不透明度 1 显示，其余维持 0.5。
 *    手动重设 data 实现而非 emphasis 的 focus/blur 状态机：后者在快速滑过节点时偶发不恢复
 *    （echarts 6.1 实测仍在），表现为高亮卡死或线消失；手动重设是纯数据、无状态可卡。
 * 5) 等比锚点（见 frameAnchors）：全量重设会触发 view 坐标系按数据包围盒重新拟合，
 *    无锚点时拖拽节点撑大包围盒 → 非等比拉伸 → 圆点变扁；锚点把包围盒钉成画布等比框。
 * freeze=true 时同时把布局切成 none（初始力导向排布完成后冻结：拖拽不被弹回、不触发全场重收敛）。
 */
function applySeries(chart, data, keep, match, opts = {}) {
  const { freeze = false, hover = null, pinned = null } = opts
  let cache = nodePosCache.get(chart)
  if (!cache) {
    cache = new Map()
    nodePosCache.set(chart, cache)
  }
  for (const [name, p] of livePositions(chart)) cache.set(name, p)

  const shownEdges = keep ? data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) : data.edges

  // 高亮集合：悬停/选中对象直接相连的边（及对端节点）
  let litNodes = null
  let litEdges = null
  if (hover || pinned) {
    litNodes = new Set()
    litEdges = new Set()
    for (const e of shownEdges) {
      const hit =
        (hover?.type === 'node' && (e.source === hover.name || e.target === hover.name)) ||
        (hover?.type === 'edge' && e.source === hover.a && e.target === hover.b) ||
        (pinned && (e.source === pinned || e.target === pinned))
      if (hit) {
        litEdges.add(`${e.source} ${e.target}`)
        litNodes.add(e.source)
        litNodes.add(e.target)
      }
    }
    if (hover?.type === 'node') litNodes.add(hover.name)
    if (pinned) litNodes.add(pinned)
  }

  const dataArray = buildChartNodes(data)
    .filter((n) => !keep || keep.has(n.name))
    .map((n) => {
      const lit = litNodes?.has(n.name)
      const label = { fontWeight: match?.has(n.name) ? 600 : 400 }
      const item = { ...n, label }
      if (lit) {
        label.color = LABEL_LIT_COLOR
        item.itemStyle = { opacity: 1 }
        // 悬停本体额外放大一点（选中钉住的不放大，避免持续变大碍眼）
        if (hover?.type === 'node' && hover.name === n.name) item.symbolSize = Math.round(n.symbolSize * 1.4)
      }
      const p = cache.get(n.name)
      if (p) {
        item.x = p[0]
        item.y = p[1]
      }
      return item
    })
  // 锚点追加在末尾（lastSentData 按下标反查节点名，锚点恒在同样位置），不受搜索过滤影响
  const anchors = frameAnchors(chart, dataArray)
  if (anchors) dataArray.push(...anchors)
  const links = litEdges
    ? shownEdges.map((e) => (litEdges.has(`${e.source} ${e.target}`) ? { ...e, lineStyle: { opacity: 1, width: 2.4 } } : e))
    : shownEdges

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
  const [sel, setSel] = useState(null) // 点击/搜索选中的节点（浮层详情）
  const [panelOpen, setPanelOpen] = useState(false) // 右上角浮层面板（详情+说明），默认收起不挡画布
  const [search, setSearch] = useState('')
  const chartDivRef = useRef(null)
  const chartRef = useRef(null) // 供搜索选中/悬停时重设 series
  const searchMatchRef = useRef(null) // 当前搜索命中的节点 id 集合（冻结布局时也要带上）
  const hoverRef = useRef(null) // 当前悬停的节点/边（重建 series 时保持高亮）
  const pinnedRef = useRef(null) // 点击/搜索选中的文件名（钉住其关系子图高亮）
  const bakedRef = useRef(false) // 力导向是否已冻结（冻结前不响应悬停高亮，避免干扰布局）

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
    // useDirtyRect:false —— 全帧重绘：快速悬停切换高亮态时，脏矩形增量渲染偶发漏重绘，
    // 表现为部分线「消失」；图规模不大，全帧重绘的代价可以接受
    const chart = echarts.init(el, null, { useDirtyRect: false })
    chartRef.current = chart
    hoverRef.current = null
    pinnedRef.current = null
    bakedRef.current = false
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
          // 图内容铺满画布后会从图例底下穿过，给图例垫一层半透明底保证可读
          backgroundColor: 'rgba(13,13,15,0.6)',
          borderColor: 'rgba(255,255,255,0.12)',
          borderWidth: 1,
          borderRadius: 4,
          padding: [4, 8],
          textStyle: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },
        },
      ],
      series: [
        {
          type: 'graph',
          layout: 'force',
          // 铺满整个画布（默认 80%×80% 居中，四周留白）；
          // roamTrigger:'global' 让平移/缩放在整个画布生效 —— echarts 6.1 起 roam 只在
          // 「图内容包围盒内」响应（View.containPoint），图缩小或被移开后空白处就拖不动也缩放不了
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          roam: true,
          roamTrigger: 'global',
          draggable: true,
          categories: DEP_DIR_META.map((d) => ({ name: d.key, itemStyle: { color: d.color } })),
          data: chartNodes,
          links: data.edges, // source=被引用文件 → target=引用它的文件（箭头指向引用方）
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 7,
          // 整体半透明基调；悬停/选中的高亮由 applySeries 重设 data 实现
          itemStyle: { opacity: DIM_OPACITY },
          lineStyle: { color: 'source', curveness: 0.15, opacity: DIM_OPACITY, width: 1.2 },
          label: {
            show: true,
            position: 'right',
            distance: 3,
            color: LABEL_DIM_COLOR,
            fontSize: 10,
            formatter: (p) => p.data.fileName,
          },
          // 关闭原生 emphasis：scale/focus 状态机在快速滑过节点时偶发不恢复（高亮卡死/线消失），
          // 悬停放大与连线加粗全部改由 applySeries 按数据手动实现
          emphasis: { disabled: true },
          force: { repulsion: 170, edgeLength: [50, 110], gravity: 0.12, layoutAnimation: false },
        },
      ],
    })
    chart.on('click', (p) => {
      if (p.dataType !== 'node') return
      pinnedRef.current = p.data.name
      setSel(p.data)
      setPanelOpen(true)
      applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, {
        hover: hoverRef.current,
        pinned: pinnedRef.current,
      })
    })
    // 悬停高亮：悬停节点/边时，其一跳关系子图恢复不透明；离开后回到整体 0.5。
    // mouseout 后延迟 40ms 才复位 —— 鼠标在相邻元素间移动会先 out 后 over，立即复位会闪
    let hoverResetTimer = null
    const setHover = (desc) => {
      if (sameHover(hoverRef.current, desc)) return
      hoverRef.current = desc
      if (!bakedRef.current) return // 力导向排布中先不重设，等冻结后由 finished 统一带上
      applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, {
        hover: desc,
        pinned: pinnedRef.current,
      })
    }
    chart.on('mouseover', (p) => {
      if (hoverResetTimer) {
        clearTimeout(hoverResetTimer)
        hoverResetTimer = null
      }
      if (p.dataType === 'node') setHover({ type: 'node', name: p.data.name })
      else if (p.dataType === 'edge') setHover({ type: 'edge', a: p.data.source, b: p.data.target })
    })
    chart.on('mouseout', () => {
      hoverResetTimer = setTimeout(() => setHover(null), 40)
    })
    chart.on('globalout', () => {
      if (hoverResetTimer) clearTimeout(hoverResetTimer)
      setHover(null)
    })
    // 登记初始数据，供 livePositions 按 dataIndex 反查节点名（bake 冻结时要读全部坐标）
    lastSentData.set(chart, chartNodes)
    // 力导向排布完成（图表首次空闲）后冻结布局；带上当前搜索过滤与高亮状态。
    // 冻结后立刻 resize() 一次：坐标系按固化坐标的最终适配（fit）当场完成 ——
    // 否则它会推迟到下一次全量更新（如悬停离开）时才发生，表现为视图突然跳动一下
    const onFinished = () => {
      if (bakedRef.current) return
      bakedRef.current = true
      applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, {
        freeze: true,
        hover: hoverRef.current,
        pinned: pinnedRef.current,
      })
      chart.resize()
    }
    chart.on('finished', onFinished)
    // 窗口缩放时重算画布；宽高比变了要跟着重算锚点框（框与画布等比），防抖避免连续全量重设
    let resizeTimer = null
    const ro = new ResizeObserver(() => {
      chart.resize()
      if (!bakedRef.current) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, {
          hover: hoverRef.current,
          pinned: pinnedRef.current,
        })
      }, 120)
    })
    ro.observe(el)
    return () => {
      clearTimeout(hoverResetTimer)
      clearTimeout(resizeTimer)
      ro.disconnect()
      chart.off('finished', onFinished)
      chart.dispose()
      chartRef.current = null
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
    applySeries(chart, data, searchMatch?.keep ?? null, searchMatch?.match ?? null, {
      hover: hoverRef.current,
      pinned: pinnedRef.current,
    })
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

  // 搜索选中：回填文件名到输入框、打开浮层详情，并把该文件的关系子图钉在高亮态
  const onSearchSelect = (id) => {
    const node = data?.nodes.find((n) => n.id === id)
    if (!node) return
    setSearch(node.name)
    setSel(node)
    setPanelOpen(true)
    pinnedRef.current = id
    const chart = chartRef.current
    if (chart && data?.nodes?.length) {
      applySeries(chart, data, searchMatchRef.current?.keep ?? null, searchMatchRef.current?.match ?? null, {
        hover: hoverRef.current,
        pinned: id,
      })
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

      {/* 主体：关系图铺满整个画布区域；详情/限制说明收进右上角浮层（默认收起，不占画布） */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {empty ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="未在该仓库发现 Shopify 主题目录（layout/templates/sections/snippets/assets）">
              <Button type="primary" loading={loading} onClick={() => load(true)}>
                重新扫描
              </Button>
            </Empty>
          </div>
        ) : !data ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Space direction="vertical" align="center">
              <Spin />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {progress ? `正在解析文件 ${progress.current}/${progress.total}…` : '正在加载…'}
              </Text>
            </Space>
          </div>
        ) : (
          <div ref={chartDivRef} style={{ position: 'absolute', inset: 0 }} />
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

        {/* 右上角浮层：选中文件详情 + 限制说明（毛玻璃底，不挡其余画布交互） */}
        {panelOpen ? (
          <div
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 300,
              maxHeight: 'calc(100% - 24px)',
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 12,
              borderRadius: 10,
              background: 'rgba(18,18,22,0.82)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.1)',
              zIndex: 5,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>
                {sel ? '文件详情' : '关系图说明'}
              </Text>
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setPanelOpen(false)} />
            </div>
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
                图整体半透明展示；悬停或点击任一文件（含搜索选中），它及其直接引用关系会高亮为不透明。画布任意空白处可拖拽平移、滚轮缩放，圆点可单独拖动（停在哪就在哪）；搜索时图中保留匹配的文件及其直接关联，清空恢复；圆点越大被引用越多，点图例可隐藏对应目录。
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
        ) : (
          <Button
            size="small"
            icon={<InfoCircleOutlined />}
            style={{ position: 'absolute', top: 12, right: 12, zIndex: 5 }}
            onClick={() => setPanelOpen(true)}
          >
            详情 / 说明
          </Button>
        )}
      </div>
    </div>
  )
}
