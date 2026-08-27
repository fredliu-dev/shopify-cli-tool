// React Flow v12 画布封装：暗色 + 点阵背景 + 小地图 + 控件；拖拽建节点 / 拉线连线。
// nodeTypes / edgeTypes 必须是模块级常量（组件内重造会触发 RF 性能警告/无限渲染），
// nodeTypes 由模块表自动生成——新增模块类型不需要来这里登记；edges 统一走
// 'crawler' 自定义连线（悬停出 ✕ 删除，type 在 Editor 加载/连线时写入）。
import React, { useCallback } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import CrawlerNode from './CrawlerNode.jsx'
import CrawlerEdge from './CrawlerEdge.jsx'
import { MODULES } from './constants.js'
import { MODULE_DND_TYPE } from './ModulePanel.jsx'
import { MAT } from './theme.js'

const nodeTypes = Object.fromEntries(Object.keys(MODULES).map((t) => [t, CrawlerNode]))
const edgeTypes = { crawler: CrawlerEdge }

export default function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  onAddNode,
  onBeforeDelete,
  defaultViewport,
  onMoveEnd,
}) {
  const { screenToFlowPosition } = useReactFlow()

  // 左侧模块面板拖入：dataTransfer 取模块类型，落点换算画布坐标建节点
  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      const type = event.dataTransfer.getData(MODULE_DND_TYPE)
      if (!type || !MODULES[type]) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onAddNode(type, position)
    },
    [screenToFlowPosition, onAddNode],
  )

  const onDragOver = useCallback((event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  return (
    <div
      style={{ flex: 1, minWidth: 0, position: 'relative', background: '#0a0a0d' }}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onMoveEnd={onMoveEnd}
        onBeforeDelete={onBeforeDelete}
        defaultViewport={defaultViewport}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        fitView={!defaultViewport}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
        style={{ backgroundColor: 'transparent' }}
        deleteKeyCode={['Backspace', 'Delete']}
        connectionLineStyle={{ stroke: 'rgba(10,132,255,0.55)', strokeWidth: 1.5 }}
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(255,255,255,0.05)" gap={24} size={1.1} />
        <Controls
          showInteractive={false}
          style={{
            backgroundColor: MAT.panel,
            backdropFilter: MAT.blur,
            border: `1px solid ${MAT.line}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}
        />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(5,5,7,0.55)"
          style={{
            backgroundColor: 'rgba(12,12,15,0.85)',
            border: `1px solid ${MAT.line}`,
            borderRadius: 10,
          }}
          nodeColor={(n) => MODULES[n.type]?.color || '#8e8e96'}
          nodeStrokeWidth={2}
        />
      </ReactFlow>
    </div>
  )
}
