// 变量输入框：AutoComplete 自由输入 + 下拉选「已定义的变量」（数据源由 Editor 汇总，
// 见 constants.js 的 collectVariableOptions：画布静态定义 + 上次运行的变量快照下钻）。
// 两种模式：
//   name：整框就是一个变量路径（数据循环的「要循环的变量」），选中直接填路径
//   expr：可混合普通文本（逻辑判断的值、表格编辑的值），选中插入 {{变量}}
// 聚焦即展开全量列表；输入时按去花括号后的关键字过滤（值已是 {{价格}} 也能过滤出 价格）。
import React, { useRef, useState } from 'react'
import { AutoComplete } from 'antd'

export default function VariableInput({ value, onChange, options = [], mode = 'expr', placeholder }) {
  const [open, setOpen] = useState(false)
  // antd 选中会先 onSelect 再 onChange（携带原始选项值），用标志拦掉第二次，保住 {{}} 包装
  const suppressChangeRef = useRef(false)

  return (
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
        onChange?.(mode === 'expr' ? `{{${v}}}` : v)
      }}
      onChange={(v) => {
        if (suppressChangeRef.current) {
          suppressChangeRef.current = false
          return
        }
        onChange?.(v ?? '')
      }}
    />
  )
}
