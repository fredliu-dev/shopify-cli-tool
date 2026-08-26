// 左侧模块面板：可拖拽卡片（模块表驱动，新增模块自动出现）。拖拽用原生 HTML5 DnD
// （dataTransfer 带 'application/crawler-module' 类型），FlowCanvas 的 onDrop 解析后建节点。
import React from 'react'
import { Typography } from 'antd'
import { MODULES, MODULE_ORDER } from './constants.js'

const { Text } = Typography

export const MODULE_DND_TYPE = 'application/crawler-module'

export default function ModulePanel() {
  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        padding: '12px 10px',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        overflowY: 'auto',
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
        模块（拖到画布）
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {MODULE_ORDER.map((key) => {
          const m = MODULES[key]
          const Icon = m.icon
          return (
            <div
              key={m.type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MODULE_DND_TYPE, m.type)
                e.dataTransfer.effectAllowed = 'move'
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                cursor: 'grab',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                e.currentTarget.style.borderColor = `${m.color}88`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
              }}
              title={m.desc}
            >
              <span style={{ color: m.color, fontSize: 18, display: 'flex' }}>
                <Icon />
              </span>
              <div style={{ minWidth: 0 }}>
                <Text strong style={{ fontSize: 13, display: 'block' }}>
                  {m.name}
                </Text>
                <Text
                  type="secondary"
                  ellipsis={{ tooltip: m.desc }}
                  style={{ fontSize: 11, maxWidth: 120, display: 'block' }}
                >
                  {m.desc}
                </Text>
              </div>
            </div>
          )
        })}
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 16, padding: '0 4px', lineHeight: 1.7 }}>
        · 拖模块到画布生成节点
        <br />· 从节点右侧圆点拉线连接
        <br />· 点击节点在右侧配置
        <br />· 节点右上 🗑 或 Delete 键删除（需二次确认）
      </Text>
    </div>
  )
}
