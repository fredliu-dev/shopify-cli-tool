// 爬虫工作流页（主窗口左侧栏切换进入）：列表/编辑器两视图切换（组件内 state，
// 不上 hash 子路由——切页回列表可接受，自动保存保证不丢数据）。
// 页面基底：近黑 #08080a + 低饱和极光（比旧版三色光晕克制，透出的是「深空壁纸」
// 而非彩色霓虹）；GLOBAL_CSS 注入细滚动条/选中色，作用域限 .crawler-root。
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
        background: '#08080a',
        backgroundImage:
          'radial-gradient(1100px 700px at 8% -10%, rgba(10,132,255,0.10), transparent 60%),' +
          'radial-gradient(900px 600px at 95% -5%, rgba(94,92,230,0.09), transparent 55%),' +
          'radial-gradient(1000px 800px at 85% 110%, rgba(99,230,226,0.05), transparent 55%)',
        backgroundAttachment: 'fixed',
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
