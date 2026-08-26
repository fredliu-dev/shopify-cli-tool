import {
  Alert,
  App,
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowRightOutlined,
  CodeOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  FormatPainterOutlined,
  GithubOutlined,
  PlusOutlined,
  ProjectOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { COMMIT_TYPES, formatCommitTitle } from '@shopify-cli-tool/core/commit'
import WorkItemSelect from '../components/WorkItemSelect.jsx'
import TapdItemDrawer from '../components/TapdItemDrawer.jsx'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

const { Title, Text, Link: ALink } = Typography
const { TextArea } = Input

const isJsonFile = (p) => /\.json$/i.test(p)
const changedJsonOf = (repo) => (repo?.changedFiles || []).filter(isJsonFile)

// 按自定义顺序（path 数组）重排仓库列表：order 里出现的按其顺序优先，未出现的保持原相对顺序追加在后。
// sort 稳定（ES2019+），故两个都不在 order 中的项维持原序。
function orderByPaths(list, paths) {
  if (!paths?.length) return list
  const idx = new Map(paths.map((p, i) => [p, i]))
  return [...list].sort((a, b) => {
    const ia = idx.get(a.path)
    const ib = idx.get(b.path)
    if (ia != null && ib != null) return ia - ib
    if (ia != null) return -1
    if (ib != null) return 1
    return 0
  })
}

// 行序瀑布流（Masonry）：卡片按文档顺序从左到右排，每 N 张换行（N=列数），第 i 张落在第 (i % N) 列；
// 同列卡片紧贴上一张（top = 该列已堆叠高度），列与列高度独立 → 卡片高度不一时也无垂直间隙。
// 解决两个纯 CSS 方案都做不到的事：grid 的 auto-fill/minmax 会把同行卡片拉到同一行高、矮卡下方留白；
// CSS columns 则是「列序」排布（先填满一列再下一列），不是用户要的「行序换行」。
// 实现：首帧以 grid 渲染（item 宽度=列宽、测量准确、不闪烁），useLayoutEffect 内测高、算位、切 absolute。
function Masonry({ minColWidth = 440, gap = 12, draggable = false, onReorder, children }) {
  const containerRef = useRef(null)
  const itemRefs = useRef([])
  const items = React.Children.toArray(children)
  const ids = items.map((c, i) => c.key ?? i)
  const keySig = ids.join('\n') // 父传入顺序变化（重排）时 key 顺序变 → 触发 order 重置

  const [layout, setLayout] = useState(null) // null=首帧 grid 测量；否则 { positions, heights, colWidth, height }
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    // 首次定位完成后再启用过渡：否则卡片会从原点 (0,0) 一路弹到目标位置。双 rAF 确保首帧已绘制。
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setAnimated(true)))
    return () => cancelAnimationFrame(id)
  }, [])

  // order：显示顺序（itemIndex 的排列）。初始自然序；父重排后（keySig 变）重置回自然序。
  const [order, setOrder] = useState(() => items.map((_, i) => i))
  const orderRef = useRef(order)
  orderRef.current = order
  useEffect(() => {
    setOrder(items.map((_, i) => i))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig])

  // 拖拽：pending（未超阈值）用 ref；正式 drag 用 state（驱动被拖卡跟手渲染）。
  const pendingRef = useRef(null)
  const [drag, setDrag] = useState(null) // { itemIndex, pointerId, offX, offY, curLeft, curTop }

  const measure = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const w = el.clientWidth
    const cols = Math.max(1, Math.floor((w + gap) / (minColWidth + gap)))
    const colWidth = (w - gap * (cols - 1)) / cols
    const colHeights = new Array(cols).fill(0)
    const positions = {}
    const heights = {}
    orderRef.current.forEach((itemIndex, visIdx) => {
      const col = visIdx % cols
      const top = colHeights[col]
      positions[itemIndex] = { top, left: col * (colWidth + gap), width: colWidth }
      const node = itemRefs.current[itemIndex]
      const h = node ? node.offsetHeight : 0
      heights[itemIndex] = h
      colHeights[col] = top + h + gap
    })
    setLayout({ positions, heights, colWidth, height: Math.max(0, Math.max(...colHeights) - gap) })
  }, [minColWidth, gap])

  // 容器宽度变化（缩窗、侧栏开合）→ 列数变化 → 重算
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [measure])

  // 任一卡片高度变化（项目面板展开/折叠、内容更新）→ 重排后续所有卡片
  useLayoutEffect(() => {
    const ro = new ResizeObserver(measure)
    itemRefs.current.forEach((n) => n && ro.observe(n))
    return () => ro.disconnect()
  }, [items.length, measure])

  // 显示顺序变化（拖拽让位）→ 按新 order 重算坐标
  useEffect(() => {
    measure()
  }, [order, measure])

  // ---- 拖拽排序（draggable 时启用）----
  const onPointerDown = (itemIndex) => (e) => {
    if (!draggable || e.button !== 0) return
    const p = layout?.positions?.[itemIndex]
    if (!p) return
    // 注意：此处不能 setPointerCapture！pointerdown 立即俘获指针会让兼容性 mouse 事件
    // （mousedown/up/click）全部重定向到卡片层 → 卡片内的按钮永远收不到 click。
    // 改为仅记 pending，等移动超阈值、确定是拖拽时（见 onPointerMove）再俘获指针。
    const rect = containerRef.current.getBoundingClientRect()
    pendingRef.current = {
      itemIndex,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - rect.left - p.left, // 鼠标相对卡片左上角偏移，让卡片精确跟手
      offY: e.clientY - rect.top - p.top,
      cardLeft: p.left,
      cardTop: p.top,
    }
  }

  const onPointerMove = (e) => {
    const pend = pendingRef.current
    if (pend) {
      // 5px 阈值：移动够多才正式进入拖拽，避免点按钮/下拉时误触
      const dx = e.clientX - pend.startX
      const dy = e.clientY - pend.startY
      if (dx * dx + dy * dy < 25) return
      pendingRef.current = null
      // 确定是拖拽了才俘获指针：保证鼠标移出卡片/窗口时 move/up 不丢失。
      // 推迟到此处才 capture，是卡片内按钮 click 能正常工作的关键。
      itemRefs.current[pend.itemIndex]?.setPointerCapture?.(pend.pointerId)
      setDrag({ itemIndex: pend.itemIndex, pointerId: pend.pointerId, offX: pend.offX, offY: pend.offY, curLeft: pend.cardLeft, curTop: pend.cardTop })
      return
    }
    if (!drag) return
    const rect = containerRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setDrag((d) => (d ? { ...d, curLeft: mx - d.offX, curTop: my - d.offY } : d))
    // 让位：找鼠标最近的其它卡片，把被拖卡移到其前/后 → 其余卡片借 transition Q弹顺延
    const hover = findHover(mx, my)
    if (hover) reorderTo(hover)
  }

  // 找鼠标最近的非被拖卡片；before 表示鼠标在其上半 → 插它前面
  const findHover = (mx, my) => {
    if (!layout) return null
    const { positions, heights, colWidth } = layout
    let best = null
    let bestDist = Infinity
    order.forEach((itemIndex, visIdx) => {
      if (drag && itemIndex === drag.itemIndex) return
      const p = positions[itemIndex]
      if (!p) return
      const h = heights[itemIndex] || 0
      const cx = p.left + colWidth / 2
      const cy = p.top + h / 2
      const d = Math.abs(my - cy) + Math.abs(mx - cx) * 0.6 // y 权重更高（纵向排列为主）
      if (d < bestDist) {
        bestDist = d
        best = { visIdx, before: my < cy }
      }
    })
    return best
  }

  // 把被拖卡 D 移到「鼠标最近卡片 R」的前/后；无变化时返回原引用避免无效重渲
  const reorderTo = ({ visIdx, before }) => {
    const D = drag?.itemIndex
    if (D == null) return
    setOrder((prev) => {
      const R = prev[visIdx]
      const next = prev.filter((i) => i !== D)
      const target = next.indexOf(R) + (before ? 0 : 1)
      next.splice(target, 0, D)
      return next.join() === prev.join() ? prev : next
    })
  }

  const onPointerUp = () => {
    const pend = pendingRef.current
    if (pend) {
      // 未启动拖拽（此时未俘获指针）：当作普通点击，按钮 click 正常派发
      pendingRef.current = null
      return
    }
    if (!drag) return
    itemRefs.current[drag.itemIndex]?.releasePointerCapture?.(drag.pointerId)
    const newOrder = order.slice()
    setDrag(null)
    onReorder?.(newOrder.map((i) => ids[i])) // 提交新的 key 顺序，由父重排数据
  }

  if (!layout) {
    // 首帧：grid 撑出列宽，item 自然高度可准确测量；paint 前即被切到 absolute，用户看不到这一帧
    return (
      <div
        ref={containerRef}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${minColWidth}px, 1fr))`,
          gap,
          alignItems: 'start',
        }}
      >
        {items.map((child, i) => (
          <div key={ids[i]} ref={(n) => { itemRefs.current[i] = n }}>
            {child}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: layout.height }}
      onPointerMove={draggable ? onPointerMove : undefined}
      onPointerUp={draggable ? onPointerUp : undefined}
      onPointerCancel={draggable ? onPointerUp : undefined}
    >
      {items.map((child, i) => {
        const p = layout.positions[i] || { top: 0, left: 0, width: '100%' }
        const isDrag = drag?.itemIndex === i
        return (
          <div
            key={ids[i]}
            ref={(n) => { itemRefs.current[i] = n }}
            onPointerDown={draggable ? onPointerDown(i) : undefined}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: p.width,
              // transform 走 GPU 合成层（不触发重排）→ 60fps；被拖卡即时跟手故无过渡
              transform: isDrag
                ? `translate3d(${drag.curLeft}px, ${drag.curTop}px, 0) scale(1.03)`
                : `translate3d(${p.left}px, ${p.top}px, 0)`,
              transition: isDrag ? 'none' : animated ? 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
              zIndex: isDrag ? 10 : undefined,
              opacity: isDrag ? 0.92 : undefined,
              boxShadow: isDrag ? '0 14px 36px rgba(0,0,0,0.55)' : undefined,
              cursor: isDrag ? 'grabbing' : draggable ? 'grab' : undefined,
              touchAction: 'none', // pointer 拖拽时禁止触屏滚动/手势干扰
            }}
          >
            {child}
          </div>
        )
      })}
    </div>
  )
}

// 区块小标题：左侧色点 + 加粗小字，作为视觉锚点（区别于普通辅助文案）
function SectionLabel({ color = '#1677ff', children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
      <Text strong style={{ fontSize: 12 }}>
        {children}
      </Text>
    </div>
  )
}

// 毛玻璃卡片（iOS 风格）：半透明背景 + 背景模糊 + 高光描边；
// 需配合 App.jsx Content 的彩色光晕背景，blur 才能透出色彩。
const GLASS = {
  background: 'rgba(255,255,255,0.055)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.1)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}

// hover 玻璃亮光：提亮底色与描边、增强顶部内高光、加柔光投影 → 玻璃被光打到、悬浮起来的感觉。
// 配合 Card 上的 0.25s 过渡，鼠标移上时整张卡「亮起来」（不改位移，避免布局抖动）。
const HOVER_GLASS = {
  background: 'rgba(255,255,255,0.1)',
  border: '1px solid rgba(255,255,255,0.24)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(255,255,255,0.05), 0 14px 34px rgba(0,0,0,0.42)',
}

/* ---------------- 初始化 Modal（shop init 可视化，针对某仓库目录） ---------------- */
function InitRepoModal({ open, repo, onClose, onDone }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    // 拉模板列表；同时按仓库远程地址反查模板，命中则直接回填，省去用户手选
    window.api.config.templates().then(setTemplates)
    if (repo?.remoteUrl) {
      window.api.repos.resolveTemplateByRemote(repo.remoteUrl).then((res) => {
        if (res.ok && res.data) form.setFieldValue('template', res.data)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async (vals) => {
    setLoading(true)
    // 工单选择器的值：title 写 project_desc，url 写 dev 环境 _tapd（本地保存时回显并带入 projects.json）
    const item = vals.workItem || null
    const res = repo.hasToml
      ? await window.api.config.initMerge({ dir: repo.path, templateName: vals.template })
      : await window.api.config.initCreate({
          dir: repo.path,
          templateName: vals.template,
          theme: vals.theme,
          port: vals.port,
          previewKey: vals.previewKey,
          previewPath: vals.previewPath,
          projectDesc: item?.title || '',
          tapd: item?.url || '',
        })
    setLoading(false)
    if (res.ok) {
      message.success(repo.hasToml ? '已合并 dev 环境到现有配置' : '已创建 shopify.theme.toml')
      onDone?.()
    } else {
      message.error(res.error || '初始化失败')
    }
  }

  return (
    <Modal title={`初始化配置 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item name="template" label="模板" rules={[{ required: true, message: '请选择模板' }]}>
          <Select options={templates.map((t) => ({ value: t.name, label: t.name }))} placeholder="选择模板" />
        </Form.Item>
        {!repo?.hasToml && (
          <>
            <Form.Item name="theme" label="theme">
              <Input placeholder="主题 id（可留空，本地保存时再复制 live）" />
            </Form.Item>
            <Form.Item name="port" label="port" rules={[{ pattern: /^\d+$/, message: '需为数字' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="previewKey" label="preview_key（新页面需填）">
              <Input />
            </Form.Item>
            <Form.Item
              name="previewPath"
              label="网页路径（选填）"
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  如 /pages/back-to-school-sale；无 preview_key 时拼到预览/开发链接，编辑器链接挂 previewPath 参数
                </Text>
              }
            >
              <Input placeholder="/pages/xxx" />
            </Form.Item>
            <Form.Item name="workItem" label="工单（选填，标题作为 project_desc）">
              <WorkItemSelect />
            </Form.Item>
          </>
        )}
        <Button type="primary" htmlType="submit" loading={loading}>
          {repo?.hasToml ? '合并 dev 环境' : '创建配置'}
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 本地保存 Modal（shop add 可视化，含复制线上 live 主题） ---------------- */
function SaveRepoModal({ open, repo, projects = [], onClose, onDone, contacts }) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  // store 反查模板：undefined=加载中，null=反查不到需手选，字符串=已确定（直接用反查值）
  const [resolvedTpl, setResolvedTpl] = useState(undefined)
  const [tplOptions, setTplOptions] = useState([])
  const [copyForm] = Form.useForm()
  const [copyLoading, setCopyLoading] = useState(false)

  const dev = repo?.devEnv || {}

  useEffect(() => {
    if (open) {
      // dev 来自仓库 shopify.theme.toml 的 [environments.dev]（getRepoStatus 实时读取），
      // 配置里已有的值一律回填，避免用户重复输入；theme 留空时仍可点「复制线上 live 主题」覆盖。
      // project_desc 回显初始化时关联的工单链接（toml _tapd），提交时 splitDesc 会再拆回 _tapd
      form.setFieldsValue({
        port: dev.port != null ? String(dev.port) : '',
        theme: dev.theme != null ? String(dev.theme) : '',
        preview_key: dev.preview_key ?? '',
        project_desc: [dev.project_desc, dev._tapd].filter(Boolean).join('\n'),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  // 打开时按 store 反查模板：查到则自动用（不显示选择），查不到则拉模板列表让用户选
  useEffect(() => {
    if (!open || !dev.store) return
    setResolvedTpl(undefined)
    Promise.all([window.api.repos.resolveTemplate(dev.store), window.api.repos.templates()]).then(
      ([r1, r2]) => {
        setResolvedTpl(r1.ok ? r1.data : null)
        setTplOptions(r2.ok ? r2.data : [])
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dev.store])

  const doCopyLive = async (vals) => {
    setCopyLoading(true)
    const res = await window.api.repos.copyLive({
      dir: repo.path,
      envName: 'dev',
      envConfig: dev,
      activity: vals.activity,
      owner: vals.owner,
    })
    setCopyLoading(false)
    if (res.ok) {
      form.setFieldValue('theme', res.data.id)
      message.success(`已复制主题：${res.data.name}（${res.data.id}）`)
      setCopyOpen(false)
      copyForm.resetFields()
    } else {
      modal.error({
        title: '复制主题失败',
        content: (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <div style={{ fontWeight: 500 }}>{res.error}</div>
            {res.stderr && (
              <pre
                style={{
                  marginTop: 8,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  background: 'rgba(255,255,255,0.05)',
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                {res.stderr.trim()}
              </pre>
            )}
          </div>
        ),
      })
    }
  }

  // 从 project_desc 复合文本拆出标题与工单链接：任意 http(s) 链接 → _tapd（不写 toml）；剩余去【】括号 → 标题
  const splitDesc = (raw) => {
    if (!raw) return { desc: '', tapd: null }
    const m = String(raw).match(/https?:\/\/\S+/i)
    const tapd = m ? m[0] : null
    const desc = (tapd ? String(raw).replace(tapd, '') : String(raw)).replace(/[【】]/g, '').trim()
    return { desc, tapd }
  }

  // 与当前仓库（同 store）已有本地项目判重，口径与 core isSameProject 六要素一致：
  // store / domain / theme / preview_key / project_desc / _branch（port 不参与身份）。
  // 完全一致则阻止保存（不写 toml / projects.json）；改任一身份字段才能另存为新项目。
  // 历史项目无 _branch 视为通配，与后端规则一致。提交时与按钮禁用态共用此函数
  const findDup = (vals) => {
    const { desc } = splitDesc(vals.project_desc)
    const branch = repo.currentBranch || null
    return (projects || []).find(
      (p) =>
        String(p.store ?? '') === String(dev.store ?? '') &&
        String(p.domain ?? '').trim() === String(dev.domain ?? '').trim() &&
        String(p.theme ?? '').trim() === String(vals.theme ?? '').trim() &&
        String(p.previewKey ?? '').trim() === String(vals.preview_key ?? '').trim() &&
        String(p.description ?? '').trim() === String(desc ?? '').trim() &&
        (p._branch == null || p._branch === branch),
    )
  }

  // 身份字段实时联动（port 不参与判重不监听）：命中重复直接禁用保存按钮并挂问号提示，
  // 免得点了才在弹窗里报「已存在相同项目」；必填项（theme/project_desc）没填时跳过判重，
  // 避免空表单与历史空字段子项目误判
  const wTheme = Form.useWatch('theme', form)
  const wPreviewKey = Form.useWatch('preview_key', form)
  const wDesc = Form.useWatch('project_desc', form)
  const dup = useMemo(() => {
    if (!open || !repo) return null
    if (!String(wTheme ?? '').trim() || !String(wDesc ?? '').trim()) return null
    return findDup({ theme: wTheme, preview_key: wPreviewKey, project_desc: wDesc })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo, wTheme, wPreviewKey, wDesc, projects, dev.store, dev.domain, repo?.currentBranch])

  const submit = async (vals) => {
    const { desc, tapd } = splitDesc(vals.project_desc)
    const dup = findDup(vals)
    if (dup) {
      modal.warning({
        title: '已存在完全相同的本地项目，无需重复保存',
        content: `「${dup.description || dup.theme || dup.id}」与表单内容一致（store / domain / theme / preview_key / project_desc / 分支 均相同）。修改任一字段后即可另存为新项目。`,
      })
      return
    }
    setLoading(true)
    // try/finally 兜底：提交中途抛错（如 IPC 异常）也必须复位 loading，否则按钮永远转圈
    try {
      const res = await window.api.repos.save({
        dir: repo.path,
        envName: 'dev',
        fields: {
          domain: dev.domain,
          port: vals.port,
          theme: vals.theme,
          preview_key: vals.preview_key,
          project_desc: desc,
        },
        templateName: resolvedTpl || vals.template || null,
        tapd,
      })
      if (res.ok) {
        // created=false 为后端兜底命中（如项目列表已过时）：不提示成功，按重复处理
        if (res.data.created) {
          message.success('已保存为本地项目')
        } else {
          message.warning('该配置与已有本地项目字段一致，未另存为新项目')
        }
        onDone?.()
      } else {
        message.error(res.error || '保存失败')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title={`本地保存 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item label="store（项目身份）">
          <Input value={dev.store || ''} disabled />
        </Form.Item>
        <Form.Item label="domain（取自配置，不可改）">
          <Input value={dev.domain || ''} disabled />
        </Form.Item>
        {resolvedTpl === null && (
          <Form.Item
            name="template"
            label="模板（store 未匹配到模板，请选择）"
            rules={[{ required: true, message: '请选择模板' }]}
          >
            <Select options={tplOptions.map((t) => ({ label: t, value: t }))} placeholder="选择模板" />
          </Form.Item>
        )}
        <Form.Item name="port" label="port" rules={[{ required: true, message: '请输入 port' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item label="theme" required>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="theme" noStyle rules={[{ required: true, message: '请输入 theme（或点右侧复制 live 主题）' }]}>
              <Input placeholder="主题 id" />
            </Form.Item>
            <Button onClick={() => setCopyOpen(true)}>复制线上 live 主题</Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="preview_key" label="preview_key">
          <Input />
        </Form.Item>
        <Form.Item name="project_desc" label="project_desc（标题，可附工单链接）" rules={[{ required: true, message: '请输入 project_desc' }]}>
          {/* freeText 版工单选择器：手填任意标题，或下拉/粘贴工单自动回填「标题\n链接」，提交时 splitDesc 拆为 _tapd */}
          <WorkItemSelect
            freeText
            footerHint="手填标题即可；选工单会自动填「标题 + 链接」两行，保存时链接拆为 _tapd 随项目保存"
          />
        </Form.Item>
        {/* 命中已有项目判重时禁用保存（antd 禁用按钮不触发鼠标事件，问号单独挂 Tooltip） */}
        <Space>
          <Button type="primary" htmlType="submit" loading={loading} disabled={!!dup}>
            保存为本地项目
          </Button>
          {dup && (
            <Tooltip
              title={`与已有本地项目「${dup.description || dup.theme || dup.id}」字段完全一致（store / domain / theme / preview_key / project_desc / 分支 均相同），不会重复保存。修改任一身份字段后即可另存为新项目。`}
            >
              <QuestionCircleOutlined style={{ color: '#faad14', fontSize: 16, cursor: 'help' }} />
            </Tooltip>
          )}
        </Space>
      </Form>

      <Modal title="复制线上 live 主题" open={copyOpen} onCancel={() => setCopyOpen(false)} footer={null} destroyOnClose>
        <Form form={copyForm} layout="vertical" onFinish={doCopyLive}>
          <Form.Item name="activity" label="活动名称" rules={[{ required: true, message: '请输入活动名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="owner" label="负责人" rules={[{ required: true, message: '请输入负责人' }]}>
            <AutoComplete
              options={(contacts || []).map((c) => ({ value: c.name }))}
              filterOption={(v, o) => String(o.value).toLowerCase().includes(String(v).toLowerCase())}
              style={{ width: '100%' }}
            >
              <Input placeholder="负责人（可从已录入人员选择或手输）" />
            </AutoComplete>
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            主题名格式：[dev] 活动 | 负责人 | 日期；需该 store 已 shopify login。
          </Text>
          <Button type="primary" htmlType="submit" loading={copyLoading}>
            复制并回填 theme
          </Button>
        </Form>
      </Modal>
    </Modal>
  )
}

/* ---------------- 查看 JSON 改动 Modal（git 改动过的 *.json 文件名） ---------------- */
function ChangedJsonModal({ open, title, files, onClose }) {
  return (
    <Modal title={title ? `JSON改动 - ${title}` : 'JSON改动'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      {!files || files.length === 0 ? (
        <Text type="secondary">当前分支无改动的 json 文件</Text>
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
          {files.map((f) => (
            <div key={f} style={{ whiteSpace: 'nowrap' }}>
              {f}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 设置 Modal：选择默认编辑器 ---------------- */
function SettingsModal({ open, defaultEditor, onClose, onSaved }) {
  const { message } = App.useApp()
  const [editors, setEditors] = useState([])
  const [value, setValue] = useState(defaultEditor)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      window.api.repos.editors().then((res) => {
        if (res.ok) setEditors(res.data || [])
      })
      setValue(defaultEditor)
    }
  }, [open, defaultEditor])

  const save = async () => {
    if (!value) {
      message.warning('请选择一个编辑器')
      return
    }
    setLoading(true)
    const res = await window.api.settings.setEditor(value)
    setLoading(false)
    if (res.ok) {
      message.success('已设为默认编辑器')
      onSaved?.(value)
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title="设置默认编辑器" open={open} onCancel={onClose} footer={null} destroyOnClose>
      {editors.length === 0 ? (
        <Text type="secondary">未检测到本机已装的编辑器（VS Code / Cursor / WebStorm 等）。</Text>
      ) : (
        <Radio.Group value={value} onChange={(e) => setValue(e.target.value)} style={{ display: 'flex', flexDirection: 'column' }}>
          {editors.map((e) => (
            <Radio key={e.id} value={e.id}>
              {e.name}
            </Radio>
          ))}
        </Radio.Group>
      )}
      <div style={{ marginTop: 16 }}>
        <Button type="primary" onClick={save} loading={loading} disabled={!editors.length}>
          保存
        </Button>
      </div>
    </Modal>
  )
}

/* ---------------- 创建项目（从模板 _github 克隆，自动查重） ---------------- */
function CreateProjectModal({ open, workspaceDir, templates, onClose, onDone }) {
  const { message } = App.useApp()
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const cloneable = (templates || []).filter((t) => !t.exists)

  useEffect(() => {
    if (open) setSelected([]) // 默认不勾选，由用户自行挑选要克隆的项目
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templates])

  const submit = async () => {
    if (!selected.length) {
      message.warning('请至少选择一个项目')
      return
    }
    setLoading(true)
    const picks = cloneable.filter((t) => selected.includes(t.name))
    const results = []
    for (const t of picks) {
      const res = await window.api.repos.clone({ workspaceDir, github: t.github })
      results.push({ name: t.repoName, ok: res.ok, error: res.error })
    }
    setLoading(false)
    const failed = results.filter((r) => !r.ok)
    if (!failed.length) message.success(`已克隆 ${results.length} 个项目`)
    else message.error(`${results.length - failed.length} 成功；${failed.length} 失败：${failed.map((f) => `${f.name}(${f.error})`).join('、')}`)
    onDone?.()
  }

  return (
    <Modal
      title="创建项目（从模板 _github 克隆）"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="克隆选中"
      okButtonProps={{ disabled: cloneable.length === 0, loading }}
      destroyOnClose
    >
      {cloneable.length === 0 ? (
        <Text type="secondary">所有模板的仓库都已存在于当前工作区。</Text>
      ) : (
        <Checkbox.Group value={selected} onChange={setSelected} style={{ display: 'flex', flexDirection: 'column' }}>
          {cloneable.map((t) => (
            <Checkbox key={t.name} value={t.name}>
              {t.name} <Text type="secondary" style={{ fontSize: 12 }}>→ {t.repoName}</Text>
            </Checkbox>
          ))}
        </Checkbox.Group>
      )}
    </Modal>
  )
}

/* ---------------- 创建模板（用户自建模板，写入 userDataDir/templates） ---------------- */
function CreateTemplateModal({ open, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.config.createTemplate({
      name: vals.name,
      fields: {
        _github: vals._github,
        _branch: vals._branch,
        project_desc: vals.project_desc,
        domain: vals.domain,
        theme: vals.theme,
        store: vals.store,
        port: vals.port,
        preview_key: vals.preview_key,
      },
    })
    setLoading(false)
    if (res.ok) {
      message.success('模板已创建')
      onDone?.()
    } else {
      message.error(res.error || '创建失败')
    }
  }

  return (
    <Modal title="创建模板" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item
          name="name"
          label="模板名称"
          rules={[
            { required: true, message: '请输入模板名称' },
            { pattern: /^[A-Za-z0-9_-]+$/, message: '仅字母、数字、下划线和中划线（将作为文件名）' },
          ]}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>将作为文件名，新建后在所有「选模板」处可见</Text>}
        >
          <Input placeholder="如 cn、jp" />
        </Form.Item>
        <Form.Item name="_github" label="仓库地址（_github）" rules={[{ required: true, message: '请输入仓库地址' }]} extra={<Text type="secondary" style={{ fontSize: 12 }}>用于「创建项目」时克隆</Text>}>
          <Input placeholder="git@github.com:org/repo.git" />
        </Form.Item>
        <Form.Item name="_branch" label="分支（_branch）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="domain" label="域名（domain）" rules={[{ required: true, message: '请输入域名' }]}>
          <Input placeholder="https://xxx.com" />
        </Form.Item>
        <Form.Item name="store" label="店铺（store）" rules={[{ required: true, message: '请输入店铺' }]}>
          <Input placeholder="xxx.myshopify.com" />
        </Form.Item>
        <Form.Item name="theme" label="主题 id（theme）">
          <Input placeholder="选填，留空则本地保存时再复制 live" />
        </Form.Item>
        <Form.Item name="port" label="端口（port）" rules={[{ required: true, message: '请输入端口' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="preview_key" label="预览密钥（preview_key）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="project_desc" label="项目描述（project_desc）">
          <Input placeholder="选填" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          创建模板
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 编辑模板（仅自建模板；name 不可改，字段预填） ---------------- */
function EditTemplateModal({ open, template, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  // 打开时拉取该模板的 dev 字段预填（含 _github/_branch 等只读元数据）
  useEffect(() => {
    if (!open || !template?.name) return
    ;(async () => {
      const res = await window.api.config.templateEnv(template.name)
      if (res.ok && res.data) {
        const e = res.data
        form.setFieldsValue({
          _github: e._github ?? '',
          _branch: e._branch ?? '',
          project_desc: e.project_desc ?? '',
          domain: e.domain ?? '',
          theme: e.theme != null ? String(e.theme) : '',
          store: e.store ?? '',
          port: e.port != null ? String(e.port) : '',
          preview_key: e.preview_key ?? '',
        })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.config.updateTemplate({
      name: template.name,
      fields: {
        _github: vals._github,
        _branch: vals._branch,
        project_desc: vals.project_desc,
        domain: vals.domain,
        theme: vals.theme,
        store: vals.store,
        port: vals.port,
        preview_key: vals.preview_key,
      },
    })
    setLoading(false)
    if (res.ok) {
      message.success('模板已更新')
      onDone?.()
    } else {
      message.error(res.error || '更新失败')
    }
  }

  return (
    <Modal title={`编辑模板 - ${template?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item label="模板名称" extra={<Text type="secondary" style={{ fontSize: 12 }}>name 不可改，需改名请删除后重建</Text>}>
          <Input value={template?.name ?? ''} disabled />
        </Form.Item>
        <Form.Item name="_github" label="仓库地址（_github）" rules={[{ required: true, message: '请输入仓库地址' }]} extra={<Text type="secondary" style={{ fontSize: 12 }}>用于「创建项目」时克隆</Text>}>
          <Input placeholder="git@github.com:org/repo.git" />
        </Form.Item>
        <Form.Item name="_branch" label="分支（_branch）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="domain" label="域名（domain）" rules={[{ required: true, message: '请输入域名' }]}>
          <Input placeholder="https://xxx.com" />
        </Form.Item>
        <Form.Item name="store" label="店铺（store）" rules={[{ required: true, message: '请输入店铺' }]}>
          <Input placeholder="xxx.myshopify.com" />
        </Form.Item>
        <Form.Item name="theme" label="主题 id（theme）">
          <Input placeholder="选填，留空则本地保存时再复制 live" />
        </Form.Item>
        <Form.Item name="port" label="端口（port）" rules={[{ required: true, message: '请输入端口' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="preview_key" label="预览密钥（preview_key）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="project_desc" label="项目描述（project_desc）">
          <Input placeholder="选填" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 模板管理（列出全部；仅自建可编辑/删除，内置锁定） ---------------- */
function ManageTemplatesModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null) // { name }
  const [createOpen, setCreateOpen] = useState(false)

  // config:templates 返回原始数组（非 { ok, data }，与 InitRepoModal 用法一致）
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.config.templates()
      setTemplates(Array.isArray(list) ? list : [])
    } catch (err) {
      message.error(err?.message || '加载模板失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (name) => {
    const res = await window.api.config.deleteTemplate(name)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.() // 通知父组件刷新「创建项目」徽标等
    } else {
      message.error(res.error || '删除失败')
    }
  }

  // 内置模板：编辑/删除禁用并附 Tooltip；自建模板：可编辑可删除
  const renderActions = (t) => {
    if (!t.user) {
      return (
        <Tooltip title="内置模板不可修改/删除">
          <span>
            <Button size="small" disabled>
              编辑
            </Button>
            <Button size="small" danger disabled style={{ marginLeft: 6 }}>
              删除
            </Button>
          </span>
        </Tooltip>
      )
    }
    return (
      <Space size={6}>
        <Button size="small" onClick={() => setEditTarget({ name: t.name })}>
          编辑
        </Button>
        <Popconfirm title={`删除模板「${t.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(t.name)}>
          <Button size="small" danger>
            删除
          </Button>
        </Popconfirm>
      </Space>
    )
  }

  const columns = [
    { title: '模板名', dataIndex: 'name', key: 'name' },
    {
      title: '类型',
      dataIndex: 'user',
      key: 'user',
      width: 90,
      render: (user) => (user ? <Tag color="blue">自建</Tag> : <Tag>内置</Tag>),
    },
    { title: '操作', key: 'action', width: 170, render: (_, t) => renderActions(t) },
  ]

  return (
    <Modal title="模板管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={620}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建模板
        </Button>
      </div>
      <Table size="small" rowKey="name" loading={loading} columns={columns} dataSource={templates} pagination={false} />

      {/* 编辑自建模板（嵌套） */}
      <EditTemplateModal
        open={!!editTarget}
        template={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />

      {/* 新建模板（嵌套） */}
      <CreateTemplateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 人员管理（姓名+手机号，存本地 contacts.json） ---------------- */
function ContactEditModal({ open, contact, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: contact?.name ?? '', phone: contact?.phone ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.contacts.upsert({ id: contact?.id, name: vals.name, phone: vals.phone })
    setLoading(false)
    if (res.ok) {
      message.success(contact?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={contact?.id ? '编辑人员' : '新增人员'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
          <Input placeholder="用于主题命名「负责人」与提测 @ 选择" />
        </Form.Item>
        <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '需为 11 位手机号（1 开头，钉钉 @ 用）' }]}>
          <Input placeholder="提测时用于 @ 该负责人（须为该成员钉钉绑定的手机号）" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function ContactsModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null) // { id?, name?, phone? }；{} 为新增

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.contacts.ls()
      setContacts(res.ok ? res.data || [] : [])
    } catch (err) {
      message.error(err?.message || '加载人员失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.contacts.remove(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.() // 通知父组件刷新负责人下拉数据源
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const columns = [
    { title: '姓名', dataIndex: 'name', key: 'name' },
    { title: '手机号', dataIndex: 'phone', key: 'phone' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_, c) => (
        <Space size={6}>
          <Button size="small" onClick={() => setEditTarget(c)}>
            编辑
          </Button>
          <Popconfirm title={`删除「${c.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(c.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="人员管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={560}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增人员
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={contacts} pagination={false} />
      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
        姓名用于主题命名「负责人」下拉；手机号用于提测消息 @ 该负责人。
      </Text>

      <ContactEditModal
        open={!!editTarget}
        contact={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 通知群管理（钉钉群机器人：name/webhook/secret） ---------------- */
function GroupEditModal({ open, group, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: group?.name ?? '', webhook: group?.webhook ?? '', secret: group?.secret ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.dingtalk.upsertGroup({ id: group?.id, ...vals })
    setLoading(false)
    if (res.ok) {
      message.success(group?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={group?.id ? '编辑通知群' : '新增通知群'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="群名称" rules={[{ required: true, message: '请输入群名称' }]}>
          <Input placeholder="如 测试通知群" />
        </Form.Item>
        <Form.Item name="webhook" label="webhook" rules={[{ required: true, message: '请输入 webhook 地址' }]}>
          <Input placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </Form.Item>
        <Form.Item name="secret" label="加签 secret（选填）" tooltip="机器人安全设置选「加签」时填，否则留空">
          <Input placeholder="SEC..." />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function GroupsModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.dingtalk.load()
      setGroups(res.ok ? res.data?.groups || [] : [])
    } catch (err) {
      message.error(err?.message || '加载通知群失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.dingtalk.removeGroup(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const columns = [
    { title: '群名称', dataIndex: 'name', key: 'name' },
    {
      title: 'webhook',
      dataIndex: 'webhook',
      key: 'webhook',
      ellipsis: true,
      render: (w) => <Text style={{ fontSize: 12 }}>{w}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_, g) => (
        <Space size={6}>
          <Button size="small" onClick={() => setEditTarget(g)}>
            编辑
          </Button>
          <Popconfirm title={`删除群「${g.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(g.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="通知群管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={640}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增通知群
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={groups} pagination={false} />
      <GroupEditModal
        open={!!editTarget}
        group={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 信息模板管理（钉钉消息模板：name/content，含占位符） ---------------- */
function TemplateEditModal({ open, template, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: template?.name ?? '', content: template?.content ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])

  const submit = async (vals) => {
    setLoading(true)
    // 仅写 name/content；core 透传保留模板已有的 defaults（CLI gotest 占位符默认值）
    const res = await window.api.dingtalk.upsertTemplate({ id: template?.id, name: vals.name, content: vals.content })
    setLoading(false)
    if (res.ok) {
      message.success(template?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={template?.id ? '编辑信息模板' : '新增信息模板'} open={open} onCancel={onClose} footer={null} destroyOnClose width={600}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '请输入模板名称' }]}>
          <Input placeholder="如 默认提测通知" />
        </Form.Item>
        <Form.Item
          name="content"
          label="消息内容"
          rules={[{ required: true, message: '请输入消息内容' }]}
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              占位符：<Text code>{'{{@person as 姓名}}'}</Text> <Text code>{'{{@url}}'}</Text> <Text code>{'{{@title}}'}</Text> <Text code>{'{{@content as 备注}}'}</Text> <Text code>{'{{@tapd as 工单}}'}</Text><Text code>{'{{@all}}'}</Text>；多行直接换行。
            </Text>
          }
        >
          <TextArea rows={6} placeholder={'【提测通知】\n{{@title}} 已就绪，预览：{{@url}}\n负责人 {{@person as 姓名}}'} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function DingtalkTemplatesModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.dingtalk.load()
      setTemplates(res.ok ? res.data?.templates || [] : [])
    } catch (err) {
      message.error(err?.message || '加载模板失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.dingtalk.removeTemplate(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const handleClearDefaults = async (id) => {
    const res = await window.api.dingtalk.saveDefaults({ templateId: id, defaults: {} })
    if (res.ok) {
      message.success('已清除默认值')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '清除失败')
    }
  }

  const columns = [
    { title: '模板名称', dataIndex: 'name', key: 'name' },
    {
      title: '内容预览',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (c) => <Text style={{ fontSize: 12 }}>{(c || '').replace(/\n/g, ' ')}</Text>,
    },
    {
      title: '默认负责人',
      key: 'defaults',
      ellipsis: true,
      render: (_, t) => {
        const d = t.defaults
        if (!d || !Object.keys(d).length) return <Text type="secondary">—</Text>
        return <Text style={{ fontSize: 12 }}>{Object.values(d).join('，')}</Text>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, t) => (
        <Space size={6} wrap>
          <Button size="small" onClick={() => setEditTarget(t)}>
            编辑
          </Button>
          {t.defaults && Object.keys(t.defaults).length > 0 && (
            <Popconfirm title="清除该模板的默认负责人？" okText="清除" cancelText="取消" onConfirm={() => handleClearDefaults(t.id)}>
              <Button size="small">清默认</Button>
            </Popconfirm>
          )}
          <Popconfirm title={`删除模板「${t.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(t.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="信息模板管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={640}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增模板
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={templates} pagination={false} />
      <TemplateEditModal
        open={!!editTarget}
        template={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 提测通知（参考 shop gotest：选群+模板，预填项目链接/描述后发钉钉） ---------------- */
function GotestModal({ open, project, projects, contacts, onClose }) {
  const { message, modal } = App.useApp()
  const [groups, setGroups] = useState([])
  const [templates, setTemplates] = useState([])
  const [groupId, setGroupId] = useState()
  const [templateId, setTemplateId] = useState()
  const [fields, setFields] = useState([]) // parsePlaceholders 返回的字段列表
  const [values, setValues] = useState({}) // token -> 值（person 存手机号）
  const [parsing, setParsing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selProject, setSelProject] = useState(project) // 当前选中的本地项目（默认=入口传入的仓库项目，可切换）

  // 打开时加载群+模板，重置选择
  useEffect(() => {
    if (!open) return
    ;(async () => {
      const res = await window.api.dingtalk.load()
      if (res.ok) {
        setGroups(res.data?.groups || [])
        setTemplates(res.data?.templates || [])
      }
      setGroupId(undefined)
      setTemplateId(undefined)
      setFields([])
      setValues({})
      setSelProject(project)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])

  // 按占位符类型，用项目信息预填 url（提测链接）/ title（描述）/ tapd（工单链接）；person/content 不在此处理
  const applyProject = (p, fs) => {
    const next = {}
    ;(fs || []).forEach((f) => {
      if (f.kind === 'url') next[f.token] = p?.links?.previewLink || ''
      else if (f.kind === 'title') next[f.token] = p?.description || ''
      else if (f.kind === 'tapd') next[f.token] = p?._tapd || ''
    })
    return next
  }

  // 兼容 CLI「手机号（姓名）」存法：拆出纯手机号；并按手机号从 contacts 反查展示名
  const splitPhone = (raw) => {
    const m = String(raw).match(/^(.+?)\s*[（(](.+?)[）)]\s*$/)
    return m ? { phone: m[1].trim(), display: m[2].trim() } : { phone: String(raw).trim(), display: String(raw).trim() }
  }
  const phoneDisplay = (phone) => {
    const c = (contacts || []).find((x) => x.phone === phone)
    return c ? `${c.name}（${phone}）` : phone
  }

  // 选完模板：解析占位符并按字段类型预填；有 person 默认值则询问是否使用（与 CLI gotest 一致）
  const onTemplateChange = async (id) => {
    setTemplateId(id)
    if (!id) {
      setFields([])
      return
    }
    setParsing(true)
    const res = await window.api.dingtalk.parsePlaceholders(id)
    setParsing(false)
    if (!res.ok) {
      message.error(res.error || '解析模板失败')
      return
    }
    const fs = res.data?.fields || []
    setFields(fs)
    setValues(applyProject(selProject, fs))
    // 默认值仅 person：模板存了 @person 默认值时，询问是否使用并展示
    const defaults = templates.find((t) => t.id === id)?.defaults || {}
    const personFields = fs.filter((f) => f.kind === 'person' && defaults[f.token])
    if (personFields.length) {
      const preview = personFields.map((f) => `${f.label}：${phoneDisplay(splitPhone(defaults[f.token]).phone)}`).join('\n')
      modal.confirm({
        title: '检测到默认负责人，是否使用？',
        content: <Text style={{ whiteSpace: 'pre-wrap' }}>{preview}</Text>,
        okText: '使用默认',
        cancelText: '不用',
        onOk: () =>
          setValues((s) => {
            const next = { ...s }
            personFields.forEach((f) => (next[f.token] = splitPhone(defaults[f.token]).phone))
            return next
          }),
      })
    }
  }

  const submit = async () => {
    if (!groupId) {
      message.warning('请选择通知群')
      return
    }
    if (!templateId) {
      message.warning('请选择消息模板')
      return
    }
    // person 必填（手机号）
    const missing = fields.find((f) => f.kind === 'person' && !values[f.token])
    if (missing) {
      message.warning(`请为「${missing.label}」选择人员`)
      return
    }
    // person 手机号须为 11 位：钉钉只 @ 群成员的真实手机号，错号/少位会发得出消息却 @ 不到人
    const badPhone = fields.find((f) => f.kind === 'person' && !/^1\d{10}$/.test(values[f.token]))
    if (badPhone) {
      message.warning(`「${badPhone.label}」的手机号 ${values[badPhone.token]} 不是 11 位，钉钉无法 @ 到人，请先在「人员管理」修正`)
      return
    }
    setLoading(true)
    const res = await window.api.dingtalk.gotest({ groupId, templateId, values })
    setLoading(false)
    if (res.ok) {
      const g = groups.find((x) => x.id === groupId)
      message.success(`已发送到「${g?.name || '群'}」`)
      // 发送成功后询问是否把本次 person 存为默认值（与 CLI gotest 一致）。
      // 与现有默认值（按手机号比对）相同的不再提示——存了也是重复。
      const defaults = templates.find((t) => t.id === templateId)?.defaults || {}
      const picked = {}
      fields
        .filter((f) => f.kind === 'person' && values[f.token])
        .forEach((f) => {
          const cur = defaults[f.token]
          const sameAsDefault = cur != null && splitPhone(cur).phone === values[f.token]
          if (!sameAsDefault) picked[f.token] = values[f.token]
        })
      if (Object.keys(picked).length) {
        const preview = Object.entries(picked)
          .map(([tok, ph]) => `${fields.find((f) => f.token === tok)?.label || tok}：${phoneDisplay(ph)}`)
          .join('\n')
        modal.confirm({
          title: '是否将本次负责人保存为默认值？',
          content: <Text style={{ whiteSpace: 'pre-wrap' }}>{preview}</Text>,
          okText: '保存',
          cancelText: '不保存',
          onOk: async () => {
            const r = await window.api.dingtalk.saveDefaults({ templateId, defaults: picked })
            if (r.ok) message.success('已保存为默认值')
            else message.error(r.error || '保存失败')
          },
        })
      }
      onClose?.()
    } else {
      message.error({ content: `发送失败：${res.error}`, duration: 8 })
    }
  }

  const noGroups = groups.length === 0
  const noTemplates = templates.length === 0
  const tpl = templates.find((t) => t.id === templateId)
  // 提测为单项目：用当前选中项目 + 用户填的值实时渲染预览（与后端 gotest→fillTemplate 同源；
  // values 里已含 url/title（applyProject 预填）、person（手机号）、content（手输））。
  const PLACEHOLDER_RE = /\{\{\s*@(person|url|title|content|tapd|all)(\d*)\s*(?:as\s+(.+?))?\s*\}\}/g
  const rendered = (() => {
    if (!tpl || !selProject) return { text: '', atMobiles: [], isAtAll: false }
    const atMobiles = []
    let isAtAll = false
    const text = tpl.content.replace(PLACEHOLDER_RE, (_full, type, num) => {
      const token = `@${type}${num ?? ''}`
      if (type === 'person') {
        const phone = (values?.[token] ?? '').trim()
        if (phone) atMobiles.push(phone)
        return phone ? `@${phone}` : ''
      }
      if (type === 'all') {
        isAtAll = true
        return ''
      }
      return (values?.[token] ?? '').trim()
    })
    return { text, atMobiles, isAtAll }
  })()
  const preview = rendered.text

  const doCopy = async () => {
    if (!preview) return
    const res = await window.api.shell.copy(preview)
    if (res.ok) message.success('已复制到剪贴板')
    else message.error('复制失败')
  }

  return (
    <Modal
      title={`提测通知 - ${selProject?.description || selProject?.store || ''}`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      width={560}
    >
      <Form layout="vertical">
        <Form.Item label="本地项目" required>
          <Select
            showSearch
            placeholder="选择本地项目"
            value={selProject?.id}
            onChange={(id) => {
              const p = (projects || []).find((x) => x.id === id)
              setSelProject(p)
              // 模板已选时，切换项目重填 url/title；person/content 保持不动
              if (fields.length) setValues((s) => ({ ...s, ...applyProject(p, fields) }))
            }}
            options={(projects || []).map((p) => ({ value: p.id, label: p.description || p.store }))}
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="通知群" required>
          <Select
            placeholder={noGroups ? '请先在「通知群管理」添加群' : '选择通知群'}
            value={groupId}
            onChange={setGroupId}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            disabled={noGroups}
          />
        </Form.Item>
        <Form.Item label="消息模板" required>
          <Select
            placeholder={noTemplates ? '请先在「信息模板管理」添加模板' : '选择消息模板'}
            value={templateId}
            onChange={onTemplateChange}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
            disabled={noTemplates}
            loading={parsing}
          />
        </Form.Item>
        {fields.map((f) => (
          <Form.Item key={f.token} label={f.label} required={f.kind === 'person'}>
            {f.kind === 'person' ? (
              <Select
                showSearch
                placeholder="选择人员（按其手机号 @）"
                value={values[f.token]}
                onChange={(v) => setValues((s) => ({ ...s, [f.token]: v }))}
                options={(contacts || []).map((c) => ({ value: c.phone, label: `${c.name}（${c.phone}）` }))}
                optionFilterProp="label"
              />
            ) : f.kind === 'content' ? (
              <TextArea
                rows={2}
                placeholder="输入文本内容"
                value={values[f.token] || ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.token]: e.target.value }))}
              />
            ) : (
              <Input
                value={values[f.token] || ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.token]: e.target.value }))}
              />
            )}
          </Form.Item>
        ))}
        {(noGroups || noTemplates) && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            提示：需先在顶部「更多」里配置{noGroups ? '通知群' : ''}
            {noGroups && noTemplates ? '、' : ''}
            {noTemplates ? '信息模板' : ''}。
          </Text>
        )}
        <Form.Item label="通知内容预览（按所选项目填充）">
          <TextArea value={preview} readOnly autoSize={{ minRows: 4, maxRows: 12 }} placeholder="选择项目和模板后在此预览" />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={doCopy} disabled={!preview}>
            复制
          </Button>
          <Button type="primary" loading={loading} disabled={!groupId || !templateId} onClick={submit}>
            发送
          </Button>
        </div>
      </Form>
    </Modal>
  )
}

// 把 git 远程地址（SSH/HTTPS）归一化为 https，并拼出「当前分支」的 GitHub 页链接。
// 非 http(s)、缺分支或缺地址返回 null（不渲染链接）。SSH 形式浏览器打不开，必须转 https。
function githubTreeUrl(remoteUrl, branch) {
  if (!remoteUrl || !branch) return null
  let u = String(remoteUrl).trim().replace(/\.git$/, '')
  u = u.replace(/^git@([^:]+):/, 'https://$1/')
  u = u.replace(/^git:\/\//, 'https://')
  u = u.replace(/^ssh:\/\/(?:[^/@]+@)?/, 'https://')
  return /^https?:\/\//.test(u) ? `${u}/tree/${encodeURIComponent(branch)}` : null
}

// 把「切换分支 / 创建分支」后后端同步 toml 的结果转成反馈消息（applied / 无项目 / 模板缺失）。
// prefix 为「已切换到 X」/「已创建并切换到分支 X（已推送远程）」等前置文案。返回 null 表示无需额外提示：
// toml 被 git 跟踪（skipped:'tracked'）、或原本就没 toml（hadToml=false 的 no-project）。
// no-project 且 hadToml：原本有 toml、该分支无项目，已删除 toml → 提示用户在新分支重新初始化/保存。
function syncMessage(sync, prefix) {
  if (!sync) return null
  if (sync.applied) {
    const name = sync.project?.description || sync.project?.templateName || sync.project?.store || ''
    return { type: 'success', text: `${prefix}${name ? `，已套用项目「${name}」配置` : ''}` }
  }
  if (sync.reason === 'template-missing') {
    return { type: 'warning', text: `${prefix}，项目引用的模板「${sync.templateName}」已删除，配置未切换` }
  }
  if (sync.reason === 'no-project' && sync.hadToml) {
    return { type: 'info', text: `${prefix}，该分支无本地项目，已删除 shopify.theme.toml` }
  }
  return null
}

/* ---------------- 获取合并提交信息（第④步：多选当前分支项目，标题/工单去重，按模板生成合并通知） ---------------- */
function MergeInfoModal({ open, repo, projects, contacts, onClose }) {
  const { message, modal } = App.useApp()
  const [groups, setGroups] = useState([])
  const [templates, setTemplates] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [groupId, setGroupId] = useState()
  const [templateId, setTemplateId] = useState()
  const [fields, setFields] = useState([]) // parsePlaceholders 返回的字段（person/content 供用户填）
  const [values, setValues] = useState({}) // person/content 的 token -> 值
  const [customPreview, setCustomPreview] = useState(null) // 手动修改过的预览文本（null=未改，跟随合成结果）
  const [parsing, setParsing] = useState(false)
  const [loading, setLoading] = useState(false)
  // 两步式：0=合成信息（复制/推送群/下一步），1=提交 Pull Request（选分支、reviewer）
  const [step, setStep] = useState(0)

  // PR Reviewers：GitHub 协作者选择 + Token 管理
  const [members, setMembers] = useState([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [selectedMembers, setSelectedMembers] = useState([])
  const [token, setToken] = useState('')
  const [needToken, setNeedToken] = useState(false)
  const [savingToken, setSavingToken] = useState(false)
  const [showTokenHelp, setShowTokenHelp] = useState(false)
  // 提交 Pull Request：类型/标题/base；reviewer 复用 selectedMembers（必填）
  const [prType, setPrType] = useState('feat')
  const [prTitle, setPrTitle] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prLoading, setPrLoading] = useState(false)
  // 分支下拉（base 实时获取）：复用仓库卡片的分支懒加载逻辑
  const { local: branchesLocal, remote: branchesRemote, loading: branchLoading, reload: reloadBranches } = useRepoBranches(repo)

  // 打开时加载群+模板，重置选择；同时加载 GitHub 协作者
  useEffect(() => {
    if (!open) return
    let mounted = true
    ;(async () => {
      const res = await window.api.dingtalk.load()
      if (!mounted) return
      if (res.ok) {
        setGroups(res.data?.groups || [])
        setTemplates(res.data?.templates || [])
      }
      setGroupId(undefined)
      setTemplateId(undefined)
      setFields([])
      setValues({})
      setCustomPreview(null)
      setSelectedIds([])
      setSelectedMembers([])
      setToken('')
      setNeedToken(false)
      setShowTokenHelp(false)
      setPrType('feat')
      setPrTitle('')
      setPrBase('')
      setStep(0)
    })()

    const loadMembers = async () => {
      if (!repo?.path) return
      setLoadingMembers(true)
      setMembers([])
      const res = await window.api.repos.collaborators(repo.path)
      if (!mounted) return
      setLoadingMembers(false)
      if (res.ok) {
        setNeedToken(false)
        setMembers(res.data || [])
      } else {
        const noToken = res.error === 'NO_TOKEN'
        setNeedToken(noToken)
        if (!noToken) message.error(res.error || '拉取仓库成员失败')
      }
    }
    loadMembers()

    // 分支列表供第二步选 base（展开下拉时也会刷新）；base 不预设默认值，需用户显式选择
    reloadBranches()

    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  // 保存 token 到 settings.githubToken，成功后立即重拉成员
  const saveToken = async () => {
    const t = token.trim()
    if (!t) {
      message.warning('请先粘贴 token')
      return
    }
    setSavingToken(true)
    const res = await window.api.settings.set({ githubToken: t })
    setSavingToken(false)
    if (res?.ok) {
      message.success('Token 已保存，正在拉取成员…')
      setNeedToken(false)
      setShowTokenHelp(false)
      setLoadingMembers(true)
      const r2 = await window.api.repos.collaborators(repo.path)
      setLoadingMembers(false)
      if (r2.ok) {
        setMembers(r2.data || [])
      } else {
        message.error(r2.error || '拉取成员失败')
      }
    } else {
      message.error(res?.error || '保存失败')
    }
  }

  const selected = (projects || []).filter((p) => selectedIds.includes(p.id))
  const tpl = templates.find((t) => t.id === templateId)

  // 选模板：解析占位符（person/content 供用户填；title/tapd 由选中项目自动去重填充，不在表单展示）
  const onTemplateChange = async (id) => {
    setTemplateId(id)
    if (!id) {
      setFields([])
      return
    }
    setParsing(true)
    const res = await window.api.dingtalk.parsePlaceholders(id)
    setParsing(false)
    if (!res.ok) {
      message.error(res.error || '解析模板失败')
      return
    }
    setFields(res.data?.fields || [])
  }

  // 每个选中项目渲染一份模板（不去重，选几个项目就几份）：title=项目描述、url=预览链接、
  // tapd=工单链接；person/content 用用户输入（所有项目共用）；@all 由钉钉处理。
  const PLACEHOLDER_RE = /\{\{\s*@(person|url|title|content|tapd|all)(\d*)\s*(?:as\s+(.+?))?\s*\}\}/g
  const renderOne = (content, p) => {
    const atMobiles = []
    let isAtAll = false
    const text = content.replace(PLACEHOLDER_RE, (_full, type, num) => {
      const token = `@${type}${num ?? ''}`
      if (type === 'person') {
        const phone = (values?.[token] ?? '').trim()
        if (phone) atMobiles.push(phone)
        return phone ? `@${phone}` : ''
      }
      if (type === 'title') return p?.description || ''
      if (type === 'url') return p?.links?.previewLink || ''
      if (type === 'tapd') return p?._tapd || ''
      if (type === 'all') {
        isAtAll = true
        return ''
      }
      return (values?.[token] ?? '').trim()
    })
    return { text, atMobiles, isAtAll }
  }
  // 选 N 个项目 → N 份模板，空行分隔拼接；手机号/@all 合并（去重手机号）
  const rendered = (() => {
    if (!tpl || !selected.length) return { text: '', atMobiles: [], isAtAll: false }
    const parts = selected.map((p) => renderOne(tpl.content, p))
    return {
      text: parts.map((x) => x.text).join('\n\n'),
      atMobiles: [...new Set(parts.flatMap((x) => x.atMobiles))],
      isAtAll: parts.some((x) => x.isAtAll),
    }
  })()
  // 手动改过预览时以改后文本为准：@ 列表只保留最终文本里仍在的手机号（被删掉的不再 @）
  const preview = customPreview ?? rendered.text
  const atMobiles = customPreview == null ? rendered.atMobiles : rendered.atMobiles.filter((p) => preview.includes(`@${p}`))
  // 合成来源变化（改项目/模板/人员）时丢弃手动修改，预览跟随最新合成内容
  useEffect(() => {
    setCustomPreview(null)
  }, [rendered.text])
  // 第一步信息是否就绪：至少选一个项目 + 选了模板 + 必填人员都填了（与「发送到群」校验一致，但不要求选群）
  const step1Ready = selectedIds.length > 0 && !!templateId && !fields.some((f) => f.kind === 'person' && !values[f.token])
  // 当前分支的 GitHub 页链接（repo.remoteUrl 由 getRepoInfo 取 origin；点省略号在新标签打开）
  const branchUrl = githubTreeUrl(repo?.remoteUrl, repo?.currentBranch)

  const doCopy = async () => {
    if (!preview) return
    const res = await window.api.shell.copy(preview)
    if (res.ok) message.success('已复制到剪贴板')
    else message.error('复制失败')
  }

  const doSend = async () => {
    if (!selectedIds.length) return message.warning('请选择至少一个项目')
    if (!templateId) return message.warning('请选择消息模板')
    if (!groupId) return message.warning('请选择通知群')
    const missing = fields.find((f) => f.kind === 'person' && !values[f.token])
    if (missing) return message.warning(`请为「${missing.label}」选择人员`)
    setLoading(true)
    const res = await window.api.dingtalk.notify({ groupId, text: preview, atMobiles, isAtAll: rendered.isAtAll })
    setLoading(false)
    if (res.ok) {
      const g = groups.find((x) => x.id === groupId)
      message.success(`已发送到「${g?.name || '群'}」`)
      onClose?.()
    } else {
      message.error({ content: `发送失败：${res.error}`, duration: 8 })
    }
  }

  // 创建 Pull Request：body 复用上方预览文本；reviewer 选填；成功后弹窗给 PR 跳转地址并复制审核话术
  const doCreatePr = async () => {
    if (!repo?.currentBranch) return message.warning('当前仓库未检测到分支（PR head）')
    if (!prTitle.trim()) return message.warning('请填写 PR 标题')
    if (!prBase.trim()) return message.warning('请填写目标分支（base）')
    setPrLoading(true)
    const res = await window.api.repos.createPull({
      dir: repo.path,
      title: formatCommitTitle(prType, prTitle),
      head: repo.currentBranch,
      base: prBase.trim(),
      body: preview,
      reviewers: selectedMembers,
    })
    setPrLoading(false)
    if (!res.ok) {
      const netHint = /fetch|ENETUNREACH|ETIMEDOUT|ECONNRESET|getaddrinfo|network|网络/i.test(res.error || '') ? '（请确认已开启 VPN）' : ''
      message.error({ content: `创建 PR 失败：${res.error}${netHint}`, duration: 8 })
      return
    }
    const { url, reviewerWarning, reviewerFailed, reviewerError } = res.data || {}
    const cr = await window.api.shell.copy(`您好，${url}，需要您这边审核下`)
    const copied = !!cr?.ok
    modal.success({
      title: 'Pull Request 已创建',
      width: 520,
      content: (
        <div>
          {reviewerWarning && (
            <div style={{ marginBottom: 8 }}>
              <Text type="warning">
                部分 Reviewer 请求失败{Array.isArray(reviewerFailed) && reviewerFailed.length ? `（未能添加：${reviewerFailed.join('、')}）` : ''}
                {reviewerError ? `，原因：${reviewerError}` : ''}，请到 GitHub 手动补加。
              </Text>
            </div>
          )}
          <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
            PR 跳转地址：
          </Text>
          <ALink
            style={{ wordBreak: 'break-all' }}
            onClick={async () => {
              const r = await window.api.shell.openExternal(url)
              if (!r?.ok) message.error('打开链接失败')
            }}
          >
            {url}
          </ALink>
          <div style={{ marginTop: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {copied ? '审核话术已复制到剪贴板' : '审核话术复制失败，可点上方链接手动复制'}
            </Text>
          </div>
        </div>
      ),
      okText: '前往 PR',
      onOk: async () => {
        const r = await window.api.shell.openExternal(url)
        if (!r?.ok) message.error('打开链接失败')
      },
    })
    onClose?.()
  }

  const noGroups = groups.length === 0
  const noTemplates = templates.length === 0
  const inputFields = fields.filter((f) => f.kind === 'person' || f.kind === 'content')

  return (
    <Modal title={`获取合并提交信息 - ${repo?.name || ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose width={620}>
      <Form layout="vertical">
        <Steps
          size="small"
          current={step}
          style={{ marginBottom: 20 }}
          items={[{ title: '合成信息' }, { title: '提交 Pull Request' }]}
        />
        {step === 0 && (
          <>
            <Form.Item label="本地项目（多选）" required>
          <Select
            mode="multiple"
            showSearch
            maxTagCount="responsive"
            placeholder="选择当前分支下的本地项目"
            value={selectedIds}
            onChange={setSelectedIds}
            options={(projects || []).map((p) => ({ value: p.id, label: p.description || p.store }))}
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="消息模板" required>
          <Select
            placeholder={noTemplates ? '请先在「信息模板管理」添加模板' : '选择消息模板'}
            value={templateId}
            onChange={onTemplateChange}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
            disabled={noTemplates}
            loading={parsing}
          />
        </Form.Item>
        {inputFields.map((f) => (
          <Form.Item key={f.token} label={f.label} required={f.kind === 'person'}>
            {f.kind === 'person' ? (
              <Select
                showSearch
                placeholder="选择人员（按其手机号 @）"
                value={values[f.token]}
                onChange={(v) => setValues((s) => ({ ...s, [f.token]: v }))}
                options={(contacts || []).map((c) => ({ value: c.phone, label: `${c.name}（${c.phone}）` }))}
                optionFilterProp="label"
              />
            ) : (
              <TextArea
                rows={2}
                placeholder="输入文本内容"
                value={values[f.token] || ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.token]: e.target.value }))}
              />
            )}
          </Form.Item>
        ))}
          </>
        )}
        {step === 1 && (
          <>
            {/* Reviewer 与分支选择放在第二步（提交 PR）；reviewer 选填，但拉取成员需 VPN */}
            <Form.Item
              label="PR Reviewers（GitHub 协作者，选填）"
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <Text type="warning">⚠️ 需开启 VPN</Text> 才能访问 GitHub 拉取仓库成员，否则会拉取失败；成员可留空（非必填）。
                </Text>
              }
            >
          {needToken ? (
            <div>
              <Text style={{ display: 'block', marginBottom: 8 }}>
                拉取仓库成员需要一个 <Text strong>GitHub Token</Text>（仅本机自用，明文存于本地配置）。
              </Text>
              <Input.Password
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_... / github_pat_..."
                style={{ marginBottom: 12 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <Button type="primary" loading={savingToken} onClick={saveToken}>
                  保存并拉取
                </Button>
              </div>
              <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                <Text strong>怎么获取：</Text>
                <br />
                1. 打开{' '}
                <ALink
                  onClick={async () => {
                    const r = await window.api.shell.openExternal(
                      'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Shopify%20Toolbox',
                    )
                    if (!r?.ok) message.error('打开链接失败')
                  }}
                >
                  GitHub 新建 Token 页 ↗
                </ALink>
                <br />
                2. Note 随便填（如「Shopify Toolbox」）；<Text strong>勾选 <Text code>repo</Text></Text>（私有仓读权限）；
                <br />
                3. 拉到底点 <Text code>Generate token</Text>，复制 <Text code>ghp_...</Text> 粘贴到上方。
                <br />
                4. 若保存后仍报 404，说明该 Token 账号不是仓库协作者，或 Token 未勾选 repo 权限。
                <br />
                <br />
                <Text type="warning">⚠️ Token 等同于账号密码，请勿分享/提交到仓库。若保存后仍提示 404，请确认该 Token 对应账号已是仓库协作者。</Text>
              </Text>
            </div>
          ) : (
            <div>
              <Spin spinning={loadingMembers}>
                <Select
                  mode="multiple"
                  showSearch
                  maxTagCount="responsive"
                  allowClear
                  placeholder={loadingMembers ? '加载中…' : members.length ? '选择 PR Reviewers（多选）' : '未拉取到成员（仓库需为 GitHub）'}
                  value={selectedMembers}
                  onChange={setSelectedMembers}
                  options={members.map((m) => ({ value: m.login, label: m.login }))}
                  optionFilterProp="label"
                  notFoundContent={loadingMembers ? '加载中…' : '无成员'}
                  optionRender={(option) => {
                    const m = members.find((x) => x.login === option.data.value)
                    return (
                      <Space size={8} align="center">
                        <Avatar size={20} src={m?.avatar} />
                        <span>{option.data.label}</span>
                      </Space>
                    )
                  }}
                />
              </Spin>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <ALink
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    setNeedToken(true)
                    setToken('')
                    setShowTokenHelp(false)
                  }}
                >
                  换/填 GitHub Token
                </ALink>
                <ALink style={{ fontSize: 12 }} onClick={() => setShowTokenHelp((s) => !s)}>
                  <QuestionCircleOutlined style={{ marginRight: 4 }} />
                  如何获取 GitHub Token？
                </ALink>
              </div>
              {showTokenHelp && (
                <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 12 }}>
                  <Text strong>怎么获取：</Text>
                  <br />
                  1. 打开{' '}
                  <ALink
                    onClick={async () => {
                      const r = await window.api.shell.openExternal(
                        'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Shopify%20Toolbox',
                      )
                      if (!r?.ok) message.error('打开链接失败')
                    }}
                  >
                    GitHub 新建 Token 页 ↗
                  </ALink>
                  <br />
                  2. Note 随便填（如「Shopify Toolbox」）；<Text strong>勾选 <Text code>repo</Text></Text>（私有仓读权限）；
                  <br />
                  3. 拉到底点 <Text code>Generate token</Text>，复制 <Text code>ghp_...</Text> 粘贴到上方。
                <br />
                4. 若保存后仍报 404，说明该 Token 账号不是仓库协作者，或 Token 未勾选 repo 权限。
                  <br />
                  <br />
                  <Text type="warning">⚠️ Token 等同于账号密码，请勿分享/提交到仓库。若保存后仍提示 404，请确认该 Token 对应账号已是仓库协作者。</Text>
                </Text>
              )}
            </div>
          )}
        </Form.Item>
          </>
        )}
        {step === 0 && (
          <>
            <Form.Item label="通知群（发送用，不选则只复制）">
          <Select
            allowClear
            placeholder={noGroups ? '请先在「通知群管理」添加群' : '选择要发送的群（可留空仅复制）'}
            value={groupId}
            onChange={setGroupId}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            disabled={noGroups}
          />
        </Form.Item>
        {branchUrl && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12 }}>
            <Text type="secondary">当前分支：</Text>
            <ALink
              onClick={async () => {
                const res = await window.api.shell.openExternal(branchUrl)
                if (!res?.ok) message.error('打开链接失败')
              }}
              title={branchUrl}
            >
              {repo?.currentBranch} ↗
            </ALink>
          </div>
        )}
        <Form.Item
          label="通知内容预览（每个项目一份，按项目填充，可直接修改）"
          extra={
            customPreview != null && rendered.text ? (
              <ALink style={{ fontSize: 12 }} onClick={() => setCustomPreview(null)}>
                已手动修改，点击恢复合成内容
              </ALink>
            ) : null
          }
        >
          <TextArea
            value={preview}
            onChange={(e) => setCustomPreview(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 12 }}
            placeholder="选择项目和模板后在此预览，可手动修改后再复制/发送"
          />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={doCopy} disabled={!preview}>
            复制
          </Button>
          <Button type="primary" loading={loading} disabled={!preview || !groupId} onClick={doSend}>
            发送到群
          </Button>
          <Tooltip title={step1Ready ? '' : '请先选择项目、模板并填写人员，再进入下一步'}>
            <span>
              <Button type="primary" ghost disabled={!step1Ready} onClick={() => setStep(1)}>
                下一步
              </Button>
            </span>
          </Tooltip>
        </div>
        {(noGroups || noTemplates) && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
            提示：需先在顶部「更多」里配置{noGroups ? '通知群' : ''}
            {noGroups && noTemplates ? '、' : ''}
            {noTemplates ? '信息模板' : ''}。
          </Text>
        )}
          </>
        )}
        {step === 1 && (
          <>
        {/* 提交 Pull Request：类型+标题（项目下拉填充）+base（选分支，无默认值）+reviewer（必选）→ 创建 PR 并复制审核话术 */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px dashed rgba(255,255,255,0.12)' }}>
          <Text strong style={{ display: 'block', marginBottom: 12 }}>
            提交 Pull Request
          </Text>
          <Form.Item label="Commit 类型">
            <Select
              value={prType}
              onChange={setPrType}
              options={COMMIT_TYPES.map((t) => ({ value: t.value, label: `${t.value}（${t.desc}）` }))}
            />
          </Form.Item>
          <Form.Item label="PR 标题（左：选项目自动填充；右：可手改）" required>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                style={{ width: '42%' }}
                allowClear
                showSearch
                placeholder="选项目填充标题"
                optionFilterProp="label"
                options={(projects || []).map((p) => ({ value: p.id, label: p.description || p.store }))}
                onChange={(id) => {
                  if (!id) return
                  const p = (projects || []).find((x) => x.id === id)
                  setPrTitle(p?.description || '')
                }}
              />
              <Input
                style={{ width: '58%' }}
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="如：新增秒杀模块"
              />
            </Space.Compact>
          </Form.Item>
          <Form.Item label="目标分支（base）" required>
            <Select
              showSearch
              loading={branchLoading}
              placeholder="选择目标分支（展开自动 fetch origin）"
              popupMatchSelectWidth={false}
              value={prBase || undefined}
              onChange={setPrBase}
              onDropdownVisibleChange={(o) => o && reloadBranches()}
              notFoundContent={branchLoading ? '加载中…' : '无分支'}
            >
              {branchesLocal.length > 0 && (
                <Select.OptGroup label="本地分支">
                  {branchesLocal.map((b) => (
                    <Select.Option key={`l/${b}`} value={b}>
                      {b}
                    </Select.Option>
                  ))}
                </Select.OptGroup>
              )}
              {branchesRemote.length > 0 && (
                <Select.OptGroup label="远程分支">
                  {branchesRemote.map((b) => (
                    <Select.Option key={`r/${b}`} value={b}>
                      {b}
                    </Select.Option>
                  ))}
                </Select.OptGroup>
              )}
            </Select>
          </Form.Item>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              PR 合并方向：
            </Text>
            <Tag color="orange">{repo?.currentBranch || '当前分支'}</Tag>
            <ArrowRightOutlined style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }} />
            <Tag color="purple">{prBase || '目标分支'}</Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              最终标题：<Text code>{prTitle.trim() ? formatCommitTitle(prType, prTitle) : `${prType}: ...`}</Text>
            </Text>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Tooltip title={needToken ? '创建 PR 需先配置 GitHub Token' : ''}>
              <span>
                <Button type="primary" loading={prLoading} disabled={needToken} onClick={doCreatePr}>
                  提交 Pull Request
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>
          </>
        )}
      </Form>
    </Modal>
  )
}

/* ---------------- 拉取分支（新功能/紧急热修复/缺陷修复） ---------------- */
const BRANCH_TYPES = [
  { value: 'feature', label: '新功能' },
  { value: 'hotfix', label: '紧急热修复' },
  { value: 'fix', label: '缺陷修复' },
]

/**
 * 仓库分支实时获取：与仓库卡片外的分支下拉框逻辑完全一致。
 * 调 repos.remoteBranches（内部会 git fetch origin），拿到本地分支 + 远程分支
 * （远程去掉与本地同名的）。reload 既用于弹窗打开时加载，也用于下拉展开时刷新；
 * 它返回本次 fetch 的快照（含 current），供调用方在加载完成那一刻回填表单值——
 * 因为 state 的更新要等下一次渲染，effect 内拿不到最新列表。
 */
function useRepoBranches(repo) {
  const [local, setLocal] = useState([])
  const [remote, setRemote] = useState([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!repo?.path) return null
    setLoading(true)
    const res = await window.api.repos.remoteBranches(repo.path)
    setLoading(false)
    if (!res.ok) return null
    const { current, local: l = [], remote: r = [] } = res.data || {}
    // 远程分支保持齐全（不去除本地已有的同名分支）：基准分支常需选 origin/master 等，
    // 去重会让本地已有的 master 在远程组消失。
    setLocal(l)
    setRemote(r)
    return { current: current || null, local: l, remote: r }
  }, [repo])

  return { local, remote, loading, reload }
}

function CreateBranchModal({ open, repo, onClose, onDone, contacts }) {
  const { message } = App.useApp()
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const type = Form.useWatch('type', form)
  const person = Form.useWatch('person', form)
  const reqno = Form.useWatch('reqno', form)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ type: 'feature', person: '', reqno: '' })
    // 加载分支列表供下拉选择；基准分支不预设默认值，需用户显式选择
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  const branchName = type && person && reqno ? `dev/${type}-${person}-${reqno}` : ''

  const submit = async (vals) => {
    setLoading(true)
    // push=true：后端先校验远程是否已存在该分支（存在则拒绝创建并提示），再创建本地分支并推到远程。
    // 创建后同样按新分支同步 toml（新分支无项目→清配置），反馈与 checkout 一致。
    const res = await window.api.repos.createBranch({ dir: repo.path, base: vals.base, name: branchName, push: true })
    setLoading(false)
    if (!res.ok) {
      message.error(res.error || '创建失败')
      return
    }
    const prefix = `已创建并切换到分支 ${branchName}（已推送远程）`
    const m = syncMessage(res.data?.sync, prefix)
    if (m) message[m.type](m.text)
    else message.success(prefix)
    onDone?.()
  }

  return (
    <Modal title={`拉取分支 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ type: 'feature' }}>
        <Form.Item name="base" label="基准分支" rules={[{ required: true, message: '请选择基准分支' }]}>
          <Select
            showSearch
            loading={branchLoading}
            placeholder="选择基准分支（展开自动 fetch origin）"
            popupMatchSelectWidth={false}
            onDropdownVisibleChange={(o) => o && reload()}
          >
            {local.length > 0 && (
              <Select.OptGroup label="本地分支">
                {local.map((b) => (
                  <Select.Option key={`l/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
            {remote.length > 0 && (
              <Select.OptGroup label="远程分支">
                {remote.map((b) => (
                  <Select.Option key={`r/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
          </Select>
        </Form.Item>
        <Form.Item name="type" label="类型" rules={[{ required: true }]}>
          <Radio.Group>
            {BRANCH_TYPES.map((t) => (
              <Radio key={t.value} value={t.value}>
                {t.label}
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        <Form.Item name="person" label="负责人" rules={[{ required: true, message: '请选择负责人' }]}>
          <AutoComplete
            options={(contacts || []).map((c) => ({ value: c.name }))}
            filterOption={(v, o) => String(o.value).toLowerCase().includes(String(v).toLowerCase())}
            style={{ width: '100%' }}
          >
            <Input placeholder="从人员配置选择或手输（用于分支命名）" />
          </AutoComplete>
        </Form.Item>
        <Form.Item name="reqno" label="需求编号" rules={[{ required: true, message: '请输入需求编号' }]}>
          <Input placeholder="如 1024" />
        </Form.Item>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          分支名预览：<Text code>{branchName || 'dev/{type}-{负责人}-{编号}'}</Text>
        </Text>
        <Button type="primary" htmlType="submit" loading={loading}>
          创建分支
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- Git 流程：阶段式流程卡（开发→提测→合并信息） ---------------- */
// 三段彩色卡片用箭头串联，结构同构：序号+图标+动作标题+阶段副标题，整卡可点击（禁用则置灰+tooltip）。
// ①开发·拉分支 → ②开发完·提测 → ③上线前·合并信息。
function FlowArrow() {
  return <ArrowRightOutlined style={{ fontSize: 12, color: '#c9cdd4', flexShrink: 0, alignSelf: 'center' }} />
}

function StageCard({ index, color, stageName, title, disabled, tooltip, onClick, footer }) {
  const [hover, setHover] = useState(false)
  const interactive = !!onClick && !disabled
  const border = disabled ? 'rgba(255,255,255,0.12)' : hover && interactive ? color : `${color}66`
  const card = (
    <div
      style={{
        position: 'relative',
        flex: '1 1 0',
        minWidth: 0,
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${border}`,
        background: interactive && hover ? `${color}33` : disabled ? 'rgba(255,255,255,0.04)' : `${color}22`,
        opacity: disabled ? 0.55 : 1,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color .2s, background .2s',
        overflow: 'hidden',
      }}
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={interactive ? onClick : undefined}
    >
      {/* 阶段名做成水印：右上角圆章，虚线描边、整体极淡并斜置，作水印叠在卡上不占布局 */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: `1px dashed ${disabled ? 'rgba(255,255,255,0.22)' : `${color}99`}`,
          color: disabled ? 'rgba(255,255,255,0.4)' : color,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 2,
          writingMode: 'vertical-rl',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.28,
          transform: 'rotate(-14deg)',
          background: 'transparent',
          pointerEvents: 'none',
        }}
      >
        {stageName}
      </span>
      {/* 序号 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 11,
            background: disabled ? '#d9d9d9' : color,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {index}
        </span>
      </div>
      {/* 动作标题：完整显示，窄卡内自动换行 */}
      <Text strong style={{ fontSize: 14, display: 'block', wordBreak: 'break-word', lineHeight: 1.3 }}>
        {title}
      </Text>
      {footer}
    </div>
  )
  return tooltip ? <Tooltip title={tooltip}>{card}</Tooltip> : card
}

function GitFlowSteps({ repo, project, projects, onAction }) {
  const hasProject = !!project
  // 当前分支下的本地项目：第③步「合并信息」的候选来源（不要求含工单链接）；无则置灰
  const branchProjects = (projects || []).filter((p) => p.description)
  const noProjects = branchProjects.length === 0

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, position: 'relative' }}>
      <StageCard
        index={1}
        color="#1677ff"
        title="拉取分支"
        stageName="开发"
        onClick={() => onAction('branch', repo)}
      />
      <FlowArrow />
      <StageCard
        index={2}
        color="#fa8c16"
        title="提测"
        stageName="开发完"
        disabled={!hasProject}
        tooltip={!hasProject ? '先本地保存为项目' : '发钉钉提测通知'}
        onClick={() => onAction('gotest', project)}
      />
      <FlowArrow />
      <StageCard
        index={3}
        color="#722ed1"
        title="合并信息"
        stageName="上线前"
        disabled={noProjects}
        tooltip={noProjects ? '当前分支下没有本地项目' : '汇总多个项目的标题/工单，按模板生成合并通知'}
        onClick={() => onAction('mergeInfo', repo)}
      />
    </div>
  )
}

/* ---------------- 仓库卡片（已配对项目则内嵌项目面板，圈在一起） ---------------- */
/* ---------------- 用编辑器打开仓库目录 ----------------
 * 配了默认编辑器→一键打开（核心诉求：用"配置的"编辑器）；未配→展开本机编辑器列表（懒加载）让选，
 * 不至于在没设默认时卡住。打开走主进程 openInEditor（detached，不阻塞 UI）。
 */
function OpenEditorButton({ dir, defaultEditor }) {
  const { message } = App.useApp()
  const [editors, setEditors] = useState(null) // null=未加载；[]=已加载但无
  const [menuOpen, setMenuOpen] = useState(false)

  const ensureEditors = async () => {
    if (editors !== null) return
    const res = await window.api.repos.editors()
    setEditors(res.ok ? res.data || [] : [])
  }

  const openWith = async (editorId) => {
    setMenuOpen(false)
    const res = await window.api.repos.openInEditor({ dir, editorId })
    if (!res.ok) message.error(res.error || '打开失败')
  }

  const onClick = async () => {
    // 有默认编辑器：一键打开，不展开菜单
    if (defaultEditor) {
      const res = await window.api.repos.openInEditor({ dir, editorId: defaultEditor })
      if (!res.ok) message.error(res.error || '打开失败')
      return
    }
    // 无默认：展开列表让选
    await ensureEditors()
    setMenuOpen(true)
  }

  const onOpenChange = (v) => {
    if (defaultEditor) return // 配了默认时点击是一键打开，不接管菜单开合
    if (v) ensureEditors()
    setMenuOpen(v)
  }

  const list = editors || []
  const menuItems = list.length
    ? list.map((ed) => ({ key: ed.id, label: ed.name, onClick: () => openWith(ed.id) }))
    : [{ key: '_none', label: '未检测到编辑器', disabled: true }]

  return (
    <Tooltip title={defaultEditor ? '用默认编辑器打开' : '选择编辑器打开'}>
      <Dropdown menu={{ items: menuItems }} open={menuOpen} onOpenChange={onOpenChange} trigger={['click']}>
        <Button
          type="text"
          size="small"
          icon={<FolderOpenOutlined />}
          onClick={onClick}
          style={{ color: 'rgba(255,255,255,0.65)', flexShrink: 0 }}
        />
      </Dropdown>
    </Tooltip>
  )
}

function RepoCard({ repo, projects, onAction, onProjectAction, branchProjectCounts, themeProjectCounts, defaultEditor }) {
  const { message } = App.useApp()
  const [hovered, setHovered] = useState(false) // 玻璃亮光 hover 态（仅本卡重渲，不影响其它卡片）

  // 后台链接：同一 store 下所有项目共享，提升到仓库卡片，避免每个项目面板重复显示。
  const storeName = repo.devEnv?.store?.split('.')[0]
  const adminLink = storeName ? `https://admin.shopify.com/store/${storeName}/themes` : null
  // GitHub 当前分支链接。
  const githubUrl = githubTreeUrl(repo.remoteUrl, repo.currentBranch)

  const openLink = async (url, label) => {
    if (!url) return
    const res = await window.api.shell.copy(url)
    await window.api.shell.openExternal(url)
    if (res?.ok) message.success(`已复制${label}并在默认浏览器打开`)
  }

  // 下拉展开时实时获取分支（不缓存）：每次 reload 直连 listAllBranches，其 local/remote 均已
  // 去重；不再用仓库列表里那份可能过时/带重复的 repo.branches 缓存来渲染下拉。
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)

  // 分组下拉数据：本地 / 远程，每个分支附该分支绑定的本地项目数（n>0 才显蓝标）。
  // 用 options + optionRender：optionRender 仅负责下拉项外观，value/label 始终是纯分支名，
  // 选中框由 labelRender 显示纯分支名，checkout 拿到的 value 不受任何影响。
  // 本地分支再 Set 去重一次（防御）；远程组保留全部——本地已有同名的，远程组也照常显示。
  const localBranches = [...new Set(local || [])]
  const branchOptions = []
  if (localBranches.length) {
    branchOptions.push({
      label: '本地分支',
      options: localBranches.map((b) => ({ value: b, label: b, count: branchProjectCounts?.[b] || 0 })),
    })
  }
  if ((remote || []).length) {
    branchOptions.push({
      label: '远程分支',
      options: (remote || []).map((b) => ({ value: b, label: b, count: branchProjectCounts?.[b] || 0 })),
    })
  }

  // 本地保存不再因 matched 禁用：已保存过的仓库也可打开表单改字段另存为新项目
  // （与现有项目完全一致时由 SaveRepoModal 提交判重拦截）。仅无 dev 环境时禁用（无处可存）。
  const saveBtn = (
    <Button size="small" type="primary" disabled={!repo.devEnv} onClick={() => onAction('save', repo)}>
      本地保存
    </Button>
  )

  // 当前生效（toml dev 段对应）的项目：仅用于面板「当前生效」标识，不改变展示顺序
  const matchedId = repo.matched?.id

  // 引用图：打开独立窗口（标题=仓库名，窗口内自己加载数据/显示进度/支持模糊搜索）；
  // 同仓库重复点击聚焦已开窗口，主窗口不再 loading
  const openDepGraph = async () => {
    const res = await window.api.repos.openDepGraph({ dir: repo.path, name: repo.name })
    if (!res.ok) message.error(res.error || '打开失败')
  }

  return (
    <Card
      size="small"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...GLASS,
        ...(hovered ? HOVER_GLASS : {}), // hover 时提亮底色/描边/高光，覆盖 GLASS 同名属性
        borderRadius: 16,
        transition: 'background .25s ease, border-color .25s ease, box-shadow .25s ease',
        transform: undefined,
      }}
      title={
        <Space size={6} style={{ alignItems: 'baseline' }}>
          <Text strong>{repo.name}</Text>
          <Text style={{ fontSize: 12, color: '#69b1ff' }}>{repo.branchCount} 分支</Text>
        </Space>
      }
      extra={
        <Select
          size="small"
          showSearch
          loading={branchLoading}
          value={repo.currentBranch || undefined}
          placeholder="切换分支"
          style={{ minWidth: 160, maxWidth: 260 }}
          popupMatchSelectWidth={false}
          options={branchOptions}
          optionFilterProp="label"
          onDropdownVisibleChange={(open) => open && reload()}
          onChange={(b) => onAction('checkout', { repo, branch: b })}
          optionRender={(option) => {
            // rc-select 把 option 扁平化为 { data, label, value, ... }：自定义字段在 option.data，
            // label/value 被提到顶层。所以 count 取 option.data.count，label 用 option.label。
            const count = option?.data?.count ?? 0
            return (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                {count > 0 && (
                  <span
                    title={`${count} 个本地项目`}
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      lineHeight: '16px',
                      height: 16,
                      minWidth: 16,
                      padding: '0 5px',
                      borderRadius: 8,
                      background: 'rgba(22,119,255,0.22)',
                      color: '#69b1ff',
                      textAlign: 'center',
                    }}
                  >
                    {count}
                  </span>
                )}
              </div>
            )
          }}
          labelRender={(props) => props.value ?? props.label}
        />
      }
    >
      <div style={{ position: 'relative' }}>
        {/* GitHub 彩带：右上角斜向入口，跳转到当前分支的 GitHub 页面 */}
        {githubUrl && (
          <Tooltip title="在 GitHub 查看当前分支">
            <div
              onClick={() => openLink(githubUrl, 'GitHub 链接')}
              style={{
                position: 'absolute',
                top: -10,
                right: -10,
                width: 70,
                height: 70,
                overflow: 'hidden',
                zIndex: 1,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <span
                style={{
                  display: 'block',
                  position: 'absolute',
                  top: 12,
                  right: -20,
                  width: 96,
                  textAlign: 'center',
                  transform: 'rotate(45deg)',
                  background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  lineHeight: '22px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                }}
              >
                <GithubOutlined style={{ marginRight: 2 }} />
                GitHub
              </span>
            </div>
          </Tooltip>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingRight: githubUrl ? 44 : 0 }}>
          <Tooltip title={repo.path}>
            <div
              style={{
                minWidth: 0,
                fontSize: 12,
                color: 'rgba(255,255,255,0.45)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {repo.path}
            </div>
          </Tooltip>
          <OpenEditorButton dir={repo.path} defaultEditor={defaultEditor} />
          {adminLink && (
            <Tooltip title="打开 Shopify 后台">
              <Button
                type="text"
                size="small"
                icon={<DashboardOutlined />}
                onClick={() => openLink(adminLink, '后台链接')}
                style={{ color: '#faad14', flexShrink: 0 }}
              />
            </Tooltip>
          )}
        </div>

        {/* 配置操作 */}
        <div style={{ marginBottom: 14 }}>
          <SectionLabel color="#1677ff">配置操作</SectionLabel>
          <Space wrap size={[6, 6]}>
            {!repo.hasToml ? (
              <Button size="small" type="primary" onClick={() => onAction('init', repo)}>
                初始化
              </Button>
            ) : (
              <>
                {saveBtn}
                <Tooltip title="已有配置文件，无需初始化">
                  <span>
                    <Button size="small" disabled>
                      初始化
                    </Button>
                  </span>
                </Tooltip>
              </>
            )}
            <Tooltip title="在新窗口打开文件引用关系图（支持文件名模糊搜索，结果缓存）">
              <Button size="small" icon={<DeploymentUnitOutlined />} onClick={openDepGraph}>
                引用图
              </Button>
            </Tooltip>
          </Space>
        </div>

        {/* Git 流程：开发→拉分支 / 开发完→提测 / 上线前→合并信息 */}
        <div>
          <SectionLabel color="#52c41a">Git 流程</SectionLabel>
          <GitFlowSteps repo={repo} project={repo.matched} projects={projects} onAction={onAction} />
        </div>

        {/* 关联的本地项目：同 store 的多条都内嵌展示，保持原顺序不置顶 */}
        {projects.map((p) => (
          <ProjectPanel
            key={p.id}
            project={p}
            onAction={onProjectAction}
            active={p.id === matchedId}
            embedded
            themeProjectCount={themeProjectCounts?.get(`${p.store}|${String(p.theme ?? '').trim()}`) || 0}
          />
        ))}
      </div>
    </Card>
  )
}

/* ---------------- 编辑本地项目（仅 非 _ 开头的字段；store 变动自动重算模板） ---------------- */
const EDIT_LABELS = {
  description: '项目描述',
  store: 'store',
  domain: 'domain',
  theme: 'theme',
  previewKey: 'preview_key',
  port: 'port',
}
const EDIT_ORDER = ['description', 'store', 'domain', 'theme', 'previewKey', 'port']
// 排除：以 _ 开头的只读字段（如 _branch）、id（主键）、派生/注入字段
const EDIT_SKIP = new Set(['id', 'envName', 'templateName', 'links', 'repoPath', 'changedJson'])
// 纯展示字段：store/domain 为项目身份标识，不可编辑（不绑定 name，提交时不传）
const EDIT_READONLY = new Set(['store', 'domain'])

function EditProjectModal({ open, project, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const editableKeys = (Object.keys(project || {}) || [])
    // previewPath 单独固定渲染（下方专属 Form.Item）：老项目记录里没有这个 key，
    // 走自动生成会漏掉字段，导致已存项目无法补填网页路径
    .filter((k) => !k.startsWith('_') && !EDIT_SKIP.has(k) && k !== 'previewPath')
    .sort((a, b) => {
      const ia = EDIT_ORDER.indexOf(a)
      const ib = EDIT_ORDER.indexOf(b)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return a.localeCompare(b)
    })

  useEffect(() => {
    if (open && project) {
      const vals = {}
      editableKeys.forEach((k) => {
        vals[k] = project[k] != null ? String(project[k]) : ''
      })
      // 工单（_ 开头字段被 editableKeys 过滤掉）与网页路径（老项目无此 key）单独回填，允许编辑。
      // 工单用选择器组件（值 { title, url }），回填只给链接（标题不参与，项目描述是独立字段）
      vals._tapd = project._tapd ? { title: '', url: String(project._tapd) } : null
      vals.previewPath = project.previewPath ?? ''
      form.setFieldsValue(vals)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])

  const submit = async (vals) => {
    setLoading(true)
    // 工单字段是选择器的 { title, url } 对象，这里只取链接存 _tapd；
    // 清空（null）传空串，与原先 Input 清空行为一致
    const payload = { ...vals, _tapd: vals._tapd?.url || '' }
    // 传 repoPath：后端据此在「当前生效」时回写该仓库 shopify.theme.toml（保持配置与项目一致）
    const res = await window.api.shops.update(project.id, payload, project.repoPath)
    setLoading(false)
    if (res.ok) {
      message.success('已更新')
      onDone?.()
    } else {
      message.error(res.error || '更新失败')
    }
  }

  return (
    <Modal
      title={`编辑项目 - ${project?.description || project?.store || ''}`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        {editableKeys.map((k) =>
          EDIT_READONLY.has(k) ? (
            <Form.Item key={k} label={EDIT_LABELS[k] || k}>
              <Input value={project?.[k] != null ? String(project[k]) : ''} disabled />
            </Form.Item>
          ) : (
            <Form.Item
              key={k}
              name={k}
              label={EDIT_LABELS[k] || k}
              rules={k === 'port' ? [{ pattern: /^\d*$/, message: '需为数字' }] : undefined}
            >
              <Input />
            </Form.Item>
          ),
        )}
        <Form.Item
          name="previewPath"
          label="网页路径（选填）"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              如 /pages/back-to-school-sale；无 preview_key 时拼到预览/开发链接，编辑器链接挂 previewPath 参数
            </Text>
          }
        >
          <Input placeholder="/pages/xxx" />
        </Form.Item>
        <Form.Item name="_tapd" label="工单（选填）">
          <WorkItemSelect
            initialUrl={project?._tapd ? String(project._tapd) : ''}
            footerHint="仅保存工单链接（重新选择或粘贴新链接即替换）；活动标题请维护上方「项目描述」"
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 配置信息块：两列 key-value，value 可点击复制 ---------------- */
const INFO_BLOCK = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '6px 16px',
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.05)',
  borderRadius: 6,
  marginBottom: 10,
}

function InfoField({ label, value, copyable }) {
  const { message } = App.useApp()
  const empty = value == null || value === ''
  const interactive = copyable && !empty
  // 用 block 级 flex（而非 Space 的 inline-flex）：grid 窄列里 inline-flex + minWidth:0 会
  // 塌缩到约一个字符宽，导致标签逐字换行、长值竖排堆叠。这里 label 锁死不缩不换行，
  // value 占满剩余宽度并在溢出时省略，保证两列布局在任何列宽下都稳定。
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        cursor: interactive ? 'pointer' : 'default',
      }}
      title={interactive ? '点击复制' : undefined}
      onClick={
        interactive
          ? async () => {
              const res = await window.api.shell.copy(value)
              if (res?.ok) message.success(`${label} 已复制`)
            }
          : undefined
      }
    >
      <Text type="secondary" style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 12,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {empty ? '-' : String(value)}
      </Text>
    </div>
  )
}

/* ---------------- 本地项目面板（仓库卡内嵌=圈起来；独立分区=无外框卡） ---------------- */
// 项目面板的三个快捷链接（开发 / 提测 / 编辑器）：彩色 chip，各自配色在深色 glass 卡片上清晰可辨。
// urlKey 对应 project.links 的字段；缺链接时渲染为禁用态（不可点、灰显）。
// 注：「后台」链接不在此列——同一 store 下所有项目共享同一后台地址，已提升到仓库卡片统一展示（见 RepoCard 的 adminLink）。
const QUICK_LINKS = [
  { key: 'dev', label: '开发', Icon: CodeOutlined, urlKey: 'devLink', color: '#52c41a', copyLabel: '开发链接' },
  { key: 'preview', label: '预览', Icon: EyeOutlined, urlKey: 'previewLink', color: '#36cfc9', copyLabel: '提测链接' },
  { key: 'editor', label: '编辑器', Icon: FormatPainterOutlined, urlKey: 'editorLink', color: '#9254de', copyLabel: '编辑器链接' },
]

function ProjectPanel({ project, onAction, active, embedded, themeProjectCount }) {
  const { message, modal } = App.useApp()
  const noRepo = !project.repoPath
  const [themeDelLoading, setThemeDelLoading] = useState(false)
  // 仅「有仓库 且 非当前生效」时点卡片才切换：已是当前配置则点击为空操作（不写 toml、不弹提示）
  const clickable = !noRepo && !active

  // 链接：复制到剪贴板 + 用系统默认浏览器打开
  const openLink = async (url, label) => {
    if (!url) return
    const res = await window.api.shell.copy(url)
    await window.api.shell.openExternal(url)
    if (res?.ok) message.success(`已复制${label}并在默认浏览器打开`)
  }

  // 删除线上主题：本地只存 theme id，先拉主题名（顺带确认主题还存在），再弹红色二次确认后执行。
  // 确认后按 store+theme 连带删除引用该主题的全部本地项目（含其他分支），当前生效项的 toml 一并清除。
  const askDeleteTheme = async () => {
    const id = String(project.theme ?? '').trim()
    if (!id) return message.warning('该项目缺少 theme 字段')
    if (!project.repoPath) return message.warning('未找到所属仓库，无法删除主题')
    setThemeDelLoading(true)
    const res = await window.api.repos.themeInfo({ dir: project.repoPath, themeId: id })
    setThemeDelLoading(false)
    if (!res.ok) return message.error({ content: res.error, duration: 8 })
    if (!res.data) return message.warning(`主题 ${id} 在该 store 上已不存在（可能已被删除）`)
    if (res.data.role === 'live') return message.error('live 主题不允许删除')
    modal.confirm({
      title: '确认删除线上主题？',
      icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      content: (
        <div>
          <Text type="danger" strong style={{ display: 'block', marginBottom: 10 }}>
            即将从 Shopify 删除以下主题，操作不可恢复：
          </Text>
          <Descriptions size="small" column={1} style={{ marginBottom: 10 }}>
            <Descriptions.Item label="主题名称">
              <Text strong>{res.data.name}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="分支">{project._branch || '-'}</Descriptions.Item>
            <Descriptions.Item label="theme ID">{id}</Descriptions.Item>
            <Descriptions.Item label="store">{project.store}</Descriptions.Item>
          </Descriptions>
          {themeProjectCount > 0 && (
            <Text type="warning" style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
              ⚠️ 将同时删除引用该主题的 {themeProjectCount} 条本地项目记录（可能含其他分支的项目）。
            </Text>
          )}
          {active && (
            <Text type="warning" style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
              ⚠️ 该主题正在当前生效配置中使用，删除后将一并清除该仓库的生效配置。
            </Text>
          )}
        </div>
      ),
      onOk: async () => {
        const r = await window.api.repos.deleteTheme({ dir: project.repoPath, themeId: id, store: project.store })
        if (!r.ok) {
          message.error({ content: r.error, duration: 8 })
          return
        }
        let text = `已删除线上主题「${res.data.name}」`
        if (r.deletedProjects > 0) {
          text += `，并清理 ${r.deletedProjects} 条本地项目`
          if (r.tomlDeleted) text += '（含当前生效配置）'
        }
        message.success(text)
        if (r.localError) message.warning({ content: `本地项目清理失败：${r.localError}`, duration: 8 })
        onAction('themeDeleted', project)
      },
    })
  }

  // 当前生效的面板整体提亮：绿色底 + 高亮描边 + 绿色辉光 + 闪光扫光（比仅靠小绿标更显眼）。
  // position/overflow 让绝对定位的扫光层被圆角裁剪、不溢出面板。
  const ACTIVE_GLOW = active
    ? {
        background: 'rgba(82,196,26,0.16)',
        border: '1px solid rgba(82,196,26,0.6)',
        boxShadow: '0 0 0 1px rgba(82,196,26,0.3), 0 8px 22px rgba(82,196,26,0.3)',
        position: 'relative',
        overflow: 'hidden',
      }
    : {}
  const wrapperStyle = embedded
    ? { marginTop: 12, padding: 12, borderRadius: 12, background: 'rgba(22,119,255,0.08)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(22,119,255,0.25)', ...ACTIVE_GLOW }
    : { padding: 16, borderRadius: 14, ...GLASS, ...ACTIVE_GLOW }

  const title = project.description || project.templateName || project.store || '-'
  // 关联工单链接（初始化选工单/本地保存拆链接时记入的 _tapd）：有则右上角挂工单彩带
  const tapdUrl = String(project._tapd || '').trim()
  // 彩带点击后在主窗口右侧打开工单详情抽屉（与 TAPD 工单页同款：描述/评论/流转路径/流转弹窗）
  const [tapdDrawerOpen, setTapdDrawerOpen] = useState(false)

  return (
    <div style={{ position: 'relative' }}>
      {/* 工单彩带：右上角斜向入口，点击打开工单详情抽屉（GitHub 彩带的同款造型）。
          放在面板根节点外层：当前生效面板 overflow:hidden（裁剪扫光）不会把彩带裁掉 */}
      {tapdUrl && (
        <Tooltip title="查看工单详情">
          <div
            onClick={() => setTapdDrawerOpen(true)}
            style={{
              position: 'absolute',
              top: -10,
              right: -10,
              width: 70,
              height: 70,
              overflow: 'hidden',
              zIndex: 2,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                display: 'block',
                position: 'absolute',
                top: 12,
                right: -20,
                width: 96,
                textAlign: 'center',
                transform: 'rotate(45deg)',
                background: 'linear-gradient(135deg, #722ed1 0%, #531dab 100%)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
                lineHeight: '22px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              }}
            >
              <ProjectOutlined style={{ marginRight: 2 }} />
              工单
            </span>
          </div>
        </Tooltip>
      )}
      <div
        style={{ ...wrapperStyle, cursor: clickable ? 'pointer' : undefined }}
        title={clickable ? '点击切换为当前生效配置' : undefined}
        onClick={clickable ? () => onAction('switch', project) : undefined}
      >
      {/* 当前生效：绿色高光带横向无限扫过（linear 时序 + 渐变两端透明 → 循环无跳变；pointer-events:none 不挡点击） */}
      {active && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            background: 'linear-gradient(110deg, transparent 25%, rgba(82,196,26,0.42) 50%, transparent 75%)',
            backgroundSize: '200% 100%',
            animation: 'sp-active-shimmer 4s linear infinite',
          }}
        />
      )}
      {/* 标题：项目名 + 模板 + 仓库状态（长标题自动省略）；右侧预留工单彩带的角落空间 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10, paddingRight: tapdUrl ? 40 : 0 }}>
        <Text strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </Text>
        {project.templateName && (
          <Tag style={{ marginInlineEnd: 0, flexShrink: 0 }}>{project.templateName}</Tag>
        )}
        {active && (
          <Tag color="green" style={{ marginInlineEnd: 0, flexShrink: 0 }}>当前生效</Tag>
        )}
        {noRepo && (
          <Text type="warning" style={{ fontSize: 12, flexShrink: 0 }}>
            （未找到仓库）
          </Text>
        )}
      </div>

      {/* 快捷链接：彩色 chip，点击复制并用默认浏览器打开（提到标题下方，比参考字段更醒目） */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }} onClick={(e) => e.stopPropagation()}>
        {QUICK_LINKS.map((l) => {
          const url = project.links?.[l.urlKey]
          const off = !url
          const { Icon } = l
          return (
            <ALink
              key={l.key}
              className="sp-qlink"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                fontSize: 12,
                lineHeight: '20px',
                padding: '1px 8px',
                borderRadius: 6,
                color: off ? 'rgba(255,255,255,0.3)' : l.color,
                background: off ? 'transparent' : `${l.color}1f`,
                border: `1px solid ${off ? 'rgba(255,255,255,0.12)' : `${l.color}59`}`,
                cursor: off ? 'not-allowed' : 'pointer',
                flex: 1,
              }}
              onClick={() => !off && openLink(url, l.copyLabel)}
            >
              <Icon />
              {l.label}
            </ALink>
          )
        })}
      </div>

      {/* 配置信息：store / theme / port / preview_key；theme、preview_key 点击复制 */}
      <div style={INFO_BLOCK} onClick={(e) => e.stopPropagation()}>
        <InfoField label="store" value={project.store} />
        <InfoField label="theme" value={project.theme} copyable />
        <InfoField label="port" value={project.port} />
        <InfoField label="preview_key" value={project.previewKey} copyable />
      </div>

      {/* 操作：JSON 改动 / 提测 / 删除线上主题 / 编辑 / 删除本地项目（整行 stopPropagation，避免点按钮误触发卡片切换） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
        <Space size={6}>
          <Badge count={project.changedJson?.length || 0} size="small" offset={[-2, 0]} color={project.changedJson?.length ? '#faad14' : undefined}>
            <Button size="small" onClick={() => onAction('json', { title, files: project.changedJson || [] })}>
              JSON改动
            </Button>
          </Badge>
          {!embedded && (
            <Tooltip title="发钉钉提测通知">
              <Button size="small" onClick={() => onAction('gotest', project)}>
                提测通知
              </Button>
            </Tooltip>
          )}
        </Space>
        <Space size={6}>
          <Tooltip title="用 shopify 删除该 theme ID 对应的线上主题，并连带清理引用它的本地项目">
            <Button size="small" danger ghost loading={themeDelLoading} onClick={askDeleteTheme}>
              删除主题
            </Button>
          </Tooltip>
          <Button size="small" onClick={() => onAction('edit', project)}>
            编辑
          </Button>
          <Popconfirm title="删除该本地项目？" okText="删除" cancelText="取消" onConfirm={() => onAction('delete', project)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>
      </div>
      {/* 工单详情抽屉：与 TAPD 工单页同款，彩带点击打开（Portal 挂载，不影响面板布局） */}
      {tapdUrl && (
        <TapdItemDrawer open={tapdDrawerOpen} link={tapdUrl} onClose={() => setTapdDrawerOpen(false)} />
      )}
    </div>
  )
}

/* ---------------- 关于：客户端 / shopify CLI / git 等版本 ---------------- */
function AboutModal({ open, onClose, onOpenReleases }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    if (open) window.api.system.versions().then(setInfo)
  }, [open])
  const rows = [
    ['客户端', info?.app],
    ['shopify CLI', info?.shopify],
    ['git', info?.git],
    ['Electron', info?.electron],
    ['Node', info?.node],
    // 跑 @shopify/cli 的系统 Node；fallback=true 时提示安装（与页面顶部告警同源）
    ['系统 Node', info?.systemNode?.fallback ? '未找到（shopify 功能不可用）' : info?.systemNode?.path],
  ]
  return (
    <Modal title="关于 Shopify 工具箱" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Descriptions column={1} size="small" bordered>
        {rows.map(([k, v]) => (
          <Descriptions.Item key={k} label={k}>
            <Text style={{ fontFamily: 'monospace' }}>{v || '—'}</Text>
          </Descriptions.Item>
        ))}
      </Descriptions>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          shopify CLI 即客户端实际调用的 @shopify/cli；git 为本机系统版本。
        </Text>
        <Button size="small" onClick={onOpenReleases}>去 GitHub 下载</Button>
      </div>
    </Modal>
  )
}

// 客户端更新不再走 electron-updater 自动检测/下载，统一引导到 GitHub Release 页面手动下载。
const GITHUB_RELEASES_URL = "https://github.com/fredliu-dev/shopify-cli-tool/releases/latest"

/* ---------------- 页面主体 ---------------- */
// registerMenu：主壳（App.jsx 左侧栏）注入的注册器。头像「更多」菜单里的弹窗/动作
// 都定义在本页内部，挂载时注册给壳层渲染菜单时回调；TAPD / 爬虫页切换只切显隐，本页常驻不卸载。
export default function Repos({ registerMenu }) {
  const { message } = App.useApp()
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [repos, setRepos] = useState([])
  const [repoOrder, setRepoOrder] = useState([]) // 用户拖拽自定义的仓库顺序（path 数组），持久化于 settings.repoOrder
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [defaultEditor, setDefaultEditor] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [nodeFallback, setNodeFallback] = useState(false)
  // 启动自检：未找到系统 Node 时 shopify 相关功能（复制 live 主题/删除主题/主题信息）会静默失败，
  // 置顶常驻提示安装（Windows 分发给未装 Node 的用户时高发）
  useEffect(() => {
    window.api.system
      .versions()
      .then((v) => setNodeFallback(!!v?.systemNode?.fallback))
      .catch(() => {})
  }, [])
  const openNodeDownload = async () => {
    const r = await window.api.shell.openExternal('https://nodejs.org/en/download')
    if (!r?.ok) message.error('打开 Node.js 下载页失败')
  }
  // 不再自动检测更新：统一引导用户到 GitHub Release 页面下载安装包
  const openReleasesPage = async () => {
    const r = await window.api.shell.openExternal(GITHUB_RELEASES_URL)
    if (!r?.ok) message.error('打开 GitHub Release 页面失败')
  }
  const [contacts, setContacts] = useState([])
  const [contactsOpen, setContactsOpen] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [gotestFor, setGotestFor] = useState(null) // 提测目标 project
  const [mergeInfoFor, setMergeInfoFor] = useState(null) // 第③步「获取合并提交信息」目标 repo

  const [jsonModal, setJsonModal] = useState(null) // { title, files }
  const [editRepo, setEditRepo] = useState(null) // { mode:'init'|'save', repo }
  const [cloneable, setCloneable] = useState([]) // 模板 _github 项目 + 是否已存在（供「创建项目」查重）
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [manageTemplatesOpen, setManageTemplatesOpen] = useState(false)
  const [gitModal, setGitModal] = useState(null) // { mode:'branch', repo }
  const [editProject, setEditProject] = useState(null) // 编辑本地项目

  // 刷新「创建项目」可选模板（带 _github 且未在工作区存在的）
  const refreshCloneable = useCallback(async (dir) => {
    const target = dir || workspaceDir
    if (!target) return
    const res = await window.api.repos.cloneableTemplates(target)
    if (res.ok) setCloneable(res.data || [])
  }, [workspaceDir])

  const scan = useCallback(
    async (dir) => {
      if (!dir) return
      setScanning(true)
      const res = await window.api.repos.scan(dir)
      setScanning(false)
      if (res.ok) {
        // 读自定义顺序并据此重排（重启/重扫后仍按用户上次拖拽的顺序展示）
        const s = await window.api.settings.get()
        const order = s?.repoOrder || []
        setRepoOrder(order)
        setRepos(orderByPaths(res.data || [], order))
        // 同步刷新「创建项目」可选模板（带 _github 且未在工作区存在的）
        window.api.repos.cloneableTemplates(dir).then((r) => {
          if (r.ok) setCloneable(r.data || [])
        })
      } else {
        message.error(res.error || '扫描失败')
        setRepos([])
      }
    },
    [message],
  )

  // 拖拽排序回调：即时重排 repos 并持久化到 settings.repoOrder（重启/重扫后仍保留）
  const handleReorder = useCallback((newPaths) => {
    setRepoOrder(newPaths)
    setRepos((prev) => orderByPaths(prev, newPaths))
    window.api.settings.set({ repoOrder: newPaths })
  }, [])

  const refreshProjects = useCallback(async () => {
    const res = await window.api.shops.ls()
    if (res.ok) setProjects(res.data || [])
  }, [])

  const refreshContacts = useCallback(async () => {
    const res = await window.api.contacts.ls()
    if (res.ok) setContacts(res.data || [])
  }, [])

  useEffect(() => {
    ;(async () => {
      const s = await window.api.settings.get()
      setWorkspaceDir(s?.workspaceDir || '')
      setDefaultEditor(s?.defaultEditor || '')
      setLoading(false)
      if (s?.workspaceDir) {
        await scan(s.workspaceDir)
        await refreshProjects()
      }
      refreshContacts()
    })()
  }, [scan, refreshProjects, refreshContacts])

  // 文件监听：配置/templates 变动后主进程推送的最新仓库数据，替换到列表里
  useEffect(() => {
    const off = window.api.repos.onUpdated(({ repo }) => {
      if (!repo?.path) return
      setRepos((prev) => prev.map((r) => (r.path === repo.path ? repo : r)))
    })
    return () => off?.()
  }, [])

  // 工作区目录监听：仓库新增/删除后主进程推送完整新列表，整体替换
  useEffect(() => {
    const off = window.api.repos.onReposChanged(({ data }) => {
      if (Array.isArray(data)) setRepos(orderByPaths(data, repoOrder))
      refreshCloneable()
    })
    return () => off?.()
  }, [refreshCloneable, repoOrder])

  const pickAndScan = async () => {
    const res = await window.api.dialog.pickDir()
    if (!res.ok) return
    setWorkspaceDir(res.dir)
    const saveRes = await window.api.settings.setWorkspace(res.dir)
    if (!saveRes.ok) message.warning(saveRes.error || '工作区路径保存失败')
    await scan(res.dir)
    await refreshProjects()
  }

  // 打开本地数据目录（projects.json / templates 所在文件夹）到系统文件管理器
  const openLocalConfig = async () => {
    const dirRes = await window.api.config.dataDir()
    if (!dirRes?.ok) {
      message.error(dirRes?.error || '无法定位配置目录')
      return
    }
    const res = await window.api.shell.openPath(dirRes.data)
    if (!res?.ok) message.error(res.error || '打开失败')
  }

  // 一键导出本地配置为 zip（含 README 说明 win/mac 路径与恢复步骤）；用户取消则静默
  const exportConfig = async () => {
    const res = await window.api.config.export()
    if (!res || res.canceled) return
    if (res.ok) message.success(`已导出：${res.path}`)
    else message.error(res.error || '导出失败')
  }

  // 头像「更多」菜单动作分发（菜单壳层在 App.jsx 左侧栏渲染，动作实现在本页）：
  // 管理类弹窗 + 本地配置/导出 + 设置编辑器/关于 + 下载最新版本。
  // handler 走 ref 转发：注册只在挂载/defaultEditor 变化时执行一次，点击时取最新闭包。
  const handleMenuAction = (key) => {
    if (key === 'manageTemplates') setManageTemplatesOpen(true)
    else if (key === 'contacts') setContactsOpen(true)
    else if (key === 'groups') setGroupsOpen(true)
    else if (key === 'dingtalkTemplates') setTemplatesOpen(true)
    else if (key === 'localConfig') openLocalConfig()
    else if (key === 'exportConfig') exportConfig()
    else if (key === 'settings') setSettingsOpen(true)
    else if (key === 'about') setAboutOpen(true)
    else if (key === 'releases') openReleasesPage()
  }
  const menuActionRef = useRef(handleMenuAction)
  menuActionRef.current = handleMenuAction
  useEffect(() => {
    registerMenu?.({
      run: (key) => menuActionRef.current?.(key),
      editorLabel: defaultEditor, // 菜单项「默认编辑器：X」的动态标签
    })
  }, [registerMenu, defaultEditor])

  // init/save 后：刷新该仓库状态 + 刷新本地项目列表
  const refreshRepo = async (repoPath) => {
    const res = await window.api.repos.status(repoPath)
    if (res.ok) setRepos((prev) => prev.map((r) => (r.path === repoPath ? res.data : r)))
    await refreshProjects()
  }

  // 仓库卡片动作分发
  const repoAction = (type, payload) => {
    if (type === 'init') setEditRepo({ mode: 'init', repo: payload })
    else if (type === 'save') setEditRepo({ mode: 'save', repo: payload })
    else if (type === 'json') setJsonModal(payload)
    else if (type === 'checkout') checkoutBranch(payload.repo.path, payload.branch)
    else if (type === 'branch') setGitModal({ mode: 'branch', repo: payload })
    else if (type === 'gotest') setGotestFor(payload)
    else if (type === 'mergeInfo') setMergeInfoFor(payload)
  }

  // 项目卡片动作分发
  const projectAction = (type, payload) => {
    if (type === 'switch') handleSwitch(payload)
    else if (type === 'json') setJsonModal(payload)
    else if (type === 'edit') setEditProject(payload)
    else if (type === 'delete') handleDeleteProject(payload)
    else if (type === 'themeDeleted') refreshAfterThemeDelete(payload)
    else if (type === 'gotest') setGotestFor(payload)
  }

  // 删除线上主题（含连带清理本地项目）后的刷新：与 handleDeleteProject 同一套——
  // 仓库卡 matched 重算（生效配置可能已被清）+ 本地项目列表重载
  const refreshAfterThemeDelete = (project) => {
    if (project.repoPath) {
      refreshRepo(project.repoPath)
    } else {
      refreshProjects()
    }
  }

  // 删除本地缓存项目；若为该仓库「当前生效」项，后端会一并清掉其 shopify.theme.toml
  const handleDeleteProject = async (project) => {
    const res = await window.api.shops.delete([project.id], project.repoPath)
    if (!res.ok) {
      message.error(res.error || '删除失败')
      return
    }
    // synced=true 表示该仓库当前生效配置已被清除，单独提示；其余情况（非生效/tracked/无 toml）普通提示
    message.success(res.synced ? '已删除项目，并清除该仓库当前生效配置' : '已删除')
    // 删除后须刷新关联仓库的 matched 状态：否则「当前生效」标识与项目面板停留旧数据，
    // 要点「重新扫描」才恢复。refreshRepo 内部已含 refreshProjects。
    if (project.repoPath) {
      refreshRepo(project.repoPath)
    } else {
      refreshProjects()
    }
  }

  // 切换仓库分支：后端在 checkout 后按目标分支同步 toml 配置（套用项目/清空），这里按结果给反馈
  const checkoutBranch = async (repoPath, branch) => {
    const res = await window.api.repos.checkout({ dir: repoPath, branch })
    if (!res.ok) {
      message.error(res.error || '切换失败')
      refreshRepo(repoPath) // 失败也刷新：还原分支 Select 显示
      return
    }
    const m = syncMessage(res.data?.sync, `已切换到 ${branch}`)
    if (m) message[m.type](m.text)
    else message.success(`已切换到 ${branch}`)
    refreshRepo(repoPath)
  }

  // 把仓库的 shopify.theme.toml 切换到该项目的配置（不复制命令、不打开编辑器）。
  // 切换后刷新该仓库状态：matched 重算，被切项目变「当前生效」并置顶展示。
  const handleSwitch = async (project) => {
    if (!project?.repoPath) return
    const res = await window.api.repos.switchConfig({ dir: project.repoPath, projectId: project.id })
    if (!res.ok) {
      message.error(res.error || '切换失败')
      return
    }
    const data = res.data || {}
    if (data.applied) {
      const name = data.project?.description || data.project?.templateName || data.project?.store || ''
      let text = name ? `已切换到「${name}」配置` : '配置已切换'
      // 端口占用处理：被占用且已杀进程则提示已释放；未能杀掉则单独告警
      const port = data.port
      if (port?.wasOccupied) {
        if (port.killed > 0) text += `，已释放被占用的端口 ${port.port}`
        else message.warning(`端口 ${port.port} 被占用且未能结束进程，请手动处理后重试`)
      }
      message.success(text)
    } else if (data.skipped === 'tracked') {
      message.warning('shopify.theme.toml 被 Git 跟踪，无法自动切换（请先在 .gitignore 忽略该文件）')
    } else if (data.reason === 'template-missing') {
      message.warning(`项目引用的模板「${data.templateName}」已删除，配置未切换`)
    } else {
      message.warning('配置未切换')
    }
    refreshRepo(project.repoPath)
  }

  // 本地项目 ↔ 仓库关联（按 store：同 store 的所有本地项目都归属到 dev.store 一致的仓库，
  // 实现 1:N —— 一个仓库卡展示同 store 的多条项目，而非只展示 matched 那一条）
  const repoByStore = useMemo(() => {
    const m = new Map()
    repos.forEach((r) => {
      if (r.devEnv?.store) m.set(r.devEnv.store, r)
    })
    return m
  }, [repos])

  // 每个 project 注入关联仓库路径 + JSON 改动（按 store 关联）
  const enrichedProjects = useMemo(
    () =>
      projects.map((p) => {
        const r = repoByStore.get(p.store)
        return { ...p, repoPath: r?.path, changedJson: changedJsonOf(r) }
      }),
    [projects, repoByStore],
  )

  // 仓库路径 → 关联项目列表（1:N：同 store 且与仓库当前分支一致的项目才展示）。
  // 跟随分支：切到某分支只看该分支保存的项目；历史项目无 _branch 不归属具体分支、不展示。
  const projectsByRepoPath = useMemo(() => {
    const m = new Map()
    const branchByPath = new Map()
    repos.forEach((r) => branchByPath.set(r.path, r.currentBranch))
    enrichedProjects.forEach((p) => {
      if (!p.repoPath) return
      const branch = branchByPath.get(p.repoPath)
      if (branch && p._branch !== branch) return
      if (!m.has(p.repoPath)) m.set(p.repoPath, [])
      m.get(p.repoPath).push(p)
    })
    return m
  }, [enrichedProjects, repos])

  // 各 store 下、每个分支绑定的本地项目数：项目身份 = store + _branch（见 core/shops.js），
  // 故按 store 归属仓库、按 _branch 归属分支；切分支下拉框据此标识"该分支有几个本地项目"。
  const branchProjectCountsByStore = useMemo(() => {
    const byStore = new Map()
    projects.forEach((p) => {
      if (!p.store || !p._branch) return // 历史项目无 _branch，不归属具体分支
      if (!byStore.has(p.store)) byStore.set(p.store, {})
      const o = byStore.get(p.store)
      o[p._branch] = (o[p._branch] || 0) + 1
    })
    return byStore
  }, [projects])

  // 各「store+theme」被多少条本地项目引用（跨分支统计）：删除线上主题会连带清理这些项目，
  // 确认弹窗据此展示影响面；键与 core deleteProjectsByTheme 的匹配口径一致（store 相等 + theme trim 后比对）
  const themeProjectCounts = useMemo(() => {
    const m = new Map()
    projects.forEach((p) => {
      if (!p.store || !p.theme) return
      const key = `${p.store}|${String(p.theme).trim()}`
      m.set(key, (m.get(key) || 0) + 1)
    })
    return m
  }, [projects])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Spin />
      </div>
    )
  }

  if (!workspaceDir) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Card style={{ textAlign: 'center', padding: '24px 48px', ...GLASS, borderRadius: 16 }}>
          <Title level={4} style={{ marginBottom: 8 }}>
            选择工作区文件夹
          </Title>
          <Text type="secondary">选择一个本机文件夹，扫描其下的 Git 仓库</Text>
          <div style={{ marginTop: 20 }}>
            <Button type="primary" size="large" onClick={pickAndScan}>
              选择文件夹
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          padding: '12px 20px',
          ...GLASS,
          borderRadius: 14,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.3)',
        }}
      >
        <div onClick={pickAndScan} style={{ minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderOpenOutlined style={{ color: '#1677ff', fontSize: 18, flexShrink: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 }}>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
              工作区
            </Text>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <Text strong ellipsis={{ tooltip: workspaceDir }} style={{ maxWidth: 340, minWidth: 0 }}>
                {workspaceDir}
              </Text>
              <Text style={{ fontSize: 12, color: '#69b1ff', flexShrink: 0 }}>{repos.length} 个仓库</Text>
            </div>
          </div>
        </div>
        <Space size={8} style={{ flexShrink: 0 }}>
          <Button variant="outlined" icon={<ReloadOutlined />} onClick={() => scan(workspaceDir)} loading={scanning}>
            重新扫描
          </Button>
          <Tooltip title={cloneable.some((t) => !t.exists) ? `可克隆：${cloneable.filter((t) => !t.exists).map((t) => t.name).join('、')}` : '所有模板项目都已存在于工作区'}>
            <span>
              <Button type="primary" icon={<PlusOutlined />} disabled={!cloneable.some((t) => !t.exists)} onClick={() => setCreateProjectOpen(true)}>
                创建项目
              </Button>
            </span>
          </Tooltip>
          {/* TAPD 工单 / 爬虫工作流入口与「更多」「下载最新版」已移至左侧栏：
              前两者是左侧栏页面切换项，后两者收进左上角头像菜单 */}
        </Space>
      </div>

      {nodeFallback && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="未检测到系统 Node.js"
          description={
            <Space direction="vertical" size={4}>
              <Text style={{ fontSize: 12 }}>
                主题复制 / 删除 / 信息等 shopify 功能依赖系统 Node.js（≥22）运行，当前机器未找到，相关操作会失败。安装后重启本应用即可。
              </Text>
              <Button size="small" type="primary" onClick={openNodeDownload}>
                去官网安装 Node.js
              </Button>
            </Space>
          }
        />
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <Title level={5} style={{ margin: 0 }}>
          Git 仓库（{repos.length}）
        </Title>
        <Text type="secondary" style={{ fontSize: 11 }}>
          已配对本地项目的仓库，项目会内嵌在同一张卡里
        </Text>
      </div>
      {scanning ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip="扫描中…" />
        </div>
      ) : repos.length === 0 ? (
        <Empty description="该工作区下未发现 Git 仓库" style={{ marginBottom: 24 }} />
      ) : (
        <Masonry minColWidth={440} gap={12} draggable onReorder={handleReorder}>
          {repos.map((r) => (
            <RepoCard
              key={r.path}
              repo={r}
              projects={projectsByRepoPath.get(r.path) || []}
              branchProjectCounts={branchProjectCountsByStore.get(r.devEnv?.store) || {}}
              themeProjectCounts={themeProjectCounts}
              onAction={repoAction}
              onProjectAction={projectAction}
              defaultEditor={defaultEditor}
            />
          ))}
        </Masonry>
      )}

      {/* 初始化 / 本地保存 弹窗 */}
      {editRepo?.mode === 'init' && (
        <InitRepoModal
          open
          repo={editRepo.repo}
          onClose={() => setEditRepo(null)}
          onDone={() => {
            const path = editRepo.repo.path
            setEditRepo(null)
            refreshRepo(path)
          }}
        />
      )}
      {editRepo?.mode === 'save' && (
        <SaveRepoModal
          open
          repo={editRepo.repo}
          // 判重用同 store 全量项目（不按分支过滤：历史项目无 _branch 视为通配，与后端一致）
          projects={projects.filter((p) => p.store === editRepo.repo.devEnv?.store)}
          contacts={contacts}
          onClose={() => setEditRepo(null)}
          onDone={() => {
            const path = editRepo.repo.path
            setEditRepo(null)
            refreshRepo(path)
          }}
        />
      )}

      {/* 查看 JSON 改动 */}
      <ChangedJsonModal open={!!jsonModal} title={jsonModal?.title} files={jsonModal?.files || []} onClose={() => setJsonModal(null)} />

      {/* 设置默认编辑器 */}
      <SettingsModal
        open={settingsOpen}
        defaultEditor={defaultEditor}
        onClose={() => setSettingsOpen(false)}
        onSaved={(id) => {
          setDefaultEditor(id)
          setSettingsOpen(false)
        }}
      />

      {/* 创建项目（克隆模板 _github） */}
      <CreateProjectModal
        open={createProjectOpen}
        workspaceDir={workspaceDir}
        templates={cloneable}
        onClose={() => setCreateProjectOpen(false)}
        onDone={() => {
          setCreateProjectOpen(false)
          refreshCloneable()
        }}
      />

      {/* 模板管理（编辑/删除仅限自建模板，内置锁定） */}
      <ManageTemplatesModal
        open={manageTemplatesOpen}
        onClose={() => setManageTemplatesOpen(false)}
        onChange={refreshCloneable}
      />

      {/* 人员管理（姓名+手机号；负责人下拉与提测 @ 手机号的数据源） */}
      <ContactsModal open={contactsOpen} onClose={() => setContactsOpen(false)} onChange={refreshContacts} />

      {/* 通知群管理（钉钉群机器人） */}
      <GroupsModal open={groupsOpen} onClose={() => setGroupsOpen(false)} />

      {/* 信息模板管理（钉钉消息模板，含占位符） */}
      <DingtalkTemplatesModal open={templatesOpen} onClose={() => setTemplatesOpen(false)} />

      {/* 提测通知（选群+模板，自动预填项目提测链接/描述后发钉钉） */}
      {/* 提测通知（选群+模板，自动预填项目提测链接/描述后发钉钉）
          下拉只列「当前仓库·当前分支」下的项目（复用 projectsByRepoPath 的过滤口径），不展示其它仓库/分支的项目 */}
      <GotestModal
        open={!!gotestFor}
        project={gotestFor}
        projects={gotestFor ? (projectsByRepoPath.get(gotestFor.repoPath) || [gotestFor]) : []}
        contacts={contacts}
        onClose={() => setGotestFor(null)}
      />

      {/* 获取合并提交信息（第④步：多选当前分支含工单项目，标题/工单去重，按模板生成合并通知） */}
      <MergeInfoModal
        open={!!mergeInfoFor}
        repo={mergeInfoFor}
        projects={mergeInfoFor ? (projectsByRepoPath.get(mergeInfoFor.path) || []).filter((p) => p.description) : []}
        contacts={contacts}
        onClose={() => setMergeInfoFor(null)}
      />

      {/* 编辑本地项目（仅 非 _ 开头字段） */}
      <EditProjectModal
        open={!!editProject}
        project={editProject}
        onClose={() => setEditProject(null)}
        onDone={() => {
          // 编辑可能回写了 toml：刷新关联仓库（已含 refreshProjects）立即重算 matched，
          // 不依赖文件监听；无仓库关联时退回只刷项目列表
          const rp = editProject?.repoPath
          setEditProject(null)
          if (rp) refreshRepo(rp)
          else refreshProjects()
        }}
      />

      {/* 关于：版本信息 */}
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} onOpenReleases={openReleasesPage} />


      {/* 拉取分支 */}
      {gitModal?.mode === 'branch' && (
        <CreateBranchModal
          open
          contacts={contacts}
          repo={gitModal.repo}
          onClose={() => setGitModal(null)}
          onDone={() => {
            const path = gitModal.repo.path
            setGitModal(null)
            refreshRepo(path)
          }}
        />
      )}
    </>
  )
}
