// 爬虫工作流页（主窗口左侧栏切换进入）：列表/编辑器两视图切换（组件内 state，
// 不上 hash 子路由——切页回列表可接受，自动保存保证不丢数据）。
// 页面基底：不自带背景（壳层在该页已是纯 #0d0d0f）；GLOBAL_CSS 注入细滚动条/选中色，
// 作用域限 .crawler-root。
import { useState } from 'react'
import ProjectList from './ProjectList.jsx'
import Editor from './Editor.jsx'
import { GLOBAL_CSS } from './theme.js'

export default function CrawlerPage() {
  const [projectId, setProjectId] = useState(null)

  return (
    <div
      className="crawler-root"
      style={{
        // 内嵌主窗口：高度撑满内容区（壳层容器已定高）
        height: '100%',
      }}
    >
      <style>{GLOBAL_CSS}</style>
      {projectId === null ? (
        <ProjectList onOpen={setProjectId} onImported={setProjectId} />
      ) : (
        <Editor projectId={projectId} onBack={() => setProjectId(null)} />
      )}
    </div>
  )
}
