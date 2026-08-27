// React Flow 自定义连线：悬停/选中高亮，中点浮出 ✕ 删除按钮（与节点右上 🗑 同走
// deleteElements → onBeforeDelete；Editor 的 confirmDelete 只对删节点弹确认，纯删连线
// 直接放行，Delete/Backspace 键删选中连线也是同一条路）。
// condition 分支的「是/否」标签由 BaseEdge 按 edge.label 在中点渲染，删除按钮上移避让。
// 悬显按钮跨 SVG→HTML 两层 DOM，g 的 mouseleave 会在指针移向按钮时误触发，
// 用短延时收回：先到按钮就取消，到不了再隐藏。
//
// 路由规则（解决连线交叉看不清流程）：
// - 正向边（目标在源右侧）：圆角肘形折线（getSmoothStepPath），流程图习惯的水平/垂直段
// - 回环边（目标在源左侧，如数据循环的连回线）：从右侧出 → 沉到两节点下方的通道 →
//   绕到左侧进，不横穿中间的正向流程；通道深度按连线 id 哈希错开，多条回环线不重叠
import React, { useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow } from '@xyflow/react'
import { CloseOutlined } from '@ant-design/icons'
import { EASE, INK, MAT, STATUS } from './theme.js'

const HIDE_DELAY = 180

/** 圆角折线路径：拐角处用二次贝塞尔过渡（r 自动收缩到相邻段长的一半，短线不破角）。 */
function roundedPath(points, r = 14) {
  if (points.length < 2) return ''
  let d = `M ${points[0][0]},${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const d1 = Math.hypot(cx - px, cy - py) || 1
    const d2 = Math.hypot(nx - cx, ny - cy) || 1
    const r1 = Math.min(r, d1 / 2)
    const r2 = Math.min(r, d2 / 2)
    d += ` L ${cx + ((px - cx) / d1) * r1},${cy + ((py - cy) / d1) * r1}`
    d += ` Q ${cx},${cy} ${cx + ((nx - cx) / d2) * r2},${cy + ((ny - cy) / d2) * r2}`
  }
  const [lx, ly] = points[points.length - 1]
  return d + ` L ${lx},${ly}`
}

/** 回环边绕行路径：返回 [path, labelX, labelY]（标签放在下方通道的长横段中点）。 */
function backLoopPath(id, sourceX, sourceY, targetX, targetY) {
  let hash = 0
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const stub = 26
  const laneY = Math.max(sourceY, targetY) + 64 + (Math.abs(hash) % 3) * 28
  const pts = [
    [sourceX, sourceY],
    [sourceX + stub, sourceY],
    [sourceX + stub, laneY],
    [targetX - stub, laneY],
    [targetX - stub, targetY],
    [targetX, targetY],
  ]
  return [roundedPath(pts), (sourceX + targetX) / 2, laneY]
}

export default function CrawlerEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  labelStyle,
  selected,
}) {
  const [hovered, setHovered] = useState(false)
  const hideTimerRef = useRef(null)
  const { deleteElements } = useReactFlow()

  useEffect(() => () => hideTimerRef.current && clearTimeout(hideTimerRef.current), [])

  const show = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    setHovered(true)
  }
  const hide = () => {
    hideTimerRef.current = setTimeout(() => setHovered(false), HIDE_DELAY)
  }

  // 回环边（目标在源左侧）绕下方通道，其余走圆角肘形；节点都在左右两侧出/入，方位恒定
  const [path, labelX, labelY] =
    targetX < sourceX - 4
      ? backLoopPath(id, sourceX, sourceY, targetX, targetY)
      : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 12, offset: 18 })
  const active = hovered || selected
  return (
    <>
      <g className="nodrag nopan" onMouseEnter={show} onMouseLeave={hide}>
        <BaseEdge
          id={id}
          path={path}
          label={label}
          labelX={labelX}
          labelY={labelY}
          labelStyle={labelStyle}
          interactionWidth={20}
          style={{
            stroke: active ? STATUS.running : 'rgba(255,255,255,0.16)',
            strokeWidth: active ? 2 : 1.5,
            transition: `stroke 0.18s ${EASE}`,
          }}
        />
      </g>
      <EdgeLabelRenderer>
        {active && (
          <div
            title="删除该连线"
            role="button"
            onMouseEnter={show}
            onMouseLeave={hide}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              deleteElements({ edges: [{ id }] })
            }}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 14}px)`,
              width: 18,
              height: 18,
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(42,42,48,0.95)',
              border: `1px solid ${MAT.line2}`,
              color: INK[2],
              fontSize: 10,
              cursor: 'pointer',
              pointerEvents: 'all',
              zIndex: 6,
            }}
          >
            <CloseOutlined />
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
}
