import React, { useEffect, useState } from 'react'
import { App } from 'antd'
import { DetailDrawer, FlowModal, TapdStyles } from '../pages/Tapd.jsx'

/**
 * 工单详情抽屉宿主（主窗口本地项目彩带点击用）：传入工单链接（项目 _tapd），
 * 自动解析出完整工单实体，并拉取状态映射 / 当前账号，渲染与 TAPD 工单页
 * 完全同款的 DetailDrawer（描述富文本 + 评论回复修改 + 流转路径轨道）与
 * FlowModal（状态链流转）。数据依赖（statusMap/myName/transitions/members）
 * 全部在本组件内按需拉取，调用方只需给 open/link/onClose 三个 props。
 */
export default function TapdItemDrawer({ open, link, onClose }) {
  const { message, modal } = App.useApp()
  const [data, setData] = useState(null) // resolveWorkItem 的结果：{ type, workspaceId, item, ... }
  const [statusMap, setStatusMap] = useState(null)
  const [myName, setMyName] = useState('')
  const [flowItem, setFlowItem] = useState(null)
  const [transitions, setTransitions] = useState([])
  const [members, setMembers] = useState([])

  // 解析链接 → 完整工单实体；随后并行拉该类型状态映射与当前账号（评论作者 / 「我的」判定用）。
  // silent：重开同一链接时的静默刷新——已有数据先原样展示（抽屉不闪关重开），后台重拉后原地更新
  const resolve = async (silent = false) => {
    const hide = silent ? null : message.loading('正在解析工单…', 0)
    const res = await window.api.tapd.resolveWorkItem({ input: link })
    hide?.()
    if (!res.ok) {
      // 静默刷新失败：保留旧数据继续展示，仅提示，不关抽屉
      if (silent) {
        message.error(res.error || '工单刷新失败')
        return
      }
      if (res.error === 'NO_TAPD_AUTH') {
        modal.warning({
          title: '尚未配置 TAPD 访问令牌',
          content: '打开 TAPD 工单窗口完成令牌配置后，即可在这里查看工单详情。',
          okText: '去配置',
          cancelText: '取消',
          onOk: () => window.api.tapd.openWindow(),
        })
      } else {
        message.error(res.error || '工单解析失败')
      }
      onClose?.()
      return
    }
    setData(res.data)
    const [sm, u] = await Promise.all([
      window.api.tapd.statusMap({ type: res.data.type, workspaceId: res.data.workspaceId }),
      window.api.tapd.user(),
    ])
    if (sm.ok) setStatusMap(sm.data)
    if (u.ok && u.data?.name) setMyName(u.data.name)
  }

  useEffect(() => {
    if (!open || !link) return
    // 注意不清 data/statusMap/myName：data 若在重开时被清空，open 置 true 的首帧渲染先带出
    // 旧数据（抽屉滑入）、effect 再置空（滑出）、解析完成又滑入——形成「出来→回去→出来」
    // 的三段闪动。保留旧数据即可重开秒开，解析完成后原地刷新；仅清流转相关状态
    // （重开不该复活上一次的流转弹窗）。
    setFlowItem(null)
    setTransitions([])
    setMembers([])
    resolve(!!data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, link])

  // 点「流转」：拉该类型流转细则与项目成员后弹流转窗（与工单页同一弹窗）
  const openFlow = async (it) => {
    if (!data) return
    setFlowItem(it)
    const [tr, mb] = await Promise.all([
      window.api.tapd.transitions({ type: data.type, workspaceId: data.workspaceId }),
      window.api.tapd.members({ workspaceId: data.workspaceId }),
    ])
    if (tr.ok) setTransitions(tr.data || [])
    if (mb.ok) setMembers(mb.data || [])
  }

  return (
    <>
      {/* 抽屉/流转弹窗用到的 tapd-* class（富文本、节点脉冲、流动虚线）依赖这组样式 */}
      <TapdStyles />
      <DetailDrawer
        open={open && !!data?.item}
        item={data?.item}
        type={data?.type || 'story'}
        statusMap={statusMap}
        workspaceId={data?.workspaceId}
        myName={myName}
        onClose={onClose}
        onFlow={openFlow}
      />
      <FlowModal
        open={!!flowItem}
        item={flowItem}
        type={data?.type || 'story'}
        statusMap={statusMap}
        transitions={transitions}
        members={members}
        workspaceId={data?.workspaceId}
        myName={myName}
        onClose={() => setFlowItem(null)}
        onDone={() => {
          setFlowItem(null)
          // 流转成功后重拉该工单，抽屉原地刷新为最新状态（core 已清该 workspace 列表缓存）
          resolve()
        }}
      />
    </>
  )
}
