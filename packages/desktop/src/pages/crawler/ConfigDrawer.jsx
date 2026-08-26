// 右侧配置抽屉：按模块类型渲染表单，onChange 实时写回 node.data（受控，无确定按钮）。
// extract 的多字段编辑：字段卡片列表，可增删；每字段 = 名称 + 选择器 + 提取方式（text/href/attr）。
import React from 'react'
import { App, Button, Drawer, Form, Input, InputNumber, Popconfirm, Radio, Select, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import SelectorInput from './SelectorInput.jsx'
import { CONDITION_OPS, MODULES, isUnaryOp } from './constants.js'

const { Text } = Typography

const EXTRACT_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'href', label: '链接' },
  { value: 'attr', label: '属性' },
]

function FieldCard({ field, index, onChange, onRemove }) {
  const patch = (fields) => onChange(index, { ...field, ...fields })
  const patchSelector = (s) => patch({ selector: s })
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        marginBottom: 10,
      }}
    >
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
      <SelectorInput value={field.selector} onChange={patchSelector} timeoutLabel="查找超时" />
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

export default function ConfigDrawer({ node, open, onClose, onDataPatch }) {
  const { message } = App.useApp()
  if (!node) return null
  const meta = MODULES[node.type]
  const Icon = meta.icon
  const data = node.data || {}
  const patch = (fields) => onDataPatch(node.id, fields)

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
          <span style={{ color: meta.color, display: 'flex' }}>
            <Icon />
          </span>
          配置「{meta.name}」模块
        </Space>
      }
      placement="right"
      width={460}
      open={open}
      onClose={onClose}
      styles={{ body: { paddingTop: 12 } }}
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
            <Form.Item label="网址 URL" required style={{ marginBottom: 14 }}>
              <Input
                value={data.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://example.com/list"
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12 }}>
              流程从「网页」节点开始，打开网址后依次执行后续模块。
            </Text>
          </>
        )}

        {node.type === 'wait' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              等页面里出现该元素后才继续执行后面的模块（常用于等列表渲染完成）。
            </Text>
          </>
        )}

        {node.type === 'click' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              点击后如发生页面跳转会自动等加载完成；超时时间兼作点击后等待跳转的上限。
            </Text>
          </>
        )}

        {node.type === 'input' && (
          <>
            <SelectorInput value={data.selector} onChange={(s) => patch({ selector: s })} />
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
              <FieldCard key={i} field={f} index={i} onChange={patchField} onRemove={removeField} />
            ))}
            <Button type="dashed" block icon={<PlusOutlined />} onClick={addField}>
              添加字段
            </Button>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12, lineHeight: 1.7 }}>
              每个字段独立匹配所有命中元素：同一字段命中 N 个元素即产出 N 行；行数按各字段命中数的最大值对齐，缺失留空。
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
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  marginBottom: 12,
                }}
              >
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
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              运行时重新读取文件内容（选完后文件更新也能拿到最新数据）。每一行数据依次执行后续模块，
              列名可直接作为变量在后续模块里用 {'{{列名}}'} 引用。
            </Text>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <Form.Item label="左值" required style={{ marginBottom: 12 }}>
              <Input
                value={data.left}
                onChange={(e) => patch({ left: e.target.value })}
                placeholder="变量如 {{价格}}，或固定值"
                maxLength={200}
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
                <Input
                  value={data.right}
                  onChange={(e) => patch({ right: e.target.value })}
                  placeholder="变量 {{列名}}，或数字/文本"
                  maxLength={200}
                />
              </Form.Item>
            )}
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              双方都是数字时按数值比较，否则按文本比较。从节点右侧「是」「否」两个连接点分别连线到
              后续模块，走哪条由判断结果决定，未连接的分支到那里结束。
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
              <Input
                value={data.value}
                onChange={(e) => patch({ value: e.target.value })}
                placeholder="支持 {{变量}}，如 {{价格}}（提取字段 / 表格列）"
                maxLength={200}
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              在「导入表格」循环内对当前行赋值：有这一列就覆盖，没有就新建再赋值。
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
