// 右侧配置抽屉：按模块类型渲染表单，onChange 实时写回 node.data（受控，无确定按钮）。
// extract 的多字段编辑：字段卡片列表，可增删；每字段 = 名称 + 选择器 + 提取方式（text/href/attr）。
import React from 'react'
import {
  App,
  AutoComplete,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import SelectorInput from './SelectorInput.jsx'
import VariableInput from './VariableInput.jsx'
import { CLICK_EVENTS, CLICK_TARGETS, CONDITION_OPS, KEY_EVENTS, KEY_MODIFIERS, MODULES, isUnaryOp } from './constants.js'
import { INK, MAT, iconChip } from './theme.js'

/** 抽屉内嵌卡片（字段卡 / 文件摘要卡）：统一材质，radius 12。 */
const NEST_CARD = {
  padding: 12,
  borderRadius: 12,
  background: MAT.card,
  border: `1px solid ${MAT.line}`,
  marginBottom: 10,
}

const { Text } = Typography

const EXTRACT_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'href', label: '链接' },
  { value: 'attr', label: '属性' },
]

function FieldCard({ field, index, onChange, onRemove, commonElements = [] }) {
  const patch = (fields) => onChange(index, { ...field, ...fields })
  const patchSelector = (s) => patch({ selector: s })
  return (
    <div style={NEST_CARD}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <Tag color="green" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
          字段{index + 1}
        </Tag>
        <Input
          size="small"
          placeholder="字段名（表格列名）"
          value={field.name}
          onChange={(e) => patch({ name: e.target.value })}
          maxLength={30}
        />
        <Popconfirm title="删除该字段？" onConfirm={() => onRemove(index)} okText="删除" cancelText="取消">
          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>
      <SelectorInput value={field.selector} onChange={patchSelector} timeoutLabel="查找超时" commonElements={commonElements} />
      <div style={{ marginTop: 10 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          提取内容
        </Text>
        <Radio.Group
          size="small"
          optionType="button"
          buttonStyle="solid"
          options={EXTRACT_TYPES}
          value={field.extract?.type || 'text'}
          onChange={(e) => patch({ extract: { ...(field.extract || {}), type: e.target.value } })}
          style={{ display: 'flex', marginTop: 6 }}
        />
        {field.extract?.type === 'attr' && (
          <Input
            size="small"
            placeholder="属性名，如 data-price"
            value={field.extract.attr || ''}
            onChange={(e) => patch({ extract: { ...field.extract, attr: e.target.value } })}
            style={{ marginTop: 8 }}
          />
        )}
      </div>
    </div>
  )
}

export default function ConfigDrawer({ node, open, onClose, onDataPatch, variableOptions = [], commonLib = {} }) {
  const { message } = App.useApp()
  if (!node) return null
  const meta = MODULES[node.type]
  const Icon = meta.icon
  const data = node.data || {}
  const patch = (fields) => onDataPatch(node.id, fields)
  // 公共资源库：元素给所有带选择器的模块下拉选用，网址给「打开网页」选用
  const commonElements = commonLib.elements || []
  const commonUrls = commonLib.urls || []

  // 选表格文件：主进程弹框并解析（格式错误当场报），节点只存路径+行列摘要，运行时重读最新内容
  const pickTableFile = async () => {
    const res = await window.api.crawler.pickTableFile()
    if (!res.ok) return message.error(res.error || '选择失败')
    if (res.canceled) return
    const d = res.data
    patch({
      filePath: d.path,
      fileName: d.path.replace(/\\/g, '/').split('/').pop(),
      rowCount: d.rowCount,
      columns: d.columns,
    })
  }

  // 选保存目录（表格导出模块用）：只取路径，不做解析
  const pickSaveDir = async () => {
    const res = await window.api.crawler.pickSaveDir()
    if (!res.ok) return message.error(res.error || '选择失败')
    if (res.canceled) return
    patch({ savePath: res.data.path })
  }

  const patchField = (i, fields) => {
    const next = (data.fields || []).map((f, idx) => (idx === i ? fields : f))
    patch({ fields: next })
  }
  const removeField = (i) => patch({ fields: (data.fields || []).filter((_, idx) => idx !== i) })
  const addField = () =>
    patch({
      fields: [
        ...(data.fields || []),
        { name: `字段${(data.fields?.length || 0) + 1}`, selector: { mode: 'class', value: '', timeoutMs: 5000 }, extract: { type: 'text' } },
      ],
    })

  return (
    <Drawer
      title={
        <Space>
          <span style={iconChip(meta.color, 24, 13)}>
            <Icon />
          </span>
          <span style={{ fontWeight: 600, color: INK[1] }}>配置「{meta.name}」模块</span>
        </Space>
      }
      placement="right"
      width={460}
      open={open}
      onClose={onClose}
      styles={{
        header: { padding: '14px 20px', borderBottom: `1px solid ${MAT.line}` },
        body: { paddingTop: 14, background: '#101014' },
      }}
    >
      <Form layout="vertical" component={false}>
        <Form.Item label="节点名称" style={{ marginBottom: 14 }}>
          <Input
            value={data.label}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder={meta.name}
            maxLength={30}
          />
        </Form.Item>

        {node.type === 'webpage' && (
          <>
            {commonUrls.length > 0 && (
              <Form.Item label="从公共网址选择" style={{ marginBottom: 12 }}>
                <Select
                  size="small"
                  placeholder="选公共网址填入（也可直接手填/拼接变量）"
                  value={null}
                  options={commonUrls.map((u) => ({
                    value: u.id,
                    label: `${u.name}（${u.value.length > 40 ? u.value.slice(0, 40) + '…' : u.value}）`,
                  }))}
                  onChange={(id) => {
                    const hit = commonUrls.find((u) => u.id === id)
                    if (hit) patch({ url: hit.value })
                  }}
                  allowClear
                  onClear={() => patch({ url: '' })}
                />
              </Form.Item>
            )}
            <Form.Item label="网址 URL" required style={{ marginBottom: 14 }}>
              <VariableInput
                value={data.url}
                onChange={(v) => patch({ url: v })}
                options={variableOptions}
                mode="expr"
                placeholder="https://example.com/list，可从下拉选变量拼接到光标处，如 https://x.com/{{表格项.URL}}"
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12 }}>
              流程从「网页」节点开始，打开网址后依次执行后续模块。
            </Text>
          </>
        )}

        {node.type === 'wait' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} commonElements={commonElements} />
            <Form.Item label="等待模式" style={{ marginTop: 14, marginBottom: 12 }}>
              <Radio.Group
                size="small"
                optionType="button"
                buttonStyle="solid"
                options={[
                  { label: '出现', value: 'appear' },
                  { label: '消失', value: 'gone' },
                ]}
                value={data.waitMode || 'appear'}
                onChange={(e) => patch({ waitMode: e.target.value })}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              等页面里该元素出现（或勾「消失」：等 loading 遮罩/弹窗关闭后再继续）后才执行后面的模块。
            </Text>
          </>
        )}

        {node.type === 'click' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} commonElements={commonElements} />
            <Form.Item label="触发事件" style={{ marginTop: 14, marginBottom: 12 }}>
              <Radio.Group
                size="small"
                optionType="button"
                buttonStyle="solid"
                options={CLICK_EVENTS}
                value={data.event || 'click'}
                onChange={(e) => patch({ event: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="触发范围" style={{ marginBottom: 12 }}>
              <Radio.Group
                size="small"
                optionType="button"
                buttonStyle="solid"
                options={CLICK_TARGETS}
                value={data.target || 'first'}
                onChange={(e) => patch({ target: e.target.value })}
              />
            </Form.Item>
            {(data.target || 'first') === 'all' && (
              <Form.Item label="触发间隔（秒）" style={{ marginBottom: 12 }} extra="依次触发每个元素后等待多久再点下一个，留给页面动画/请求走完">
                <InputNumber
                  min={0}
                  max={60}
                  step={0.1}
                  value={data.gapMs != null ? data.gapMs / 1000 : 0.12}
                  onChange={(v) => patch({ gapMs: v == null ? undefined : Math.round(v * 1000) })}
                  style={{ width: 160 }}
                  addonAfter="秒"
                />
              </Form.Item>
            )}
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4, lineHeight: 1.7 }}>
              匹配到多个元素时：仅触发第一个，或按页面顺序依次触发全部（间隔可在上方配置，默认 0.12 秒）。回车会先聚焦元素再按键；
              点击/双击/回车可能引起页面跳转，会自动等加载完成，超时时间兼作触发与等待跳转的上限。
            </Text>
          </>
        )}

        {node.type === 'input' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} commonElements={commonElements} />
            <Form.Item label="输入内容" required style={{ marginTop: 14, marginBottom: 0 }}>
              <Input.TextArea
                value={data.text}
                onChange={(e) => patch({ text: e.target.value })}
                placeholder="要填入的文本"
                autoSize={{ minRows: 2, maxRows: 4 }}
                maxLength={2000}
              />
            </Form.Item>
          </>
        )}

        {node.type === 'keyboard' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} commonElements={commonElements} />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '8px 0 14px', lineHeight: 1.6 }}>
              选择器留空 = 按键发给当前聚焦的元素（如上一步输入框）；填写 = 先自动聚焦该元素再按键
            </Text>
            <Form.Item label="按键" required style={{ marginBottom: 12 }}>
              <AutoComplete
                value={data.key || 'Enter'}
                onChange={(v) => patch({ key: v })}
                options={KEY_EVENTS}
                style={{ width: 220 }}
                placeholder="选择或输入键名（如 F5）"
                filterOption={(input, option) => String(option.value).toLowerCase().includes(String(input).toLowerCase())}
              />
            </Form.Item>
            <Form.Item label="修饰键（可与按键组合）" style={{ marginBottom: 12 }}>
              <Checkbox.Group
                options={KEY_MODIFIERS}
                value={Array.isArray(data.modifiers) ? data.modifiers : []}
                onChange={(vals) => patch({ modifiers: vals })}
              />
            </Form.Item>
            <Form.Item label="重复次数" style={{ marginBottom: 14 }} extra="连按多次，如方向键连按 3 次移动三项">
              <InputNumber
                min={1}
                max={20}
                value={Number(data.repeat) || 1}
                onChange={(v) => patch({ repeat: v || 1 })}
                style={{ width: 140 }}
                addonAfter="次"
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              发送的是浏览器原生键盘事件（区别于「元素事件」里的合成回车）：回车能触发表单提交/搜索、
              Backspace 能删除字符、Tab 能移动焦点，与真实击键行为一致。
            </Text>
          </>
        )}

        {node.type === 'extract' && (
          <>
            <Form.Item label="查找超时（毫秒）" style={{ marginBottom: 14 }}>
              <InputNumber
                min={500}
                step={500}
                value={data.timeoutMs}
                onChange={(v) => patch({ timeoutMs: v || 5000 })}
                style={{ width: 140 }}
                addonAfter="ms"
                controls={false}
              />
            </Form.Item>
            <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>
              提取字段
            </Text>
            {(data.fields || []).map((f, i) => (
              <FieldCard key={i} field={f} index={i} onChange={patchField} onRemove={removeField} commonElements={commonElements} />
            ))}
            <Button type="dashed" block icon={<PlusOutlined />} onClick={addField}>
              添加字段
            </Button>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12, lineHeight: 1.7 }}>
              每个字段独立匹配所有命中元素：同一字段命中 N 个元素即产出 N 行；行数按各字段命中数的最大值对齐，缺失留空。
              写入变量时：命中 1 个存值本身，命中多个存数组（如 {'{{tag}}'} 为 ['a','b']，可在数据处理里 join / 循环遍历）。
              超时内一个都没命中不算错误：字段变量置为空数组 []、结果 0 行，流程继续（可用数据处理判 length 分流）。
            </Text>
          </>
        )}

        {node.type === 'intercept' && (
          <>
            <Form.Item label="接口地址（模糊匹配）" required style={{ marginBottom: 12 }}>
              <Input
                value={data.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="如 /api/list 或 example.com/search"
                maxLength={300}
              />
            </Form.Item>
            <Form.Item label="传参（模糊匹配，选填）" style={{ marginBottom: 12 }}>
              <Input
                value={data.param}
                onChange={(e) => patch({ param: e.target.value })}
                placeholder="如 skuId=123 或任意参数片段"
                maxLength={300}
              />
            </Form.Item>
            <Form.Item label="写入变量名" required style={{ marginBottom: 12 }}>
              <Input
                value={data.varName}
                onChange={(e) => patch({ varName: e.target.value })}
                placeholder="如 接口数据"
                maxLength={30}
              />
            </Form.Item>
            <Form.Item label="等待超时（毫秒）" style={{ marginBottom: 12 }}>
              <InputNumber
                min={1000}
                step={1000}
                value={data.timeoutMs}
                onChange={(v) => patch({ timeoutMs: v || 15000 })}
                style={{ width: 140 }}
                addonAfter="ms"
                controls={false}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              请求的地址、传参同时包含所填内容才命中（不区分大小写；传参会同时匹配 URL 问号后的查询串和
              POST 请求体）。命中后把接口响应内容写入变量：JSON 自动解析成对象，后续模块用
              {' {{变量名}}'} 取整包、{'{{变量名.字段.下标}}'} 取内部值。监听从流程起跑就开始，
              本节点执行前已发出的请求（如页面加载时的接口）也能捕获到；执行时还没等到则挂起等待，
              直到命中或超时。注意本节点需在「网页」之后（或与其平行）执行，否则页面未打开、无请求可等。
            </Text>
          </>
        )}

        {node.type === 'importTable' && (
          <>
            <Form.Item label="表格文件" required style={{ marginBottom: 12 }}>
              <Button block icon={<FolderOpenOutlined />} onClick={pickTableFile}>
                {data.filePath ? '重新选择文件…' : '选择 CSV / JSON 文件…'}
              </Button>
            </Form.Item>
            {data.filePath ? (
              <div style={{ ...NEST_CARD, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Text style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={data.filePath}>
                    {data.fileName}
                  </Text>
                  <Tag color="magenta" style={{ marginInlineEnd: 0 }}>
                    {data.rowCount} 行
                  </Tag>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(data.columns || []).map((c) => (
                    <Tag key={c} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {c}
                    </Tag>
                  ))}
                </div>
              </div>
            ) : (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                还未选择表格文件
              </Text>
            )}
            <Form.Item label="写入变量名" style={{ marginBottom: 12 }}>
              <Input
                value={data.varName || ''}
                onChange={(e) => patch({ varName: e.target.value })}
                placeholder="表格数据"
                maxLength={30}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              运行时重新读取文件内容（选完后文件更新也能拿到最新数据）。整表写入上面的变量
              （数组，每行一个对象），<b>不会自动逐行循环</b>——要逐行走就接一个{'「数据循环」'}
              模块并选这个变量（当前项的字段就是列名）；表格照常进控制台「表格」页。
            </Text>
          </>
        )}

        {node.type === 'loop' && (
          <>
            <Form.Item label="要循环的变量" required style={{ marginBottom: 12 }}>
              <VariableInput
                value={data.varName}
                onChange={(v) => patch({ varName: v })}
                options={variableOptions}
                mode="name"
                placeholder="下拉选择已定义的变量，或输入 .字段.下标 深层路径"
              />
            </Form.Item>
            <Form.Item label="分割符（变量为字符串时必填）" style={{ marginBottom: 12 }}>
              <Input
                value={data.split}
                onChange={(e) => patch({ split: e.target.value })}
                placeholder={'如 , 或 | ；换行填 \\n'}
                maxLength={20}
              />
            </Form.Item>
            <Form.Item label="当前项另存为变量（嵌套循环用）" style={{ marginBottom: 12 }}>
              <Input
                value={data.itemVar || ''}
                onChange={(e) => patch({ itemVar: e.target.value })}
                placeholder="选填，如 外层项 / 内层项"
                maxLength={30}
              />
            </Form.Item>
            <Form.Item label="并发进程数" style={{ marginBottom: 12 }}>
              <InputNumber
                min={1}
                max={10}
                value={data.concurrency || 1}
                onChange={(v) => patch({ concurrency: Math.max(1, Math.min(10, Math.round(v || 1))) })}
                style={{ width: 160 }}
                addonAfter="进程"
                controls={false}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              变量是数组时直接遍历（分割符不生效）；是字符串时按分割符拆分后遍历（
              {'\\n'} 表示换行，空片段自动丢弃）。每一轮把当前项写入 {'{{当前项}}'}、
              序号写入 {'{{当前序号}}'}（从 1 起），对象项的字段也直接作为变量可用。
              <b>循环嵌套时 {'{{当前项}}'} 是就近的（最内层）</b>——要同时引用两层循环的项，
              给每个循环填上面的「另存为变量」（如外层填 <b>外层项</b>、内层填 <b>内层项</b>），
              之后 {'{{外层项.字段}}'}、{'{{内层项.字段}}'} 在数据处理和任何模块里都能分开选。
              连线方式：循环体最后一个模块连回本模块<b>上方「下一项」出口</b> = 继续下一项；
              循环全部结束后从本模块<b>下方橙色「结束」出口</b>连出——嵌套时连到外层循环 =
              换外层下一项，或连到其他后续模块继续执行。并发大于 1 时同时起对应数量的隐藏浏览器
              进程，数据项轮流分给各进程同时跑循环体（各进程变量、表格行独立，互不影响；
              登录态共享；{'{{当前序号}}'} 仍是全局序号），跑完自动合并提取结果与表格，
              任一进程出错则整次运行失败；循环体内连到循环体外的连线会等全部进程结束后再走。
            </Text>
          </>
        )}

        {node.type === 'dataProcess' && (
          <>
            <Form.Item label="要处理的变量" required style={{ marginBottom: 12 }}>
              <VariableInput
                value={data.varName}
                onChange={(v) => patch({ varName: v })}
                options={variableOptions}
                mode="name"
                placeholder="下拉选择已定义的变量，或输入 .字段.下标 深层路径"
              />
            </Form.Item>
            <Form.Item label="处理代码（JS）" required style={{ marginBottom: 12 }}>
              <Input.TextArea
                value={data.code}
                onChange={(e) => patch({ code: e.target.value })}
                placeholder={'// value = 变量旧值，vars = 全部变量\nreturn value.map(x => x.title)'}
                autoSize={{ minRows: 4, maxRows: 14 }}
                maxLength={5000}
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
              />
            </Form.Item>
            {(() => {
              // 结果另存为新变量（可选）：留空 = return 结果覆盖原变量；填写 = 写入新变量。
              // 同名冲突校验：命中别的来源（静态声明/别的节点/运行快照）才报红；
              // 本节点自己声明过的（下拉里带 nodeId=自己 或纯运行时条目）不算冲突
              const out = String(data.outputVar ?? '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()
              const bad =
                !!out && variableOptions.some((o) => o.value === out && o.nodeId !== node.id && !o.runtime)
              return (
                <Form.Item
                  label="结果另存为新变量"
                  style={{ marginBottom: 12 }}
                  validateStatus={bad ? 'error' : undefined}
                  help={bad ? `变量「${out}」已存在，不能覆盖已有变量，请换一个名字` : '留空则结果覆盖原变量；填写则写入这个新变量，原变量不变'}
                >
                  <Input
                    value={data.outputVar}
                    onChange={(e) => patch({ outputVar: e.target.value })}
                    placeholder="可选，如 处理结果；不能与已有变量同名"
                    maxLength={40}
                  />
                </Form.Item>
              )
            })()}
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              代码在主进程沙箱里执行：旧值用 <code>value</code> 取，别的变量用 <code>vars.变量名</code> 取；
              <code>return</code> 的结果（对象/数组/数字/文本都行）默认作为该变量的新值，深层路径（如 接口数据.data.list）会写回原位置；
              配了「结果另存为新变量」时结果写入新变量、原变量保持不变。可用 JSON / Math / Date 等，<code>console.log</code> 会打进运行日志；支持 async/await，超过 5 秒按超时失败。
            </Text>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <Form.Item label="左值" required style={{ marginBottom: 12 }}>
              <VariableInput
                value={data.left}
                onChange={(v) => patch({ left: v })}
                options={variableOptions}
                placeholder="下拉选变量（自动带 {{}}），或输入固定值"
              />
            </Form.Item>
            <Form.Item label="比较方式" style={{ marginBottom: 12 }}>
              <Select
                value={data.op || 'eq'}
                options={CONDITION_OPS}
                onChange={(v) => patch({ op: v })}
                style={{ width: 180 }}
              />
            </Form.Item>
            {!isUnaryOp(data.op) && (
              <Form.Item label="右值" required style={{ marginBottom: 12 }}>
                <VariableInput
                  value={data.right}
                  onChange={(v) => patch({ right: v })}
                  options={variableOptions}
                  placeholder="下拉选变量（自动带 {{}}），或输入文本/数字/[]（空数组）等字面量"
                />
              </Form.Item>
            )}
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              双方都是数字时按数值比较，否则按文本比较；数组/对象按 JSON 文本比较——右值不必选现存变量，
              可直接填固定值：文本、数字、<code>[]</code>（空数组）、<code>["a","b"]</code> 这类 JSON 写法都行
              （如「{'{{提取结果}}'} 等于 []」判断提取是否为空）；「为空/不为空」对空数组、空对象同样成立。
              从节点右侧「是」「否」两个连接点分别连线到后续模块，走哪条由判断结果决定，未连接的分支到那里结束。
            </Text>
          </>
        )}

        {node.type === 'tableEdit' && (
          <>
            <Form.Item label="列名" required style={{ marginBottom: 12 }}>
              <Input
                value={data.column}
                onChange={(e) => patch({ column: e.target.value })}
                placeholder="如 等级；不存在会自动创建"
                maxLength={40}
              />
            </Form.Item>
            <Form.Item label="值" style={{ marginBottom: 12 }}>
              <VariableInput
                value={data.value}
                onChange={(v) => patch({ value: v })}
                options={variableOptions}
                placeholder="下拉选变量（自动带 {{}}），或输入固定文本"
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              写入一列数据：有这一列就覆盖，没有就新建再赋值。自动建表并起一行（直线流程里连续的
              表格编辑写同一行，「数据循环」每换一项新起一行），控制台「表格」页实时可见，
              流程末尾的「表格导出」模块可直接导出。
            </Text>
          </>
        )}

        {node.type === 'exportTable' && (
          <>
            <Form.Item label="保存地址" required style={{ marginBottom: 12 }}>
              <Space.Compact block>
                <Input
                  value={data.savePath}
                  onChange={(e) => patch({ savePath: e.target.value })}
                  placeholder="文件夹路径，如 ~/Desktop/爬虫结果"
                  maxLength={300}
                />
                <Button icon={<FolderOpenOutlined />} onClick={pickSaveDir}>
                  选择
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item label="文件名" style={{ marginBottom: 12 }}>
              <Input
                value={data.baseName}
                onChange={(e) => patch({ baseName: e.target.value })}
                placeholder="留空使用项目名"
                maxLength={40}
              />
            </Form.Item>
            <Form.Item label="格式" style={{ marginBottom: 12 }}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={data.format || 'csv'}
                onChange={(e) => patch({ format: e.target.value })}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              整个流程跑完后导出一次完整表格到上面的保存地址（目录不存在会自动创建，支持 ~ 指代用户目录，
              文件名自动带时间戳）。放在循环里也只会导出一次。此为必填项，未填写时无法运行。
            </Text>
          </>
        )}
      </Form>
    </Drawer>
  )
}
