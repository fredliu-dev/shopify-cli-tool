// 变量输入框：AutoComplete 自由输入 + 下拉选「已定义的变量」（数据源由 Editor 汇总，
// 见 constants.js 的 collectVariableOptions：画布静态定义 + 上次运行的变量快照下钻）。
// 两种模式：
//   name：整框就是一个变量路径（数据循环的「要循环的变量」），选中直接填路径
//   expr：可混合普通文本（逻辑判断的值、表格编辑的值、打开网址的 URL），选中把
//         {{变量}} 插入光标处——已输入的文本保留，实现 URL/文本拼接变量
// 聚焦即展开全量列表；输入时按去花括号后的关键字过滤（值已是 {{价格}} 也能过滤出 价格）。
import React, { useRef, useState } from 'react'
import { AutoComplete } from 'antd'

export default function VariableInput({ value, onChange, options = [], mode = 'expr', placeholder }) {
  const [open, setOpen] = useState(false)
  // antd 选中会先 onSelect 再 onChange（携带原始选项值），用标志拦掉第二次，保住 {{}} 包装
  const suppressChangeRef = useRef(false)
  // 拿内层 input 的光标位置：expr 模式插入用（antd AutoComplete 的 DOM 结构是 input > div）
  const rootRef = useRef(null)

  // 在光标处插入 {{变量}}：光标前后的文本保留，支持 https://x.com/{{路径}} 这类拼接
  const insertAtCursor = (snippet) => {
    const input = rootRef.current?.querySelector('input')
    const pos = input ? input.selectionStart ?? value.length : value.length
    const next = String(value ?? '').slice(0, pos) + snippet + String(value ?? '').slice(input ? input.selectionEnd ?? pos : pos)
    onChange?.(next)
    // 恢复光标到插入片段之后（下一帧 DOM 已更新）
    requestAnimationFrame(() => {
      try { input?.setSelectionRange(pos + snippet.length, pos + snippet.length) } catch {}
    })
  }

  return (
    <div ref={rootRef} style={{ width: '100%' }}>
      <AutoComplete
        value={value}
        options={options}
        open={open}
        onOpenChange={setOpen}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        style={{ width: '100%' }}
        filterOption={(input, option) =>
          String(option.value).toLowerCase().includes(String(input).replace(/[{}\s]/g, '').toLowerCase())
        }
        notFoundContent="没有匹配的变量"
        onSelect={(v) => {
          suppressChangeRef.current = true
          if (mode === 'name') {
            onChange?.(v)
            return
          }
          // 空值时插入 = 直接替换，行为与旧版一致
          if (!value) {
            onChange?.(`{{${v}}}`)
            return
          }
          insertAtCursor(`{{${v}}}`)
        }}
        onChange={(v) => {
          if (suppressChangeRef.current) {
            suppressChangeRef.current = false
            return
          }
          onChange?.(v ?? '')
        }}
      />
    </div>
  )
}
