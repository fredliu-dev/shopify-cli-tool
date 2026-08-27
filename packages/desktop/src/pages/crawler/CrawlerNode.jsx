// React Flow 自定义节点：图标 chip + 名称 + 配置摘要 + 左右 Handle 连接点。
// data.status 由 Editor 根据主进程推送写回：running 蓝呼吸 / success 绿 / failed 红。
// data.iteration（数据循环内）显示 项/总数 角标，画布上能看到逐项轮询进度。
// 逻辑判断节点有两个 source 连接点（是/否），其余模块单个。
// 右上角删除按钮悬停/选中时出现：走 deleteElements → React Flow 的 onBeforeDelete
// 二次确认（与 Delete 键同一条路，确认逻辑在 Editor 的 confirmDelete）。
import React, { useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, LoadingOutlined } from '@ant-design/icons'
import { MODULES } from './constants.js'
import { EASE, INK, LIFT_SOFT, MAT, STATUS, iconChip } from './theme.js'

const STATUS_STYLE = {
  running: {
    border: `1.5px solid ${STATUS.running}`,
    boxShadow: `0 0 0 3px rgba(10,132,255,0.22), 0 0 20px rgba(10,132,255,0.28), ${LIFT_SOFT}`,
    animation: 'crawler-run-breath 1.8s ease-in-out infinite',
  },
  success: {
    border: `1.5px solid ${STATUS.success}`,
    boxShadow: `0 0 0 3px rgba(48,209,88,0.16), ${LIFT_SOFT}`,
  },
  failed: {
    border: `1.5px solid ${STATUS.failed}`,
    boxShadow: `0 0 0 3px rgba(255,69,58,0.16), ${LIFT_SOFT}`,
  },
}

function StatusIcon({ status }) {
  if (status === 'running') return <LoadingOutlined style={{ color: STATUS.running, fontSize: 14 }} spin />
  if (status === 'success') return <CheckCircleFilled style={{ color: STATUS.success, fontSize: 14 }} />
  if (status === 'failed') return <CloseCircleFilled style={{ color: STATUS.failed, fontSize: 14 }} />
  return null
}

/** 连接点统一样式：8px 圆点 + 深色描边环（否则浅色点在浅节点上看不出圆的）。 */
const HANDLE_BASE = { width: 8, height: 8, border: '2px solid #101014', background: '#8e8e96' }

/** 逻辑判断的双分支 source 连接点：是（绿，上）/ 否（红，下），带小标签。 */
function BranchHandles() {
  const labelStyle = {
    position: 'absolute',
    right: 16,
    fontSize: 10,
    lineHeight: '14px',
    color: 'rgba(255,255,255,0.5)',
  }
  return (
    <>
      <span style={{ ...labelStyle, top: 'calc(30% - 7px)' }}>是</span>
      <span style={{ ...labelStyle, bottom: 'calc(30% - 7px)' }}>否</span>
      <Handle type="source" id="yes" position={Position.Right} style={{ top: '30%', ...HANDLE_BASE, background: STATUS.success }} />
      <Handle type="source" id="no" position={Position.Right} style={{ top: '70%', ...HANDLE_BASE, background: STATUS.failed }} />
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
        width: 230,
        borderRadius: 13,
        padding: '11px 13px',
        background: 'linear-gradient(180deg, rgba(40,40,46,0.88), rgba(26,26,31,0.92))',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        border: selected ? `1.5px solid ${meta.color}` : `1px solid ${MAT.line2}`,
        boxShadow: selected
          ? `0 0 0 3px ${meta.color}2e, ${LIFT_SOFT}`
          : hovered
            ? `0 0 0 1px rgba(255,255,255,0.06), ${LIFT_SOFT}`
            : '0 1px 2px rgba(0,0,0,0.4), 0 4px 14px rgba(0,0,0,0.28)',
        transition: `border-color 0.22s ${EASE}, box-shadow 0.22s ${EASE}`,
        ...STATUS_STYLE[status],
        // 必填缺失最高优先：红色边框呼吸闪烁（keyframes 在 Editor 注入），压过选中/运行态
        ...(invalid
          ? { border: `1.5px solid ${STATUS.failed}`, animation: 'crawler-invalid-blink 1.2s ease-in-out infinite' }
          : {}),
        opacity: status === 'success' ? 0.94 : 1,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_BASE} />
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
            background: 'rgba(42,42,48,0.95)',
            border: `1px solid ${MAT.line2}`,
            color: INK[2],
            fontSize: 11,
            cursor: 'pointer',
            zIndex: 5,
            transition: `color 0.18s ${EASE}, border-color 0.18s ${EASE}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#ff6961'
            e.currentTarget.style.borderColor = 'rgba(255,69,58,0.5)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = INK[2]
            e.currentTarget.style.borderColor = MAT.line2
          }}
        >
          <DeleteOutlined />
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={iconChip(meta.color, 26, 14)}>
          <Icon />
        </span>
        <span
          style={{
            color: INK[1],
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label || meta.name}
        </span>
        {data.iteration && (
          <span
            title={`循环进度：第 ${data.iteration.row}/${data.iteration.total} 项`}
            style={{
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 6px',
              borderRadius: 8,
              flexShrink: 0,
              color: '#ff6b85',
              background: 'rgba(255,55,95,0.14)',
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
          marginTop: 7,
          fontSize: 11,
          color: invalid || status === 'failed' ? '#ff6961' : status === 'success' ? '#5ad06f' : INK[3],
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
        <Handle type="source" position={Position.Right} style={{ ...HANDLE_BASE, background: meta.color }} />
      )}
    </div>
  )
}
