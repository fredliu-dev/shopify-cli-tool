// 选择器共用表单块：匹配方式（class/id/class 正则/CSS 选择器）+ 值 + 超时。
// wait/click/input/extract 四种模块的配置抽屉复用；语义与注入脚本 findAll 一致。
import React from 'react'
import { Form, Input, InputNumber, Radio, Typography } from 'antd'
import { SELECTOR_MODES } from './constants.js'
import { MAT } from './theme.js'

const { Text } = Typography

/**
 * @param {object} props
 * @param {string} props.name Label/超时等表单字段挂载在父 Form 的 data 下，selector 子对象用嵌套 name
 * @param {number} props.defaultTimeout 默认超时（抽取等无 selector.timeoutMs 的模块用独立字段）
 */
export default function SelectorInput({ value, onChange, timeoutLabel = '超时时间（毫秒）' }) {
  const sel = value || { mode: 'class', value: '', timeoutMs: 10000 }
  const patch = (fields) => onChange({ ...sel, ...fields })
  const mode = SELECTOR_MODES.find((m) => m.value === sel.mode)?.label || sel.mode
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 12,
        background: MAT.card,
        border: `1px solid ${MAT.line}`,
      }}
    >
      <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>
        元素选择器
      </Text>
      <Radio.Group
        size="small"
        optionType="button"
        buttonStyle="solid"
        options={SELECTOR_MODES}
        value={sel.mode}
        onChange={(e) => patch({ mode: e.target.value })}
        style={{ marginBottom: 10 }}
      />
      <Input
        size="small"
        placeholder={
          sel.mode === 'id'
            ? '元素 id，如 kw'
            : sel.mode === 'classRegex'
              ? 'class 正则，如 price.*old'
              : sel.mode === 'css'
                ? 'CSS 选择器，如 #kw、.btn.primary、a[href*="detail"]'
                : 'class 类名，如 next'
        }
        value={sel.value}
        onChange={(e) => patch({ value: e.target.value })}
        addonBefore={mode}
        style={{ marginBottom: 10 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          {timeoutLabel}
        </Text>
        <InputNumber
          size="small"
          min={500}
          step={500}
          value={sel.timeoutMs}
          onChange={(v) => patch({ timeoutMs: v || 5000 })}
          style={{ width: 110 }}
          addonAfter="ms"
          controls={false}
        />
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8, lineHeight: 1.6 }}>
        {sel.mode === 'id'
          ? '按 id 精确匹配元素'
          : sel.mode === 'classRegex'
            ? 'class 属性整体做正则匹配（包含即命中），可匹配动态类名'
            : sel.mode === 'css'
              ? '标准 CSS 选择器语法：#id、.class、[属性="值"]；属性值支持 *= 包含、^= 开头、$= 结尾等模糊匹配，组合如 div.item > a[href^="/p"]'
              : '按 class 名精确匹配（空格分隔的完整类名之一）'}
        ；查找会自动穿透 shadow DOM 与同源 iframe
      </Text>
    </div>
  )
}
