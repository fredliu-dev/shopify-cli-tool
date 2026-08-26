// 跨组件请求主壳（App.jsx 的 MainShell）切换左侧栏页面。
// 弹窗/抽屉深处的入口（如「去配置 TAPD」）拿不到壳层的 props，用 window 自定义事件解耦；
// MainShell 监听 'shell:switch-page' 事件（detail 为页面 key：repos / tapd / crawler）。
export function switchShellPage(key) {
  window.dispatchEvent(new CustomEvent('shell:switch-page', { detail: key }))
}
