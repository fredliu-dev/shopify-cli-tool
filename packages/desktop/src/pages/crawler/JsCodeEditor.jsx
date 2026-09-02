// 爬虫 JS 代码编辑器（数据处理模块等）：CodeMirror 6 封装。
// 自带 JS 语法高亮 + 输入提示（关键词/成员/作用域补全，basicSetup 的 autocompletion），
// 暗色贴合爬虫界面：背景透明只留描边，行号槽同色。受控组件：value/onChange 与 antd 一致。
import React, { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'

// 界面材质：透明背景融进抽屉，等宽字体，行号弱化
const matTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', fontSize: '12px' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'rgba(255,255,255,0.18)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

export default function JsCodeEditor({ value, onChange, placeholder, minHeight = 96, maxHeight = 380 }) {
  const extensions = useMemo(() => [javascript(), matTheme], [])
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(0,0,0,0.25)',
      }}
    >
      <CodeMirror
        value={value ?? ''}
        onChange={onChange}
        theme={oneDark}
        extensions={extensions}
        placeholder={placeholder}
        minHeight={`${minHeight}px`}
        maxHeight={`${maxHeight}px`}
        basicSetup={{
          foldGutter: false,
          highlightActiveLine: false,
          autocompletion: true, // 输入时弹出语法提示（含 JS 内置对象/成员/作用域变量）
        }}
      />
    </div>
  )
}
