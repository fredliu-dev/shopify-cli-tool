// React Flow 自定义节点：图标 + 名称 + 配置摘要 + 左右 Handle 连接点。
// data.status 由 Editor 根据主进程推送写回：running 蓝呼吸 / success 绿 / failed 红。
// data.iteration（导入表格循环内）显示 行/总数 角标，画布上能看到逐行轮询进度。
// 逻辑判断节点有两个 source 连接点（是/否），其余模块单个。
// 右上角删除按钮悬停/选中时出现：走 deleteElements → React Flow 的 onBeforeDelete
// 二次确认（与 Delete 键同一条路，确认逻辑在 Editor 的 confirmDelete）。
import React, { useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, LoadingOutlined } from '@ant-design/icons'
import { MODULES } from './constants.js'

const STATUS_STYLE = {
  running: {
    border: '1.5px solid #1677ff',
    boxShadow: '0 0 0 3px rgba(22,119,255,0.25), 0 0 18px rgba(22,119,255,0.35)',
  },
  success: {
    border: '1.5px solid #52c41a',
    boxShadow: '0 0 0 3px rgba(82,196,26,0.2)',
  },
  failed: {
    border: '1.5px solid #ff4d4f',
    boxShadow: '0 0 0 3px rgba(255,77,79,0.2)',
  },
}

function StatusIcon({ status }) {
  if (status === 'running') return <LoadingOutlined style={{ color: '#1677ff', fontSize: 15 }} spin />
  if (status === 'success') return <CheckCircleFilled style={{ color: '#52c41a', fontSize: 15 }} />
  if (status === 'failed') return <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: 15 }} />
  return null
}

/** 逻辑判断的双分支 source 连接点：是（绿，上）/ 否（红，下），带小标签。 */
function BranchHandles() {
  const labelStyle = {
    position: 'absolute',
    right: 16,
    fontSize: 10,
    lineHeight: '14px',
    color: 'rgba(255,255,255,0.55)',
  }
  return (
    <>
      <span style={{ ...labelStyle, top: 'calc(30% - 7px)' }}>是</span>
      <span style={{ ...labelStyle, bottom: 'calc(30% - 7px)' }}>否</span>
      <Handle type="source" id="yes" position={Position.Right} style={{ top: '30%', background: '#52c41a' }} />
      <Handle type="source" id="no" position={Position.Right} style={{ top: '70%', background: '#ff4d4f' }} />
    </>
  )
}

export default function CrawlerNode({ id, data, type, selected }) {
  const meta = MODULES[type] || MODULES.webpage
  const Icon = meta.icon
  const status = data.status
  const invalid = data.invalid // 必填缺失文案（Editor 派生写入，红色闪烁提醒）
  const { deleteElements } = useReactFlow()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 220,
        borderRadius: 10,
        padding: '10px 12px',
        background: 'rgba(20,20,24,0.92)',
        backdropFilter: 'blur(12px)',
        border: selected ? `1.5px solid ${meta.color}` : '1px solid rgba(255,255,255,0.14)',
        boxShadow: selected ? `0 0 0 3px ${meta.color}33` : '0 2px 10px rgba(0,0,0,0.4)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        ...STATUS_STYLE[status],
        // 必填缺失最高优先：红色边框呼吸闪烁（keyframes 在 Editor 注入），压过选中/运行态
        ...(invalid
          ? { border: '1.5px solid #ff4d4f', animation: 'crawler-invalid-blink 1.2s ease-in-out infinite' }
          : {}),
        opacity: status === 'success' ? 0.92 : 1,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#5a5a66' }} />
      {(hovered || selected) && (
        <span
          title="删除该模块"
          role="button"
          onClick={(e) => {
            e.stopPropagation()
            deleteElements({ nodes: [{ id }] })
          }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: -9,
            right: -9,
            width: 20,
            height: 20,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#1f1f23',
            border: '1px solid rgba(255,77,79,0.55)',
            color: '#ff7875',
            fontSize: 11,
            cursor: 'pointer',
            zIndex: 5,
          }}
        >
          <DeleteOutlined />
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: meta.color, fontSize: 16, display: 'flex' }}>
          <Icon />
        </span>
        <span style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.label || meta.name}
        </span>
        {data.iteration && (
          <span
            title={`表格循环：第 ${data.iteration.row}/${data.iteration.total} 行`}
            style={{
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 5px',
              borderRadius: 8,
              flexShrink: 0,
              color: '#eb2f96',
              background: 'rgba(235,47,150,0.14)',
              border: '1px solid rgba(235,47,150,0.35)',
            }}
          >
            {data.iteration.row}/{data.iteration.total}
          </span>
        )}
        <StatusIcon status={status} />
      </div>
      <div
        title={invalid ? `必填缺失：${invalid}` : status === 'failed' ? data.error : data.summary || meta.summary(data)}
        style={{
          marginTop: 6,
          fontSize: 11,
          color: invalid || status === 'failed' ? '#ff7875' : status === 'success' ? '#95de64' : 'rgba(255,255,255,0.45)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {invalid
          ? `缺必填：${invalid}`
          : status === 'failed'
            ? data.error
            : status === 'success'
              ? data.summary || '完成'
              : meta.summary(data)}
      </div>
      {type === 'condition' ? (
        <BranchHandles />
      ) : (
        <Handle type="source" position={Position.Right} style={{ background: meta.color }} />
      )}
    </div>
  )
}
