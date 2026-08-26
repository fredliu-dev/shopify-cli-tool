// 爬虫工作流页（主窗口左侧栏切换进入）：列表/编辑器两视图切换（组件内 state，
// 不上 hash 子路由——切页回列表可接受，自动保存保证不丢数据）。
import { useState } from 'react'
import ProjectList from './ProjectList.jsx'
import Editor from './Editor.jsx'

export default function CrawlerPage() {
  const [projectId, setProjectId] = useState(null)

  return (
    <div
      style={{
        // 内嵌主窗口：高度撑满内容区（壳层容器已定高）；同主窗口的彩色光晕背景
        height: '100%',
        background: '#0d0d0f',
        backgroundImage:
          'radial-gradient(circle at 12% 18%, rgba(22,119,255,0.14), transparent 38%), radial-gradient(circle at 88% 12%, rgba(114,46,241,0.12), transparent 36%), radial-gradient(circle at 78% 88%, rgba(19,194,194,0.10), transparent 40%)',
        backgroundAttachment: 'fixed',
      }}
    >
      {projectId === null ? (
        <ProjectList onOpen={setProjectId} onImported={setProjectId} />
      ) : (
        <Editor projectId={projectId} onBack={() => setProjectId(null)} />
      )}
    </div>
  )
}
