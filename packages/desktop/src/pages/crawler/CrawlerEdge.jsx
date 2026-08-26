// React Flow 自定义连线：悬停/选中高亮，中点浮出 ✕ 删除按钮（与节点右上 🗑 同走
// deleteElements → onBeforeDelete；Editor 的 confirmDelete 只对删节点弹确认，纯删连线
// 直接放行，Delete/Backspace 键删选中连线也是同一条路）。
// condition 分支的「是/否」标签由 BaseEdge 按 edge.label 在中点渲染，删除按钮上移避让。
// 悬显按钮跨 SVG→HTML 两层 DOM，g 的 mouseleave 会在指针移向按钮时误触发，
// 用短延时收回：先到按钮就取消，到不了再隐藏。
import React, { useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow } from '@xyflow/react'
import { CloseOutlined } from '@ant-design/icons'

const HIDE_DELAY = 180

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

  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
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
            stroke: active ? 'rgba(22,119,255,0.8)' : 'rgba(255,255,255,0.28)',
            strokeWidth: active ? 2 : 1.5,
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
              background: '#1f1f23',
              border: '1px solid rgba(255,77,79,0.55)',
              color: '#ff7875',
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
