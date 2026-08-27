// 左侧模块面板：可拖拽卡片（模块表驱动，新增模块自动出现）。拖拽用原生 HTML5 DnD
// （dataTransfer 带 'application/crawler-module' 类型），FlowCanvas 的 onDrop 解析后建节点。
// 行样式走 iOS 设置行：着色图标 chip + 名称/描述，悬停微抬升（CSS 过渡）。
import React from 'react'
import { EASE, INK, MAT, iconChip } from './theme.js'
import { MODULES, MODULE_ORDER } from './constants.js'

export const MODULE_DND_TYPE = 'application/crawler-module'

const ITEM_CSS = `
.mod-item {
  transition: background 0.22s ${EASE}, transform 0.22s ${EASE}, box-shadow 0.22s ${EASE};
}
.mod-item:hover { background: rgba(255,255,255,0.07); transform: translateY(-1px); }
.mod-item:active { transform: translateY(0) scale(0.99); }
.mod-item.dragging { opacity: 0.55; transform: scale(0.98); }
`

export default function ModulePanel() {
  return (
    <div
      style={{
        width: 212,
        flexShrink: 0,
        padding: '14px 12px',
        borderRight: `1px solid ${MAT.line}`,
        background: MAT.panel,
        backdropFilter: MAT.blur,
        WebkitBackdropFilter: MAT.blur,
        overflowY: 'auto',
      }}
    >
      <style>{ITEM_CSS}</style>
      <div style={{ fontSize: 11, letterSpacing: '0.8px', color: INK[3], padding: '0 8px 2px', fontWeight: 600 }}>
        模块库 · 拖入画布
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
        {MODULE_ORDER.map((key) => {
          const m = MODULES[key]
          const Icon = m.icon
          return (
            <div
              key={m.type}
              className="mod-item"
              draggable
              onDragStart={(e) => {
                e.currentTarget.classList.add('dragging')
                e.dataTransfer.setData(MODULE_DND_TYPE, m.type)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '7px 8px',
                borderRadius: 11,
                cursor: 'grab',
              }}
              title={m.desc}
            >
              <span style={iconChip(m.color, 28, 15)}>
                <Icon />
              </span>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: INK[1], display: 'block', lineHeight: 1.35 }}>
                  {m.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: INK[3],
                    display: 'block',
                    maxWidth: 122,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.4,
                  }}
                  title={m.desc}
                >
                  {m.desc}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      <div
        style={{
          marginTop: 18,
          padding: '10px 10px 4px',
          borderTop: `1px solid ${MAT.line}`,
          fontSize: 11,
          color: INK[3],
          lineHeight: 1.8,
        }}
      >
        · 拖模块到画布生成节点
        <br />· 从节点右侧圆点拉线连接
        <br />· 点击节点在右侧配置
        <br />· 节点右上 🗑 或 Delete 键删除（需二次确认）
      </div>
    </div>
  )
}
