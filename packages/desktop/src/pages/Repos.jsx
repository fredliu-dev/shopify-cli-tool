import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CodeOutlined,
  DashboardOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FormatPainterOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import {
  App,
  Alert,
  AutoComplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'

const { Title, Text, Link: ALink } = Typography
const { TextArea } = Input

const isTemplateJson = (p) => /(^|\/)templates?\//i.test(p) && /\.json$/i.test(p)
const templatesOf = (repo) => (repo?.changedFiles || []).filter(isTemplateJson)

// 卡片网格：自适应列宽，不再独占整行
const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))',
  gap: 12,
  alignItems: 'start',
}

// 区块小标题：左侧色点 + 加粗小字，作为视觉锚点（区别于普通辅助文案）
function SectionLabel({ color = '#1677ff', children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
      <Text strong style={{ fontSize: 12 }}>
        {children}
      </Text>
    </div>
  )
}

// 毛玻璃卡片（iOS 风格）：半透明背景 + 背景模糊 + 高光描边；
// 需配合 App.jsx Content 的彩色光晕背景，blur 才能透出色彩。
const GLASS = {
  background: 'rgba(255,255,255,0.055)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.1)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}

/* ---------------- 初始化 Modal（shop init 可视化，针对某仓库目录） ---------------- */
function InitRepoModal({ open, repo, onClose, onDone }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) window.api.config.templates().then(setTemplates)
  }, [open])

  const submit = async (vals) => {
    setLoading(true)
    const res = repo.hasToml
      ? await window.api.config.initMerge({ dir: repo.path, templateName: vals.template })
      : await window.api.config.initCreate({
          dir: repo.path,
          templateName: vals.template,
          theme: vals.theme,
          port: vals.port,
          previewKey: vals.previewKey,
          projectDesc: vals.projectDesc,
        })
    setLoading(false)
    if (res.ok) {
      message.success(repo.hasToml ? '已合并 dev 环境到现有配置' : '已创建 shopify.theme.toml')
      onDone?.()
    } else {
      message.error(res.error || '初始化失败')
    }
  }

  return (
    <Modal title={`初始化配置 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item name="template" label="模板" rules={[{ required: true, message: '请选择模板' }]}>
          <Select options={templates.map((t) => ({ value: t.name, label: t.name }))} placeholder="选择模板" />
        </Form.Item>
        {!repo?.hasToml && (
          <>
            <Form.Item name="theme" label="theme">
              <Input placeholder="主题 id（可留空，本地保存时再复制 live）" />
            </Form.Item>
            <Form.Item name="port" label="port" rules={[{ pattern: /^\d+$/, message: '需为数字' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="previewKey" label="preview_key（新页面需填）">
              <Input />
            </Form.Item>
            <Form.Item name="projectDesc" label="project_desc（选填）">
              <Input />
            </Form.Item>
          </>
        )}
        <Button type="primary" htmlType="submit" loading={loading}>
          {repo?.hasToml ? '合并 dev 环境' : '创建配置'}
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 本地保存 Modal（shop add 可视化，含复制线上 live 主题） ---------------- */
function SaveRepoModal({ open, repo, onClose, onDone, contacts }) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  // store 反查模板：undefined=加载中，null=反查不到需手选，字符串=已确定（直接用反查值）
  const [resolvedTpl, setResolvedTpl] = useState(undefined)
  const [tplOptions, setTplOptions] = useState([])
  const [copyForm] = Form.useForm()
  const [copyLoading, setCopyLoading] = useState(false)

  const dev = repo?.devEnv || {}

  useEffect(() => {
    if (open) {
      // dev 来自仓库 shopify.theme.toml 的 [environments.dev]（getRepoStatus 实时读取），
      // 配置里已有的值一律回填，避免用户重复输入；theme 留空时仍可点「复制线上 live 主题」覆盖。
      form.setFieldsValue({
        port: dev.port != null ? String(dev.port) : '',
        theme: dev.theme != null ? String(dev.theme) : '',
        preview_key: dev.preview_key ?? '',
        project_desc: dev.project_desc ?? '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  // 打开时按 store 反查模板：查到则自动用（不显示选择），查不到则拉模板列表让用户选
  useEffect(() => {
    if (!open || !dev.store) return
    setResolvedTpl(undefined)
    Promise.all([window.api.repos.resolveTemplate(dev.store), window.api.repos.templates()]).then(
      ([r1, r2]) => {
        setResolvedTpl(r1.ok ? r1.data : null)
        setTplOptions(r2.ok ? r2.data : [])
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dev.store])

  const doCopyLive = async (vals) => {
    setCopyLoading(true)
    const res = await window.api.repos.copyLive({
      dir: repo.path,
      envName: 'dev',
      envConfig: dev,
      activity: vals.activity,
      owner: vals.owner,
    })
    setCopyLoading(false)
    if (res.ok) {
      form.setFieldValue('theme', res.data.id)
      message.success(`已复制主题：${res.data.name}（${res.data.id}）`)
      setCopyOpen(false)
      copyForm.resetFields()
    } else {
      modal.error({
        title: '复制主题失败',
        content: (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <div style={{ fontWeight: 500 }}>{res.error}</div>
            {res.stderr && (
              <pre
                style={{
                  marginTop: 8,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  background: 'rgba(255,255,255,0.05)',
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                {res.stderr.trim()}
              </pre>
            )}
          </div>
        ),
      })
    }
  }

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.repos.save({
      dir: repo.path,
      envName: 'dev',
      fields: {
        domain: dev.domain,
        port: vals.port,
        theme: vals.theme,
        preview_key: vals.preview_key,
        project_desc: vals.project_desc,
      },
      templateName: resolvedTpl || vals.template || null,
    })
    setLoading(false)
    if (res.ok) {
      message.success(res.data.created ? '已保存为本地项目' : '该配置已存在本地项目（字段一致）')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={`本地保存 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item label="store（项目身份）">
          <Input value={dev.store || ''} disabled />
        </Form.Item>
        <Form.Item label="domain（取自配置，不可改）">
          <Input value={dev.domain || ''} disabled />
        </Form.Item>
        {resolvedTpl === null && (
          <Form.Item
            name="template"
            label="模板（store 未匹配到模板，请选择）"
            rules={[{ required: true, message: '请选择模板' }]}
          >
            <Select options={tplOptions.map((t) => ({ label: t, value: t }))} placeholder="选择模板" />
          </Form.Item>
        )}
        <Form.Item name="port" label="port" rules={[{ required: true, message: '请输入 port' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item label="theme" required>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="theme" noStyle rules={[{ required: true, message: '请输入 theme（或点右侧复制 live 主题）' }]}>
              <Input placeholder="主题 id" />
            </Form.Item>
            <Button onClick={() => setCopyOpen(true)}>复制线上 live 主题</Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="preview_key" label="preview_key">
          <Input />
        </Form.Item>
        <Form.Item name="project_desc" label="project_desc" rules={[{ required: true, message: '请输入 project_desc' }]}>
          <Input />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存为本地项目
        </Button>
      </Form>

      <Modal title="复制线上 live 主题" open={copyOpen} onCancel={() => setCopyOpen(false)} footer={null} destroyOnClose>
        <Form form={copyForm} layout="vertical" onFinish={doCopyLive}>
          <Form.Item name="activity" label="活动名称" rules={[{ required: true, message: '请输入活动名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="owner" label="负责人" rules={[{ required: true, message: '请输入负责人' }]}>
            <AutoComplete
              options={(contacts || []).map((c) => ({ value: c.name }))}
              filterOption={(v, o) => String(o.value).toLowerCase().includes(String(v).toLowerCase())}
              style={{ width: '100%' }}
            >
              <Input placeholder="负责人（可从已录入人员选择或手输）" />
            </AutoComplete>
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            主题名格式：[dev] 活动 | 负责人 | 日期；需该 store 已 shopify login。
          </Text>
          <Button type="primary" htmlType="submit" loading={copyLoading}>
            复制并回填 theme
          </Button>
        </Form>
      </Modal>
    </Modal>
  )
}

/* ---------------- 运行前拉取改动 json 的多选 Modal ---------------- */
function PullModal({ open, files, onClose, onConfirm }) {
  const [selected, setSelected] = useState(files)
  const all = files.length > 0 && selected.length === files.length

  // 每次打开默认全选；用户取消任一文件后「全选」自动取消（标准全选联动）
  useEffect(() => {
    if (open) setSelected(files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onCheckAll = (checked) => setSelected(checked ? [...files] : [])

  return (
    <Modal
      title="拉取当前分支改动的 templates json"
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="skip" onClick={() => onConfirm([])}>
          跳过，仅运行 dev
        </Button>,
        <Button key="ok" type="primary" onClick={() => onConfirm(selected)}>
          拉取并复制启动命令
        </Button>,
      ]}
      destroyOnClose
    >
      <Checkbox checked={all} onChange={(e) => onCheckAll(e.target.checked)} style={{ marginBottom: 8 }}>
        全选
      </Checkbox>
      <Checkbox.Group
        value={selected}
        onChange={(next) => setSelected(next.filter((f) => files.includes(f)))}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {files.map((f) => (
          <Checkbox key={f} value={f}>
            {f}
          </Checkbox>
        ))}
      </Checkbox.Group>
    </Modal>
  )
}

/* ---------------- 查看改动模板 Modal（git 改动过的 templates/*.json 文件名） ---------------- */
function ChangedTemplatesModal({ open, title, files, onClose }) {
  return (
    <Modal title={title ? `Template变动 - ${title}` : 'Template变动'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      {!files || files.length === 0 ? (
        <Text type="secondary">当前分支无改动的 templates json</Text>
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
          {files.map((f) => (
            <div key={f} style={{ whiteSpace: 'nowrap' }}>
              {f}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 设置 Modal：选择默认编辑器 ---------------- */
function SettingsModal({ open, defaultEditor, onClose, onSaved }) {
  const { message } = App.useApp()
  const [editors, setEditors] = useState([])
  const [value, setValue] = useState(defaultEditor)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      window.api.repos.editors().then((res) => {
        if (res.ok) setEditors(res.data || [])
      })
      setValue(defaultEditor)
    }
  }, [open, defaultEditor])

  const save = async () => {
    if (!value) {
      message.warning('请选择一个编辑器')
      return
    }
    setLoading(true)
    const res = await window.api.settings.setEditor(value)
    setLoading(false)
    if (res.ok) {
      message.success('已设为默认编辑器')
      onSaved?.(value)
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title="设置默认编辑器" open={open} onCancel={onClose} footer={null} destroyOnClose>
      {editors.length === 0 ? (
        <Text type="secondary">未检测到本机已装的编辑器（VS Code / Cursor / WebStorm 等）。</Text>
      ) : (
        <Radio.Group value={value} onChange={(e) => setValue(e.target.value)} style={{ display: 'flex', flexDirection: 'column' }}>
          {editors.map((e) => (
            <Radio key={e.id} value={e.id}>
              {e.name}
            </Radio>
          ))}
        </Radio.Group>
      )}
      <div style={{ marginTop: 16 }}>
        <Button type="primary" onClick={save} loading={loading} disabled={!editors.length}>
          保存
        </Button>
      </div>
    </Modal>
  )
}

/* ---------------- 创建项目（从模板 _github 克隆，自动查重） ---------------- */
function CreateProjectModal({ open, workspaceDir, templates, onClose, onDone }) {
  const { message } = App.useApp()
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const cloneable = (templates || []).filter((t) => !t.exists)

  useEffect(() => {
    if (open) setSelected([]) // 默认不勾选，由用户自行挑选要克隆的项目
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templates])

  const submit = async () => {
    if (!selected.length) {
      message.warning('请至少选择一个项目')
      return
    }
    setLoading(true)
    const picks = cloneable.filter((t) => selected.includes(t.name))
    const results = []
    for (const t of picks) {
      const res = await window.api.repos.clone({ workspaceDir, github: t.github })
      results.push({ name: t.repoName, ok: res.ok, error: res.error })
    }
    setLoading(false)
    const failed = results.filter((r) => !r.ok)
    if (!failed.length) message.success(`已克隆 ${results.length} 个项目`)
    else message.error(`${results.length - failed.length} 成功；${failed.length} 失败：${failed.map((f) => `${f.name}(${f.error})`).join('、')}`)
    onDone?.()
  }

  return (
    <Modal
      title="创建项目（从模板 _github 克隆）"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="克隆选中"
      okButtonProps={{ disabled: cloneable.length === 0, loading }}
      destroyOnClose
    >
      {cloneable.length === 0 ? (
        <Text type="secondary">所有模板的仓库都已存在于当前工作区。</Text>
      ) : (
        <Checkbox.Group value={selected} onChange={setSelected} style={{ display: 'flex', flexDirection: 'column' }}>
          {cloneable.map((t) => (
            <Checkbox key={t.name} value={t.name}>
              {t.name} <Text type="secondary" style={{ fontSize: 12 }}>→ {t.repoName}</Text>
            </Checkbox>
          ))}
        </Checkbox.Group>
      )}
    </Modal>
  )
}

/* ---------------- 创建模板（用户自建模板，写入 userDataDir/templates） ---------------- */
function CreateTemplateModal({ open, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.config.createTemplate({
      name: vals.name,
      fields: {
        _github: vals._github,
        _branch: vals._branch,
        project_desc: vals.project_desc,
        domain: vals.domain,
        theme: vals.theme,
        store: vals.store,
        port: vals.port,
        preview_key: vals.preview_key,
      },
    })
    setLoading(false)
    if (res.ok) {
      message.success('模板已创建')
      onDone?.()
    } else {
      message.error(res.error || '创建失败')
    }
  }

  return (
    <Modal title="创建模板" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item
          name="name"
          label="模板名称"
          rules={[
            { required: true, message: '请输入模板名称' },
            { pattern: /^[A-Za-z0-9_-]+$/, message: '仅字母、数字、下划线和中划线（将作为文件名）' },
          ]}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>将作为文件名，新建后在所有「选模板」处可见</Text>}
        >
          <Input placeholder="如 cn、jp" />
        </Form.Item>
        <Form.Item name="_github" label="仓库地址（_github）" rules={[{ required: true, message: '请输入仓库地址' }]} extra={<Text type="secondary" style={{ fontSize: 12 }}>用于「创建项目」时克隆</Text>}>
          <Input placeholder="git@github.com:org/repo.git" />
        </Form.Item>
        <Form.Item name="_branch" label="分支（_branch）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="domain" label="域名（domain）" rules={[{ required: true, message: '请输入域名' }]}>
          <Input placeholder="https://xxx.com" />
        </Form.Item>
        <Form.Item name="store" label="店铺（store）" rules={[{ required: true, message: '请输入店铺' }]}>
          <Input placeholder="xxx.myshopify.com" />
        </Form.Item>
        <Form.Item name="theme" label="主题 id（theme）">
          <Input placeholder="选填，留空则本地保存时再复制 live" />
        </Form.Item>
        <Form.Item name="port" label="端口（port）" rules={[{ required: true, message: '请输入端口' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="preview_key" label="预览密钥（preview_key）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="project_desc" label="项目描述（project_desc）">
          <Input placeholder="选填" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          创建模板
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 编辑模板（仅自建模板；name 不可改，字段预填） ---------------- */
function EditTemplateModal({ open, template, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  // 打开时拉取该模板的 dev 字段预填（含 _github/_branch 等只读元数据）
  useEffect(() => {
    if (!open || !template?.name) return
    ;(async () => {
      const res = await window.api.config.templateEnv(template.name)
      if (res.ok && res.data) {
        const e = res.data
        form.setFieldsValue({
          _github: e._github ?? '',
          _branch: e._branch ?? '',
          project_desc: e.project_desc ?? '',
          domain: e.domain ?? '',
          theme: e.theme != null ? String(e.theme) : '',
          store: e.store ?? '',
          port: e.port != null ? String(e.port) : '',
          preview_key: e.preview_key ?? '',
        })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.config.updateTemplate({
      name: template.name,
      fields: {
        _github: vals._github,
        _branch: vals._branch,
        project_desc: vals.project_desc,
        domain: vals.domain,
        theme: vals.theme,
        store: vals.store,
        port: vals.port,
        preview_key: vals.preview_key,
      },
    })
    setLoading(false)
    if (res.ok) {
      message.success('模板已更新')
      onDone?.()
    } else {
      message.error(res.error || '更新失败')
    }
  }

  return (
    <Modal title={`编辑模板 - ${template?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ port: '9292' }}>
        <Form.Item label="模板名称" extra={<Text type="secondary" style={{ fontSize: 12 }}>name 不可改，需改名请删除后重建</Text>}>
          <Input value={template?.name ?? ''} disabled />
        </Form.Item>
        <Form.Item name="_github" label="仓库地址（_github）" rules={[{ required: true, message: '请输入仓库地址' }]} extra={<Text type="secondary" style={{ fontSize: 12 }}>用于「创建项目」时克隆</Text>}>
          <Input placeholder="git@github.com:org/repo.git" />
        </Form.Item>
        <Form.Item name="_branch" label="分支（_branch）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="domain" label="域名（domain）" rules={[{ required: true, message: '请输入域名' }]}>
          <Input placeholder="https://xxx.com" />
        </Form.Item>
        <Form.Item name="store" label="店铺（store）" rules={[{ required: true, message: '请输入店铺' }]}>
          <Input placeholder="xxx.myshopify.com" />
        </Form.Item>
        <Form.Item name="theme" label="主题 id（theme）">
          <Input placeholder="选填，留空则本地保存时再复制 live" />
        </Form.Item>
        <Form.Item name="port" label="端口（port）" rules={[{ required: true, message: '请输入端口' }, { pattern: /^\d+$/, message: '需为数字' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="preview_key" label="预览密钥（preview_key）">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="project_desc" label="项目描述（project_desc）">
          <Input placeholder="选填" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 模板管理（列出全部；仅自建可编辑/删除，内置锁定） ---------------- */
function ManageTemplatesModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null) // { name }
  const [createOpen, setCreateOpen] = useState(false)

  // config:templates 返回原始数组（非 { ok, data }，与 InitRepoModal 用法一致）
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.config.templates()
      setTemplates(Array.isArray(list) ? list : [])
    } catch (err) {
      message.error(err?.message || '加载模板失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (name) => {
    const res = await window.api.config.deleteTemplate(name)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.() // 通知父组件刷新「创建项目」徽标等
    } else {
      message.error(res.error || '删除失败')
    }
  }

  // 内置模板：编辑/删除禁用并附 Tooltip；自建模板：可编辑可删除
  const renderActions = (t) => {
    if (!t.user) {
      return (
        <Tooltip title="内置模板不可修改/删除">
          <span>
            <Button size="small" disabled>
              编辑
            </Button>
            <Button size="small" danger disabled style={{ marginLeft: 6 }}>
              删除
            </Button>
          </span>
        </Tooltip>
      )
    }
    return (
      <Space size={6}>
        <Button size="small" onClick={() => setEditTarget({ name: t.name })}>
          编辑
        </Button>
        <Popconfirm title={`删除模板「${t.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(t.name)}>
          <Button size="small" danger>
            删除
          </Button>
        </Popconfirm>
      </Space>
    )
  }

  const columns = [
    { title: '模板名', dataIndex: 'name', key: 'name' },
    {
      title: '类型',
      dataIndex: 'user',
      key: 'user',
      width: 90,
      render: (user) => (user ? <Tag color="blue">自建</Tag> : <Tag>内置</Tag>),
    },
    { title: '操作', key: 'action', width: 170, render: (_, t) => renderActions(t) },
  ]

  return (
    <Modal title="模板管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={620}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建模板
        </Button>
      </div>
      <Table size="small" rowKey="name" loading={loading} columns={columns} dataSource={templates} pagination={false} />

      {/* 编辑自建模板（嵌套） */}
      <EditTemplateModal
        open={!!editTarget}
        template={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />

      {/* 新建模板（嵌套） */}
      <CreateTemplateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 人员管理（姓名+手机号，存本地 contacts.json） ---------------- */
function ContactEditModal({ open, contact, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: contact?.name ?? '', phone: contact?.phone ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.contacts.upsert({ id: contact?.id, name: vals.name, phone: vals.phone })
    setLoading(false)
    if (res.ok) {
      message.success(contact?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={contact?.id ? '编辑人员' : '新增人员'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
          <Input placeholder="用于主题命名「负责人」与提测 @ 选择" />
        </Form.Item>
        <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '需为 11 位手机号（1 开头，钉钉 @ 用）' }]}>
          <Input placeholder="提测时用于 @ 该负责人（须为该成员钉钉绑定的手机号）" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function ContactsModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null) // { id?, name?, phone? }；{} 为新增

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.contacts.ls()
      setContacts(res.ok ? res.data || [] : [])
    } catch (err) {
      message.error(err?.message || '加载人员失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.contacts.remove(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.() // 通知父组件刷新负责人下拉数据源
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const columns = [
    { title: '姓名', dataIndex: 'name', key: 'name' },
    { title: '手机号', dataIndex: 'phone', key: 'phone' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_, c) => (
        <Space size={6}>
          <Button size="small" onClick={() => setEditTarget(c)}>
            编辑
          </Button>
          <Popconfirm title={`删除「${c.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(c.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="人员管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={560}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增人员
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={contacts} pagination={false} />
      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
        姓名用于主题命名「负责人」下拉；手机号用于提测消息 @ 该负责人。
      </Text>

      <ContactEditModal
        open={!!editTarget}
        contact={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 通知群管理（钉钉群机器人：name/webhook/secret） ---------------- */
function GroupEditModal({ open, group, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: group?.name ?? '', webhook: group?.webhook ?? '', secret: group?.secret ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.dingtalk.upsertGroup({ id: group?.id, ...vals })
    setLoading(false)
    if (res.ok) {
      message.success(group?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={group?.id ? '编辑通知群' : '新增通知群'} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="群名称" rules={[{ required: true, message: '请输入群名称' }]}>
          <Input placeholder="如 测试通知群" />
        </Form.Item>
        <Form.Item name="webhook" label="webhook" rules={[{ required: true, message: '请输入 webhook 地址' }]}>
          <Input placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </Form.Item>
        <Form.Item name="secret" label="加签 secret（选填）" tooltip="机器人安全设置选「加签」时填，否则留空">
          <Input placeholder="SEC..." />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function GroupsModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.dingtalk.load()
      setGroups(res.ok ? res.data?.groups || [] : [])
    } catch (err) {
      message.error(err?.message || '加载通知群失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.dingtalk.removeGroup(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const columns = [
    { title: '群名称', dataIndex: 'name', key: 'name' },
    {
      title: 'webhook',
      dataIndex: 'webhook',
      key: 'webhook',
      ellipsis: true,
      render: (w) => <Text style={{ fontSize: 12 }}>{w}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_, g) => (
        <Space size={6}>
          <Button size="small" onClick={() => setEditTarget(g)}>
            编辑
          </Button>
          <Popconfirm title={`删除群「${g.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(g.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="通知群管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={640}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增通知群
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={groups} pagination={false} />
      <GroupEditModal
        open={!!editTarget}
        group={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 信息模板管理（钉钉消息模板：name/content，含占位符） ---------------- */
function TemplateEditModal({ open, template, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ name: template?.name ?? '', content: template?.content ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])

  const submit = async (vals) => {
    setLoading(true)
    // 仅写 name/content；core 透传保留模板已有的 defaults（CLI gotest 占位符默认值）
    const res = await window.api.dingtalk.upsertTemplate({ id: template?.id, name: vals.name, content: vals.content })
    setLoading(false)
    if (res.ok) {
      message.success(template?.id ? '已更新' : '已添加')
      onDone?.()
    } else {
      message.error(res.error || '保存失败')
    }
  }

  return (
    <Modal title={template?.id ? '编辑信息模板' : '新增信息模板'} open={open} onCancel={onClose} footer={null} destroyOnClose width={600}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '请输入模板名称' }]}>
          <Input placeholder="如 默认提测通知" />
        </Form.Item>
        <Form.Item
          name="content"
          label="消息内容"
          rules={[{ required: true, message: '请输入消息内容' }]}
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              占位符：<Text code>{'{{@person as 姓名}}'}</Text> <Text code>{'{{@url}}'}</Text> <Text code>{'{{@title}}'}</Text> <Text code>{'{{@content as 备注}}'}</Text> <Text code>{'{{@all}}'}</Text>；多行直接换行。
            </Text>
          }
        >
          <TextArea rows={6} placeholder={'【提测通知】\n{{@title}} 已就绪，预览：{{@url}}\n负责人 {{@person as 姓名}}'} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

function DingtalkTemplatesModal({ open, onClose, onChange }) {
  const { message } = App.useApp()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.dingtalk.load()
      setTemplates(res.ok ? res.data?.templates || [] : [])
    } catch (err) {
      message.error(err?.message || '加载模板失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleDelete = async (id) => {
    const res = await window.api.dingtalk.removeTemplate(id)
    if (res.ok) {
      message.success('已删除')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '删除失败')
    }
  }

  const handleClearDefaults = async (id) => {
    const res = await window.api.dingtalk.saveDefaults({ templateId: id, defaults: {} })
    if (res.ok) {
      message.success('已清除默认值')
      refresh()
      onChange?.()
    } else {
      message.error(res.error || '清除失败')
    }
  }

  const columns = [
    { title: '模板名称', dataIndex: 'name', key: 'name' },
    {
      title: '内容预览',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (c) => <Text style={{ fontSize: 12 }}>{(c || '').replace(/\n/g, ' ')}</Text>,
    },
    {
      title: '默认负责人',
      key: 'defaults',
      ellipsis: true,
      render: (_, t) => {
        const d = t.defaults
        if (!d || !Object.keys(d).length) return <Text type="secondary">—</Text>
        return <Text style={{ fontSize: 12 }}>{Object.values(d).join('，')}</Text>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, t) => (
        <Space size={6} wrap>
          <Button size="small" onClick={() => setEditTarget(t)}>
            编辑
          </Button>
          {t.defaults && Object.keys(t.defaults).length > 0 && (
            <Popconfirm title="清除该模板的默认负责人？" okText="清除" cancelText="取消" onConfirm={() => handleClearDefaults(t.id)}>
              <Button size="small">清默认</Button>
            </Popconfirm>
          )}
          <Popconfirm title={`删除模板「${t.name}」？`} okText="删除" cancelText="取消" onConfirm={() => handleDelete(t.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Modal title="信息模板管理" open={open} onCancel={onClose} footer={null} destroyOnClose width={640}>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setEditTarget({})}>
          新增模板
        </Button>
      </div>
      <Table size="small" rowKey="id" loading={loading} columns={columns} dataSource={templates} pagination={false} />
      <TemplateEditModal
        open={!!editTarget}
        template={editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          setEditTarget(null)
          refresh()
          onChange?.()
        }}
      />
    </Modal>
  )
}

/* ---------------- 提测通知（参考 shop gotest：选群+模板，预填项目链接/描述后发钉钉） ---------------- */
function GotestModal({ open, project, projects, contacts, onClose }) {
  const { message, modal } = App.useApp()
  const [groups, setGroups] = useState([])
  const [templates, setTemplates] = useState([])
  const [groupId, setGroupId] = useState()
  const [templateId, setTemplateId] = useState()
  const [fields, setFields] = useState([]) // parsePlaceholders 返回的字段列表
  const [values, setValues] = useState({}) // token -> 值（person 存手机号）
  const [parsing, setParsing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selProject, setSelProject] = useState(project) // 当前选中的本地项目（默认=入口传入的仓库项目，可切换）

  // 打开时加载群+模板，重置选择
  useEffect(() => {
    if (!open) return
    ;(async () => {
      const res = await window.api.dingtalk.load()
      if (res.ok) {
        setGroups(res.data?.groups || [])
        setTemplates(res.data?.templates || [])
      }
      setGroupId(undefined)
      setTemplateId(undefined)
      setFields([])
      setValues({})
      setSelProject(project)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])

  // 按占位符类型，用项目信息预填 url（提测链接）/ title（描述）；person/content 不在此处理
  const applyProject = (p, fs) => {
    const next = {}
    ;(fs || []).forEach((f) => {
      if (f.kind === 'url') next[f.token] = p?.links?.previewLink || ''
      else if (f.kind === 'title') next[f.token] = p?.description || ''
    })
    return next
  }

  // 兼容 CLI「手机号（姓名）」存法：拆出纯手机号；并按手机号从 contacts 反查展示名
  const splitPhone = (raw) => {
    const m = String(raw).match(/^(.+?)\s*[（(](.+?)[）)]\s*$/)
    return m ? { phone: m[1].trim(), display: m[2].trim() } : { phone: String(raw).trim(), display: String(raw).trim() }
  }
  const phoneDisplay = (phone) => {
    const c = (contacts || []).find((x) => x.phone === phone)
    return c ? `${c.name}（${phone}）` : phone
  }

  // 选完模板：解析占位符并按字段类型预填；有 person 默认值则询问是否使用（与 CLI gotest 一致）
  const onTemplateChange = async (id) => {
    setTemplateId(id)
    if (!id) {
      setFields([])
      return
    }
    setParsing(true)
    const res = await window.api.dingtalk.parsePlaceholders(id)
    setParsing(false)
    if (!res.ok) {
      message.error(res.error || '解析模板失败')
      return
    }
    const fs = res.data?.fields || []
    setFields(fs)
    setValues(applyProject(selProject, fs))
    // 默认值仅 person：模板存了 @person 默认值时，询问是否使用并展示
    const defaults = templates.find((t) => t.id === id)?.defaults || {}
    const personFields = fs.filter((f) => f.kind === 'person' && defaults[f.token])
    if (personFields.length) {
      const preview = personFields.map((f) => `${f.label}：${phoneDisplay(splitPhone(defaults[f.token]).phone)}`).join('\n')
      modal.confirm({
        title: '检测到默认负责人，是否使用？',
        content: <Text style={{ whiteSpace: 'pre-wrap' }}>{preview}</Text>,
        okText: '使用默认',
        cancelText: '不用',
        onOk: () =>
          setValues((s) => {
            const next = { ...s }
            personFields.forEach((f) => (next[f.token] = splitPhone(defaults[f.token]).phone))
            return next
          }),
      })
    }
  }

  const submit = async () => {
    if (!groupId) {
      message.warning('请选择通知群')
      return
    }
    if (!templateId) {
      message.warning('请选择消息模板')
      return
    }
    // person 必填（手机号）
    const missing = fields.find((f) => f.kind === 'person' && !values[f.token])
    if (missing) {
      message.warning(`请为「${missing.label}」选择人员`)
      return
    }
    // person 手机号须为 11 位：钉钉只 @ 群成员的真实手机号，错号/少位会发得出消息却 @ 不到人
    const badPhone = fields.find((f) => f.kind === 'person' && !/^1\d{10}$/.test(values[f.token]))
    if (badPhone) {
      message.warning(`「${badPhone.label}」的手机号 ${values[badPhone.token]} 不是 11 位，钉钉无法 @ 到人，请先在「人员管理」修正`)
      return
    }
    setLoading(true)
    const res = await window.api.dingtalk.gotest({ groupId, templateId, values })
    setLoading(false)
    if (res.ok) {
      const g = groups.find((x) => x.id === groupId)
      message.success(`已发送到「${g?.name || '群'}」`)
      // 发送成功后询问是否把本次 person 存为默认值（与 CLI gotest 一致）
      const picked = {}
      fields.filter((f) => f.kind === 'person' && values[f.token]).forEach((f) => (picked[f.token] = values[f.token]))
      if (Object.keys(picked).length) {
        const preview = Object.entries(picked)
          .map(([tok, ph]) => `${fields.find((f) => f.token === tok)?.label || tok}：${phoneDisplay(ph)}`)
          .join('\n')
        modal.confirm({
          title: '是否将本次负责人保存为默认值？',
          content: <Text style={{ whiteSpace: 'pre-wrap' }}>{preview}</Text>,
          okText: '保存',
          cancelText: '不保存',
          onOk: async () => {
            const r = await window.api.dingtalk.saveDefaults({ templateId, defaults: picked })
            if (r.ok) message.success('已保存为默认值')
            else message.error(r.error || '保存失败')
          },
        })
      }
      onClose?.()
    } else {
      message.error({ content: `发送失败：${res.error}`, duration: 8 })
    }
  }

  const noGroups = groups.length === 0
  const noTemplates = templates.length === 0

  return (
    <Modal
      title={`提测通知 - ${selProject?.description || selProject?.store || ''}`}
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="发送"
      okButtonProps={{ loading, disabled: !groupId || !templateId }}
      destroyOnClose
      width={560}
    >
      <Form layout="vertical">
        <Form.Item label="本地项目" required>
          <Select
            showSearch
            placeholder="选择本地项目"
            value={selProject?.id}
            onChange={(id) => {
              const p = (projects || []).find((x) => x.id === id)
              setSelProject(p)
              // 模板已选时，切换项目重填 url/title；person/content 保持不动
              if (fields.length) setValues((s) => ({ ...s, ...applyProject(p, fields) }))
            }}
            options={(projects || []).map((p) => ({ value: p.id, label: p.description || p.store }))}
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="通知群" required>
          <Select
            placeholder={noGroups ? '请先在「通知群管理」添加群' : '选择通知群'}
            value={groupId}
            onChange={setGroupId}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            disabled={noGroups}
          />
        </Form.Item>
        <Form.Item label="消息模板" required>
          <Select
            placeholder={noTemplates ? '请先在「信息模板管理」添加模板' : '选择消息模板'}
            value={templateId}
            onChange={onTemplateChange}
            options={templates.map((t) => ({ value: t.id, label: t.name }))}
            disabled={noTemplates}
            loading={parsing}
          />
        </Form.Item>
        {fields.map((f) => (
          <Form.Item key={f.token} label={f.label} required={f.kind === 'person'}>
            {f.kind === 'person' ? (
              <Select
                showSearch
                placeholder="选择人员（按其手机号 @）"
                value={values[f.token]}
                onChange={(v) => setValues((s) => ({ ...s, [f.token]: v }))}
                options={(contacts || []).map((c) => ({ value: c.phone, label: `${c.name}（${c.phone}）` }))}
                optionFilterProp="label"
              />
            ) : f.kind === 'content' ? (
              <TextArea
                rows={2}
                placeholder="输入文本内容"
                value={values[f.token] || ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.token]: e.target.value }))}
              />
            ) : (
              <Input
                value={values[f.token] || ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.token]: e.target.value }))}
              />
            )}
          </Form.Item>
        ))}
        {(noGroups || noTemplates) && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            提示：需先在顶部「更多」里配置{noGroups ? '通知群' : ''}
            {noGroups && noTemplates ? '、' : ''}
            {noTemplates ? '信息模板' : ''}。
          </Text>
        )}
      </Form>
    </Modal>
  )
}

/* ---------------- 拉取分支（新功能/紧急热修复/缺陷修复） ---------------- */
const BRANCH_TYPES = [
  { value: 'feature', label: '新功能' },
  { value: 'hotfix', label: '紧急热修复' },
  { value: 'fix', label: '缺陷修复' },
]

/**
 * 仓库分支实时获取：与仓库卡片外的分支下拉框逻辑完全一致。
 * 调 repos.remoteBranches（内部会 git fetch origin），拿到本地分支 + 远程分支
 * （远程去掉与本地同名的）。reload 既用于弹窗打开时加载，也用于下拉展开时刷新；
 * 它返回本次 fetch 的快照（含 current），供调用方在加载完成那一刻回填表单值——
 * 因为 state 的更新要等下一次渲染，effect 内拿不到最新列表。
 */
function useRepoBranches(repo) {
  const [local, setLocal] = useState([])
  const [remote, setRemote] = useState([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!repo?.path) return null
    setLoading(true)
    const res = await window.api.repos.remoteBranches(repo.path)
    setLoading(false)
    if (!res.ok) return null
    const { current, local: l = [], remote: r = [] } = res.data || {}
    // 远程分支保持齐全（不去除本地已有的同名分支）：基准分支常需选 origin/master 等，
    // 去重会让本地已有的 master 在远程组消失。
    setLocal(l)
    setRemote(r)
    return { current: current || null, local: l, remote: r }
  }, [repo])

  return { local, remote, loading, reload }
}

function CreateBranchModal({ open, repo, onClose, onDone, contacts }) {
  const { message } = App.useApp()
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const type = Form.useWatch('type', form)
  const person = Form.useWatch('person', form)
  const reqno = Form.useWatch('reqno', form)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ type: 'feature', person: '', reqno: '' })
    // 首次加载把基准分支默认填为当前分支；下拉展开刷新时不改已选值
    reload().then((snap) => snap?.current && form.setFieldValue('base', snap.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  const branchName = type && person && reqno ? `dev/${type}-${person}-${reqno}` : ''

  const submit = async (vals) => {
    setLoading(true)
    // push=true：后端先校验远程是否已存在该分支（存在则拒绝创建并提示），再创建本地分支并推到远程
    const res = await window.api.repos.createBranch({ dir: repo.path, base: vals.base, name: branchName, push: true })
    setLoading(false)
    if (res.ok) {
      message.success(`已创建并切换到分支 ${branchName}（已推送远程）`)
      onDone?.()
    } else {
      message.error(res.error || '创建失败')
    }
  }

  return (
    <Modal title={`拉取分支 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ type: 'feature' }}>
        <Form.Item name="base" label="基准分支" rules={[{ required: true, message: '请选择基准分支' }]}>
          <Select
            showSearch
            loading={branchLoading}
            placeholder="选择基准分支（展开自动 fetch origin）"
            popupMatchSelectWidth={false}
            onDropdownVisibleChange={(o) => o && reload()}
          >
            {local.length > 0 && (
              <Select.OptGroup label="本地分支">
                {local.map((b) => (
                  <Select.Option key={`l/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
            {remote.length > 0 && (
              <Select.OptGroup label="远程分支">
                {remote.map((b) => (
                  <Select.Option key={`r/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
          </Select>
        </Form.Item>
        <Form.Item name="type" label="类型" rules={[{ required: true }]}>
          <Radio.Group>
            {BRANCH_TYPES.map((t) => (
              <Radio key={t.value} value={t.value}>
                {t.label}
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        <Form.Item name="person" label="负责人" rules={[{ required: true, message: '请选择负责人' }]}>
          <AutoComplete
            options={(contacts || []).map((c) => ({ value: c.name }))}
            filterOption={(v, o) => String(o.value).toLowerCase().includes(String(v).toLowerCase())}
            style={{ width: '100%' }}
          >
            <Input placeholder="从人员配置选择或手输（用于分支命名）" />
          </AutoComplete>
        </Form.Item>
        <Form.Item name="reqno" label="需求编号" rules={[{ required: true, message: '请输入需求编号' }]}>
          <Input placeholder="如 1024" />
        </Form.Item>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          分支名预览：<Text code>{branchName || 'dev/{type}-{负责人}-{编号}'}</Text>
        </Text>
        <Button type="primary" htmlType="submit" loading={loading}>
          创建分支
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 创建 release（release/version-{英文版本名}，可选 shop copy） ---------------- */
function CreateReleaseModal({ open, repo, onClose, onDone, contacts }) {
  const { message, modal } = App.useApp()
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const version = Form.useWatch('version', form)
  const copyTheme = Form.useWatch('copyTheme', form)
  const canCopy = !!repo?.devEnv // 复制主题需要 dev 环境配置（store）

  const branchName = version ? `release/version-${version}` : ''

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ version: '', copyTheme: false, activity: '', owner: '' })
    reload().then((snap) => snap?.current && form.setFieldValue('base', snap.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  const submit = async (vals) => {
    setLoading(true)
    // 1) 可选：先复制主题（shop copy，主题名前缀 [release]）；失败则中止，不创建分支
    if (vals.copyTheme && canCopy) {
      const cr = await window.api.repos.copyLive({
        dir: repo.path,
        envName: 'dev', // 仍用 dev 环境取 store
        envConfig: repo.devEnv,
        activity: vals.activity,
        owner: vals.owner,
        namePrefix: 'release', // 主题名前缀用 release
      })
      if (!cr.ok) {
        setLoading(false)
        // 像「本地保存」一样弹详细框：显示 shopify 的 stderr，便于判断是没登录 / store 错 / 其它
        modal.error({
          title: '复制主题失败',
          content: (
            <div style={{ maxHeight: 280, overflow: 'auto' }}>
              <div style={{ fontWeight: 500 }}>{cr.error}</div>
              {cr.stderr && (
                <pre
                  style={{
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    background: 'rgba(255,255,255,0.05)',
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  {cr.stderr.trim()}
                </pre>
              )}
            </div>
          ),
        })
        return // 主题没复制成功就不创建分支
      }
      // 2) 再创建 release 分支
      const res = await window.api.repos.createBranch({ dir: repo.path, base: vals.base, name: branchName, push: true })
      setLoading(false)
      if (res.ok) {
        message.success(`已复制主题：${cr.data.name}（${cr.data.id}）；已创建并切换到 ${branchName}（已推送远程）`)
        onDone?.()
      } else {
        message.error(`主题已复制（${cr.data.name}），但创建分支失败：${res.error}`)
      }
      return
    }
    // 未勾选复制主题：直接创建分支（同样推送到远程，与勾选复制主题的路径一致）
    const res = await window.api.repos.createBranch({ dir: repo.path, base: vals.base, name: branchName, push: true })
    setLoading(false)
    if (res.ok) {
      message.success(`已创建并切换到分支 ${branchName}（已推送远程）`)
      onDone?.()
    } else {
      message.error(res.error || '创建分支失败')
    }
  }

  return (
    <Modal title={`创建 release - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ copyTheme: false }}>
        <Form.Item name="base" label="基准分支" rules={[{ required: true, message: '请选择基准分支' }]}>
          <Select
            showSearch
            loading={branchLoading}
            placeholder="选择基准分支（展开自动 fetch origin）"
            popupMatchSelectWidth={false}
            onDropdownVisibleChange={(o) => o && reload()}
          >
            {local.length > 0 && (
              <Select.OptGroup label="本地分支">
                {local.map((b) => (
                  <Select.Option key={`l/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
            {remote.length > 0 && (
              <Select.OptGroup label="远程分支">
                {remote.map((b) => (
                  <Select.Option key={`r/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
          </Select>
        </Form.Item>
        <Form.Item
          name="version"
          label="版本名（英文）"
          rules={[
            { required: true, message: '请输入版本名' },
            { pattern: /^[A-Za-z0-9._-]+$/, message: '仅限英文 / 数字 / . _ -' },
          ]}
        >
          <Input placeholder="如 2024spring" />
        </Form.Item>
        <Form.Item
          name="copyTheme"
          valuePropName="checked"
          tooltip={canCopy ? '复制 live 主题为草稿，主题名前缀 [release]' : '需先初始化 dev 环境配置'}
        >
          <Checkbox disabled={!canCopy}>同时复制一份主题（shop copy，[release] 前缀）</Checkbox>
        </Form.Item>
        {copyTheme && canCopy && (
          <>
            <Form.Item name="activity" label="活动名称" rules={[{ required: true, message: '请输入活动名称' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="owner" label="负责人" rules={[{ required: true, message: '请输入负责人' }]}>
              <AutoComplete
                options={(contacts || []).map((c) => ({ value: c.name }))}
                filterOption={(v, o) => String(o.value).toLowerCase().includes(String(v).toLowerCase())}
                style={{ width: '100%' }}
              >
                <Input placeholder="负责人（可从已录入人员选择或手输）" />
              </AutoComplete>
            </Form.Item>
            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              主题名格式：[release] 活动 | 负责人 | 日期；需该 store 已 shopify login。
            </Text>
          </>
        )}
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          分支名预览：<Text code>{branchName || 'release/version-{版本名}'}</Text>
        </Text>
        <Button type="primary" htmlType="submit" loading={loading}>
          创建 release
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 合并：开发分支(_branch) → release，先合主分支解冲突 ---------------- */
function MergeModal({ open, repo, onClose, onDone }) {
  const { message } = App.useApp()
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)
  const [dirty, setDirty] = useState([])
  const [branchesLoaded, setBranchesLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const source = repo?.devEnv?._branch || ''
  // release/* 分支：本地 + 远程合并（远程已去重），统一作为可选目标
  const releaseBranches = [
    ...local.filter((b) => b.startsWith('release/')),
    ...remote.filter((b) => b.startsWith('release/')),
  ]
  const blocked = dirty.length > 0 || releaseBranches.length === 0 || !source

  useEffect(() => {
    if (!open || !repo?.path) return
    ;(async () => {
      const snap = await reload()
      setBranchesLoaded(true) // 分支查询完成：之后才允许显示「暂无 release 分支」
      const wt = await window.api.repos.workingTree({ dir: repo.path })
      setDirty(wt.ok ? wt.data || [] : [])
      if (snap) {
        // 用本次 fetch 快照（而非 state）算默认值，避免拿到旧列表
        const rel = [...snap.local, ...snap.remote].filter((b) => b.startsWith('release/'))
        const mainGuess =
          snap.local.find((b) => b === 'main' || b === 'master') ||
          snap.remote.find((b) => b === 'main' || b === 'master')
        form.setFieldsValue({
          target: snap.current?.startsWith('release/') ? snap.current : rel[0],
          main: mainGuess,
        })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.repos.merge({ dir: repo.path, source, target: vals.target, main: vals.main })
    setLoading(false)
    if (res.ok) {
      message.success('合并成功')
      onDone?.()
    } else {
      message.error({
        content: `合并失败${res.error || ''}`,
        duration: 8,
      })
    }
  }

  return (
    <Modal title={`合并 - ${repo?.name ?? ''}`} open={open} onCancel={onClose} footer={null} destroyOnClose width={520}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item label="开发分支（源，取自 _branch）">
          <Input value={source || '（未配置 _branch）'} disabled />
        </Form.Item>
        {dirty.length > 0 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message="工作区有未提交文件，无法合并"
            description={
              <div style={{ maxHeight: 160, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
                {dirty.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            }
          />
        )}
        {dirty.length === 0 && !branchesLoaded && (
          <Alert type="info" showIcon style={{ marginBottom: 16 }} message="正在查询 release 分支，请稍候…" />
        )}
        {dirty.length === 0 && branchesLoaded && releaseBranches.length === 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="该仓库暂无 release/version-* 分支，请先「创建 release」" />
        )}
        <Form.Item name="target" label="目标 release 分支（合并到此）" rules={[{ required: true }]}>
          <Select
            showSearch
            loading={branchLoading}
            placeholder="选择 release 分支"
            disabled={blocked}
            popupMatchSelectWidth={false}
            onDropdownVisibleChange={(o) => o && reload()}
          >
            {local.filter((b) => b.startsWith('release/')).length > 0 && (
              <Select.OptGroup label="本地分支">
                {local
                  .filter((b) => b.startsWith('release/'))
                  .map((b) => (
                    <Select.Option key={`l/${b}`} value={b}>
                      {b}
                    </Select.Option>
                  ))}
              </Select.OptGroup>
            )}
            {remote.filter((b) => b.startsWith('release/')).length > 0 && (
              <Select.OptGroup label="远程分支">
                {remote
                  .filter((b) => b.startsWith('release/'))
                  .map((b) => (
                    <Select.Option key={`r/${b}`} value={b}>
                      {b}
                    </Select.Option>
                  ))}
              </Select.OptGroup>
            )}
          </Select>
        </Form.Item>
        <Form.Item name="main" label="主分支（先合并进来解冲突）" rules={[{ required: true }]}>
          <Select
            showSearch
            loading={branchLoading}
            placeholder="选择主分支"
            disabled={blocked}
            popupMatchSelectWidth={false}
            onDropdownVisibleChange={(o) => o && reload()}
          >
            {local.length > 0 && (
              <Select.OptGroup label="本地分支">
                {local.map((b) => (
                  <Select.Option key={`l/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
            {remote.length > 0 && (
              <Select.OptGroup label="远程分支">
                {remote.map((b) => (
                  <Select.Option key={`r/${b}`} value={b}>
                    {b}
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
          </Select>
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} disabled={blocked}>
          开始合并
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- Git 流程：阶段式流程卡（开发→提测→release） ---------------- */
// 三段彩色卡片用箭头串联：①开发·拉分支 → ②开发完·提测 → ③提测完·release（创建+合并）。
// 禁用态沿用原逻辑：提测需先有本地项目；合并需 [environments.dev]._branch。
function FlowArrow() {
  return <ArrowRightOutlined style={{ fontSize: 12, color: '#c9cdd4', flexShrink: 0, alignSelf: 'center' }} />
}

function StageCard({ index, color, Icon, stageName, title, disabled, tooltip, onClick, footer }) {
  const [hover, setHover] = useState(false)
  const interactive = !!onClick && !disabled
  const border = disabled ? 'rgba(255,255,255,0.12)' : hover && interactive ? color : `${color}66`
  const card = (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${border}`,
        background: interactive && hover ? `${color}33` : disabled ? 'rgba(255,255,255,0.04)' : `${color}22`,
        opacity: disabled ? 0.55 : 1,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color .2s, background .2s',
      }}
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={interactive ? onClick : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 9,
            background: disabled ? '#d9d9d9' : color,
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {index}
        </span>
        <Icon style={{ color: disabled ? '#bfbfbf' : color, fontSize: 14, flexShrink: 0 }} />
        <Text strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </Text>
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginLeft: 24 }}>
        {stageName}
      </Text>
      {footer}
    </div>
  )
  return tooltip ? <Tooltip title={tooltip}>{card}</Tooltip> : card
}

function GitFlowSteps({ repo, project, onAction }) {
  const hasProject = !!project
  const hasBranch = !!repo?.devEnv?._branch

  // 第三阶段：创建 release + 合并（两个按钮置于卡内 footer；创建 release 用绿色描边作主操作）
  const releaseFooter = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      <Button size="small" style={{ borderColor: 'rgba(82,196,26,0.45)', color: '#95de64', background: 'rgba(82,196,26,0.1)' }} onClick={() => onAction('release', repo)}>
        创建 release
      </Button>
      <Tooltip title={!hasBranch ? '请先在 [environments.dev] 补 _branch' : '把 _branch 合并进 release'}>
        <Button size="small" disabled={!hasBranch} onClick={() => onAction('merge', repo)}>
          合并
        </Button>
      </Tooltip>
    </div>
  )

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
      <StageCard
        index={1}
        color="#1677ff"
        Icon={BranchesOutlined}
        title="拉取分支"
        stageName="开发"
        onClick={() => onAction('branch', repo)}
      />
      <FlowArrow />
      <StageCard
        index={2}
        color="#fa8c16"
        Icon={ExperimentOutlined}
        title="提测"
        stageName="开发完"
        disabled={!hasProject}
        tooltip={!hasProject ? '先本地保存为项目' : '发钉钉提测通知'}
        onClick={() => onAction('gotest', project)}
      />
      <FlowArrow />
      <StageCard index={3} color="#52c41a" Icon={RocketOutlined} title="release" stageName="提测完" footer={releaseFooter} />
    </div>
  )
}

/* ---------------- 仓库卡片（已配对项目则内嵌项目面板，圈在一起） ---------------- */
function RepoCard({ repo, projects, onAction, onProjectAction, branchProjectCounts }) {
  const matched = !!repo.matched

  // 下拉展开时实时获取分支（不缓存）：每次 reload 直连 listAllBranches，其 local/remote 均已
  // 去重；不再用仓库列表里那份可能过时/带重复的 repo.branches 缓存来渲染下拉。
  const { local, remote, loading: branchLoading, reload } = useRepoBranches(repo)

  // 分组下拉数据：本地 / 远程，每个分支附该分支绑定的本地项目数（n>0 才显蓝标）。
  // 用 options + optionRender：optionRender 仅负责下拉项外观，value/label 始终是纯分支名，
  // 选中框由 labelRender 显示纯分支名，checkout 拿到的 value 不受任何影响。
  // 本地分支再 Set 去重一次（防御）；远程组保留全部——本地已有同名的，远程组也照常显示。
  const localBranches = [...new Set(local || [])]
  const branchOptions = []
  if (localBranches.length) {
    branchOptions.push({
      label: '本地分支',
      options: localBranches.map((b) => ({ value: b, label: b, count: branchProjectCounts?.[b] || 0 })),
    })
  }
  if ((remote || []).length) {
    branchOptions.push({
      label: '远程分支',
      options: (remote || []).map((b) => ({ value: b, label: b, count: branchProjectCounts?.[b] || 0 })),
    })
  }

  const saveBtn = matched ? (
    <Tooltip title="该配置已在本地缓存项目中，无需重复添加">
      <Button size="small" disabled>
        本地保存
      </Button>
    </Tooltip>
  ) : (
    <Button size="small" type="primary" disabled={!repo.devEnv} onClick={() => onAction('save', repo)}>
      本地保存
    </Button>
  )

  return (
    <Card
      size="small"
      style={{ ...GLASS, borderRadius: 16 }}
      title={
        <Space size={6} style={{ alignItems: 'baseline' }}>
          <Text strong>{repo.name}</Text>
          <Text style={{ fontSize: 12, color: '#69b1ff' }}>{repo.branchCount} 分支</Text>
        </Space>
      }
      extra={
        <Select
          size="small"
          showSearch
          loading={branchLoading}
          value={repo.currentBranch || undefined}
          placeholder="切换分支"
          style={{ minWidth: 160, maxWidth: 260 }}
          popupMatchSelectWidth={false}
          options={branchOptions}
          optionFilterProp="label"
          onDropdownVisibleChange={(open) => open && reload()}
          onChange={(b) => onAction('checkout', { repo, branch: b })}
          optionRender={(option) => {
            // rc-select 把 option 扁平化为 { data, label, value, ... }：自定义字段在 option.data，
            // label/value 被提到顶层。所以 count 取 option.data.count，label 用 option.label。
            const count = option?.data?.count ?? 0
            return (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                {count > 0 && (
                  <span
                    title={`${count} 个本地项目`}
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      lineHeight: '16px',
                      height: 16,
                      minWidth: 16,
                      padding: '0 5px',
                      borderRadius: 8,
                      background: 'rgba(22,119,255,0.22)',
                      color: '#69b1ff',
                      textAlign: 'center',
                    }}
                  >
                    {count}
                  </span>
                )}
              </div>
            )
          }}
          labelRender={(props) => props.value ?? props.label}
        />
      }
    >
      <Tooltip title={repo.path}>
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.45)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: 12,
          }}
        >
          {repo.path}
        </div>
      </Tooltip>

      {/* 配置操作 */}
      <div style={{ marginBottom: 14 }}>
        <SectionLabel color="#1677ff">配置操作</SectionLabel>
        <Space wrap size={[6, 6]}>
          {!repo.hasToml ? (
            <Button size="small" type="primary" onClick={() => onAction('init', repo)}>
              初始化
            </Button>
          ) : (
            <>
              {saveBtn}
              <Tooltip title="已有配置文件，无需初始化">
                <span>
                  <Button size="small" disabled>
                    初始化
                  </Button>
                </span>
              </Tooltip>
            </>
          )}
        </Space>
      </div>

      {/* Git 流程：开发→拉分支 / 开发完→提测 / 提测完→release 创建+合并 */}
      <div>
        <SectionLabel color="#52c41a">Git 流程</SectionLabel>
        <GitFlowSteps repo={repo} project={repo.matched} onAction={onAction} />
      </div>

      {/* 关联的本地项目：同 store 的多条都内嵌展示 */}
      {projects.map((p) => (
        <ProjectPanel key={p.id} project={p} onAction={onProjectAction} embedded />
      ))}
    </Card>
  )
}

/* ---------------- 编辑本地项目（仅 非 _ 开头的字段；store 变动自动重算模板） ---------------- */
const EDIT_LABELS = {
  description: '项目描述',
  store: 'store',
  domain: 'domain',
  theme: 'theme',
  previewKey: 'preview_key',
  port: 'port',
}
const EDIT_ORDER = ['description', 'store', 'domain', 'theme', 'previewKey', 'port']
// 排除：以 _ 开头的只读字段（如 _branch）、id（主键）、派生/注入字段
const EDIT_SKIP = new Set(['id', 'envName', 'templateName', 'links', 'repoPath', 'changedTemplates'])
// 纯展示字段：store/domain 为项目身份标识，不可编辑（不绑定 name，提交时不传）
const EDIT_READONLY = new Set(['store', 'domain'])

function EditProjectModal({ open, project, onClose, onDone }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const editableKeys = (Object.keys(project || {}) || [])
    .filter((k) => !k.startsWith('_') && !EDIT_SKIP.has(k))
    .sort((a, b) => {
      const ia = EDIT_ORDER.indexOf(a)
      const ib = EDIT_ORDER.indexOf(b)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return a.localeCompare(b)
    })

  useEffect(() => {
    if (open && project) {
      const vals = {}
      editableKeys.forEach((k) => {
        vals[k] = project[k] != null ? String(project[k]) : ''
      })
      form.setFieldsValue(vals)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])

  const submit = async (vals) => {
    setLoading(true)
    const res = await window.api.shops.update(project.id, vals)
    setLoading(false)
    if (res.ok) {
      message.success('已更新')
      onDone?.()
    } else {
      message.error(res.error || '更新失败')
    }
  }

  return (
    <Modal
      title={`编辑项目 - ${project?.description || project?.store || ''}`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        {editableKeys.map((k) =>
          EDIT_READONLY.has(k) ? (
            <Form.Item key={k} label={EDIT_LABELS[k] || k}>
              <Input value={project?.[k] != null ? String(project[k]) : ''} disabled />
            </Form.Item>
          ) : (
            <Form.Item
              key={k}
              name={k}
              label={EDIT_LABELS[k] || k}
              rules={k === 'port' ? [{ pattern: /^\d*$/, message: '需为数字' }] : undefined}
            >
              <Input />
            </Form.Item>
          ),
        )}
        <Button type="primary" htmlType="submit" loading={loading}>
          保存
        </Button>
      </Form>
    </Modal>
  )
}

/* ---------------- 配置信息块：两列 key-value，value 可点击复制 ---------------- */
const INFO_BLOCK = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '6px 16px',
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.05)',
  borderRadius: 6,
  marginBottom: 10,
}

function InfoField({ label, value, copyable }) {
  const { message } = App.useApp()
  const empty = value == null || value === ''
  const interactive = copyable && !empty
  // 用 block 级 flex（而非 Space 的 inline-flex）：grid 窄列里 inline-flex + minWidth:0 会
  // 塌缩到约一个字符宽，导致标签逐字换行、长值竖排堆叠。这里 label 锁死不缩不换行，
  // value 占满剩余宽度并在溢出时省略，保证两列布局在任何列宽下都稳定。
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        cursor: interactive ? 'pointer' : 'default',
      }}
      title={interactive ? '点击复制' : undefined}
      onClick={
        interactive
          ? async () => {
              const res = await window.api.shell.copy(value)
              if (res?.ok) message.success(`${label} 已复制`)
            }
          : undefined
      }
    >
      <Text type="secondary" style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 12,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {empty ? '-' : String(value)}
      </Text>
    </div>
  )
}

/* ---------------- 本地项目面板（仓库卡内嵌=圈起来；独立分区=无外框卡） ---------------- */
function ProjectPanel({ project, onAction, embedded }) {
  const { message } = App.useApp()
  const noRepo = !project.repoPath

  // 链接：复制到剪贴板 + 用系统默认浏览器打开
  const openLink = async (url, label) => {
    if (!url) return
    const res = await window.api.shell.copy(url)
    await window.api.shell.openExternal(url)
    if (res?.ok) message.success(`已复制${label}并在默认浏览器打开`)
  }

  const wrapperStyle = embedded
    ? { marginTop: 12, padding: 12, borderRadius: 12, background: 'rgba(22,119,255,0.08)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(22,119,255,0.25)' }
    : { padding: 16, borderRadius: 14, ...GLASS }

  const title = project.description || project.templateName || project.store || '-'

  return (
    <div style={wrapperStyle}>
      {/* 标题：项目名 + 模板 + 仓库状态（长标题自动省略） */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
        <Text strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </Text>
        {project.templateName && (
          <Tag style={{ marginInlineEnd: 0, flexShrink: 0 }}>{project.templateName}</Tag>
        )}
        {noRepo && (
          <Text type="warning" style={{ fontSize: 12, flexShrink: 0 }}>
            （未找到仓库）
          </Text>
        )}
      </div>

      {/* 配置信息：store / theme / port / preview_key；theme、preview_key 点击复制 */}
      <div style={INFO_BLOCK}>
        <InfoField label="store" value={project.store} />
        <InfoField label="theme" value={project.theme} copyable />
        <InfoField label="port" value={project.port} />
        <InfoField label="preview_key" value={project.previewKey} copyable />
      </div>

      {/* 快捷链接：点击复制并用默认浏览器打开 */}
      <Space size={16} style={{ marginBottom: 10 }}>
        <ALink style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => openLink(project.links?.devLink, '开发链接')}>
          <CodeOutlined style={{ marginRight: 4 }} />
          开发
        </ALink>
        <ALink style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => openLink(project.links?.previewLink, '提测链接')}>
          <EyeOutlined style={{ marginRight: 4 }} />
          提测
        </ALink>
        <ALink style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => openLink(project.links?.adminLink, '后台链接')}>
          <DashboardOutlined style={{ marginRight: 4 }} />
          后台
        </ALink>
        <ALink style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => openLink(project.links?.editorLink, '编辑器链接')}>
          <FormatPainterOutlined style={{ marginRight: 4 }} />
          编辑器
        </ALink>
      </Space>

      {/* 操作：左侧主操作（运行 / 改动模板），右侧管理操作（编辑 / 删除） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Space size={6}>
          <Tooltip title={noRepo ? '未找到对应仓库' : '打开编辑器并复制启动命令到剪贴板'}>
            <Button type="primary" size="small" disabled={noRepo} onClick={() => onAction('run', project)}>
              运行
            </Button>
          </Tooltip>
          <Badge count={project.changedTemplates?.length || 0} size="small" offset={[-2, 0]} color={project.changedTemplates?.length ? '#faad14' : undefined}>
            <Button size="small" onClick={() => onAction('templates', { title, files: project.changedTemplates || [] })}>
              Template变动
            </Button>
          </Badge>
          {!embedded && (
            <Tooltip title="发钉钉提测通知">
              <Button size="small" onClick={() => onAction('gotest', project)}>
                提测通知
              </Button>
            </Tooltip>
          )}
        </Space>
        <Space size={6}>
          <Button size="small" onClick={() => onAction('edit', project)}>
            编辑
          </Button>
          <Popconfirm title="删除该本地项目？" okText="删除" cancelText="取消" onConfirm={() => onAction('delete', project)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>
    </div>
  )
}

/* ---------------- 关于：客户端 / shopify CLI / git 等版本 ---------------- */
function AboutModal({ open, onClose }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    if (open) window.api.system.versions().then(setInfo)
  }, [open])
  const rows = [
    ['客户端', info?.app],
    ['shopify CLI', info?.shopify],
    ['git', info?.git],
    ['Electron', info?.electron],
    ['Node', info?.node],
  ]
  return (
    <Modal title="关于 Shopify 工具箱" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Descriptions column={1} size="small" bordered>
        {rows.map(([k, v]) => (
          <Descriptions.Item key={k} label={k}>
            <Text style={{ fontFamily: 'monospace' }}>{v || '—'}</Text>
          </Descriptions.Item>
        ))}
      </Descriptions>
      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
        shopify CLI 即客户端实际调用的 @shopify/cli；git 为本机系统版本。
      </Text>
    </Modal>
  )
}

/* ---------------- 页面主体 ---------------- */
export default function Repos() {
  const { message } = App.useApp()
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [repos, setRepos] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [defaultEditor, setDefaultEditor] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [contacts, setContacts] = useState([])
  const [contactsOpen, setContactsOpen] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [gotestFor, setGotestFor] = useState(null) // 提测目标 project

  const [pullFor, setPullFor] = useState(null) // { repoPath, files }：运行前的模板多选（执行方式）
  const [tplModal, setTplModal] = useState(null) // { title, files }
  const [editRepo, setEditRepo] = useState(null) // { mode:'init'|'save', repo }
  const [cloneable, setCloneable] = useState([]) // 模板 _github 项目 + 是否已存在（供「创建项目」查重）
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [manageTemplatesOpen, setManageTemplatesOpen] = useState(false)
  const [gitModal, setGitModal] = useState(null) // { mode:'branch'|'release'|'merge', repo }
  const [editProject, setEditProject] = useState(null) // 编辑本地项目

  // 刷新「创建项目」可选模板（带 _github 且未在工作区存在的）
  const refreshCloneable = useCallback(async (dir) => {
    const target = dir || workspaceDir
    if (!target) return
    const res = await window.api.repos.cloneableTemplates(target)
    if (res.ok) setCloneable(res.data || [])
  }, [workspaceDir])

  const scan = useCallback(
    async (dir) => {
      if (!dir) return
      setScanning(true)
      const res = await window.api.repos.scan(dir)
      setScanning(false)
      if (res.ok) {
        setRepos(res.data || [])
        // 同步刷新「创建项目」可选模板（带 _github 且未在工作区存在的）
        window.api.repos.cloneableTemplates(dir).then((r) => {
          if (r.ok) setCloneable(r.data || [])
        })
      } else {
        message.error(res.error || '扫描失败')
        setRepos([])
      }
    },
    [message],
  )

  const refreshProjects = useCallback(async () => {
    const res = await window.api.shops.ls()
    if (res.ok) setProjects(res.data || [])
  }, [])

  const refreshContacts = useCallback(async () => {
    const res = await window.api.contacts.ls()
    if (res.ok) setContacts(res.data || [])
  }, [])

  useEffect(() => {
    ;(async () => {
      const s = await window.api.settings.get()
      setWorkspaceDir(s?.workspaceDir || '')
      setDefaultEditor(s?.defaultEditor || '')
      setLoading(false)
      if (s?.workspaceDir) {
        await scan(s.workspaceDir)
        await refreshProjects()
      }
      refreshContacts()
    })()
  }, [scan, refreshProjects, refreshContacts])

  // 文件监听：配置/templates 变动后主进程推送的最新仓库数据，替换到列表里
  useEffect(() => {
    const off = window.api.repos.onUpdated(({ repo }) => {
      if (!repo?.path) return
      setRepos((prev) => prev.map((r) => (r.path === repo.path ? repo : r)))
    })
    return () => off?.()
  }, [])

  // 工作区目录监听：仓库新增/删除后主进程推送完整新列表，整体替换
  useEffect(() => {
    const off = window.api.repos.onReposChanged(({ data }) => {
      if (Array.isArray(data)) setRepos(data)
      refreshCloneable()
    })
    return () => off?.()
  }, [refreshCloneable])

  const pickAndScan = async () => {
    const res = await window.api.dialog.pickDir()
    if (!res.ok) return
    setWorkspaceDir(res.dir)
    const saveRes = await window.api.settings.setWorkspace(res.dir)
    if (!saveRes.ok) message.warning(saveRes.error || '工作区路径保存失败')
    await scan(res.dir)
    await refreshProjects()
  }

  // 打开本地数据目录（projects.json / templates 所在文件夹）到系统文件管理器
  const openLocalConfig = async () => {
    const dirRes = await window.api.config.dataDir()
    if (!dirRes?.ok) {
      message.error(dirRes?.error || '无法定位配置目录')
      return
    }
    const res = await window.api.shell.openPath(dirRes.data)
    if (!res?.ok) message.error(res.error || '打开失败')
  }

  // 一键导出本地配置为 zip（含 README 说明 win/mac 路径与恢复步骤）；用户取消则静默
  const exportConfig = async () => {
    const res = await window.api.config.export()
    if (!res || res.canceled) return
    if (res.ok) message.success(`已导出：${res.path}`)
    else message.error(res.error || '导出失败')
  }

  // init/save 后：刷新该仓库状态 + 刷新本地项目列表
  const refreshRepo = async (repoPath) => {
    const res = await window.api.repos.status(repoPath)
    if (res.ok) setRepos((prev) => prev.map((r) => (r.path === repoPath ? res.data : r)))
    await refreshProjects()
  }

  // 仓库卡片动作分发
  const repoAction = (type, payload) => {
    if (type === 'init') setEditRepo({ mode: 'init', repo: payload })
    else if (type === 'save') setEditRepo({ mode: 'save', repo: payload })
    else if (type === 'templates') setTplModal(payload)
    else if (type === 'checkout') checkoutBranch(payload.repo.path, payload.branch)
    else if (type === 'branch' || type === 'release' || type === 'merge') setGitModal({ mode: type, repo: payload })
    else if (type === 'gotest') setGotestFor(payload)
  }

  // 项目卡片动作分发
  const projectAction = (type, payload) => {
    if (type === 'run') handleRun(payload.repoPath)
    else if (type === 'templates') setTplModal(payload)
    else if (type === 'edit') setEditProject(payload)
    else if (type === 'delete') handleDeleteProject(payload)
    else if (type === 'gotest') setGotestFor(payload)
  }

  // 删除本地缓存项目
  const handleDeleteProject = async (project) => {
    const res = await window.api.shops.delete([project.id])
    if (!res.ok) {
      message.error(res.error || '删除失败')
      return
    }
    message.success('已删除')
    // 删除后须刷新关联仓库的 matched 状态：否则仓库卡「本地保存」仍因旧 matched 被禁用，
    // 要点「重新扫描」才恢复。refreshRepo 内部已含 refreshProjects。
    if (project.repoPath) {
      refreshRepo(project.repoPath)
    } else {
      refreshProjects()
    }
  }

  // 切换仓库分支
  const checkoutBranch = async (repoPath, branch) => {
    const res = await window.api.repos.checkout({ dir: repoPath, branch })
    if (res.ok) message.success(`已切换到 ${branch}`)
    else message.error(res.error || '切换失败')
    refreshRepo(repoPath) // 成功/失败都刷新：成功更新当前分支，失败还原 Select 显示
  }

  // 运行流程：先查改动 json → 有则弹多选拉取 → 选完后打开编辑器并复制启动命令到剪贴板
  const handleRun = async (repoPath) => {
    if (!repoPath) return
    if (!defaultEditor) {
      message.warning('请先选择默认编辑器')
      setSettingsOpen(true)
      return
    }
    const res = await window.api.repos.changedJson({ dir: repoPath })
    if (res.ok && res.data.length) {
      setPullFor({ repoPath, files: res.data }) // 先选执行方式
    } else {
      if (res.ok) message.info('当前分支无改动 templates json')
      await execRun(repoPath, []) // 无改动：直接打开编辑器跑 dev
    }
  }

  // 选完要拉的改动后：打开编辑器到仓库目录，并把启动命令复制到剪贴板（不自动执行）
  const execRun = async (repoPath, pullFiles) => {
    const r = await window.api.repos.runCommand({ dir: repoPath, editorId: defaultEditor, pullFiles })
    if (r.ok) {
      message.success('启动命令已复制，在编辑器终端粘贴运行即可')
    } else {
      message.error(r.error || '执行失败')
    }
  }

  const confirmPull = (files) => {
    const { repoPath } = pullFor || {}
    setPullFor(null)
    if (repoPath) execRun(repoPath, files)
  }

  // 本地项目 ↔ 仓库关联（按 store：同 store 的所有本地项目都归属到 dev.store 一致的仓库，
  // 实现 1:N —— 一个仓库卡展示同 store 的多条项目，而非只展示 matched 那一条）
  const repoByStore = useMemo(() => {
    const m = new Map()
    repos.forEach((r) => {
      if (r.devEnv?.store) m.set(r.devEnv.store, r)
    })
    return m
  }, [repos])

  // 每个 project 注入关联仓库路径 + 改动模板（按 store 关联）
  const enrichedProjects = useMemo(
    () =>
      projects.map((p) => {
        const r = repoByStore.get(p.store)
        return { ...p, repoPath: r?.path, changedTemplates: templatesOf(r) }
      }),
    [projects, repoByStore],
  )

  // 仓库路径 → 关联项目列表（1:N：同 store 且与仓库当前分支一致的项目才展示）。
  // 跟随分支：切到某分支只看该分支保存的项目；历史项目无 _branch 不归属具体分支、不展示。
  const projectsByRepoPath = useMemo(() => {
    const m = new Map()
    const branchByPath = new Map()
    repos.forEach((r) => branchByPath.set(r.path, r.currentBranch))
    enrichedProjects.forEach((p) => {
      if (!p.repoPath) return
      const branch = branchByPath.get(p.repoPath)
      if (branch && p._branch !== branch) return
      if (!m.has(p.repoPath)) m.set(p.repoPath, [])
      m.get(p.repoPath).push(p)
    })
    return m
  }, [enrichedProjects, repos])

  // 各 store 下、每个分支绑定的本地项目数：项目身份 = store + _branch（见 core/shops.js），
  // 故按 store 归属仓库、按 _branch 归属分支；切分支下拉框据此标识"该分支有几个本地项目"。
  const branchProjectCountsByStore = useMemo(() => {
    const byStore = new Map()
    projects.forEach((p) => {
      if (!p.store || !p._branch) return // 历史项目无 _branch，不归属具体分支
      if (!byStore.has(p.store)) byStore.set(p.store, {})
      const o = byStore.get(p.store)
      o[p._branch] = (o[p._branch] || 0) + 1
    })
    return byStore
  }, [projects])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Spin />
      </div>
    )
  }

  if (!workspaceDir) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Card style={{ textAlign: 'center', padding: '24px 48px', ...GLASS, borderRadius: 16 }}>
          <Title level={4} style={{ marginBottom: 8 }}>
            选择工作区文件夹
          </Title>
          <Text type="secondary">选择一个本机文件夹，扫描其下的 Git 仓库</Text>
          <div style={{ marginTop: 20 }}>
            <Button type="primary" size="large" onClick={pickAndScan}>
              选择文件夹
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          padding: '12px 20px',
          ...GLASS,
          borderRadius: 14,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.3)',
        }}
      >
        <div onClick={pickAndScan} style={{ minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderOpenOutlined style={{ color: '#1677ff', fontSize: 18, flexShrink: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 }}>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
              工作区
            </Text>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <Text strong ellipsis={{ tooltip: workspaceDir }} style={{ maxWidth: 340, minWidth: 0 }}>
                {workspaceDir}
              </Text>
              <Text style={{ fontSize: 12, color: '#69b1ff', flexShrink: 0 }}>{repos.length} 个仓库</Text>
            </div>
          </div>
        </div>
        <Space size={8} style={{ flexShrink: 0 }}>
          <Button variant="outlined" icon={<ReloadOutlined />} onClick={() => scan(workspaceDir)} loading={scanning}>
            重新扫描
          </Button>
          <Tooltip title={cloneable.some((t) => !t.exists) ? `可克隆：${cloneable.filter((t) => !t.exists).map((t) => t.name).join('、')}` : '所有模板项目都已存在于工作区'}>
            <span>
              <Button type="primary" icon={<PlusOutlined />} disabled={!cloneable.some((t) => !t.exists)} onClick={() => setCreateProjectOpen(true)}>
                创建项目
              </Button>
            </span>
          </Tooltip>
          <Dropdown
            placement="bottomRight"
            menu={{
              items: [
                { key: 'manageTemplates', icon: <AppstoreOutlined />, label: '模板管理' },
                { key: 'contacts', icon: <TeamOutlined />, label: '人员管理' },
                { key: 'groups', icon: <MessageOutlined />, label: '通知群管理' },
                { key: 'dingtalkTemplates', icon: <FileTextOutlined />, label: '信息模板管理' },
                { key: 'localConfig', icon: <FolderOpenOutlined />, label: '本地配置' },
                { key: 'exportConfig', icon: <DownloadOutlined />, label: '导出配置' },
                { type: 'divider' },
                {
                  key: 'settings',
                  icon: <SettingOutlined />,
                  label: defaultEditor ? `默认编辑器：${defaultEditor}` : '设置默认编辑器',
                },
                { key: 'about', icon: <InfoCircleOutlined />, label: '关于' },
              ],
              onClick: ({ key }) => {
                if (key === 'manageTemplates') setManageTemplatesOpen(true)
                else if (key === 'contacts') setContactsOpen(true)
                else if (key === 'groups') setGroupsOpen(true)
                else if (key === 'dingtalkTemplates') setTemplatesOpen(true)
                else if (key === 'localConfig') openLocalConfig()
                else if (key === 'exportConfig') exportConfig()
                else if (key === 'settings') setSettingsOpen(true)
                else if (key === 'about') setAboutOpen(true)
              },
            }}
          >
            <Button variant="outlined" icon={<MoreOutlined />}>更多</Button>
          </Dropdown>
        </Space>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <Title level={5} style={{ margin: 0 }}>
          Git 仓库（{repos.length}）
        </Title>
        <Text type="secondary" style={{ fontSize: 11 }}>
          已配对本地项目的仓库，项目会内嵌在同一张卡里
        </Text>
      </div>
      {scanning ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip="扫描中…" />
        </div>
      ) : repos.length === 0 ? (
        <Empty description="该工作区下未发现 Git 仓库" style={{ marginBottom: 24 }} />
      ) : (
        <div style={GRID}>
          {repos.map((r) => (
            <RepoCard
              key={r.path}
              repo={r}
              projects={projectsByRepoPath.get(r.path) || []}
              branchProjectCounts={branchProjectCountsByStore.get(r.devEnv?.store) || {}}
              onAction={repoAction}
              onProjectAction={projectAction}
            />
          ))}
        </div>
      )}

      {/* 初始化 / 本地保存 弹窗 */}
      {editRepo?.mode === 'init' && (
        <InitRepoModal
          open
          repo={editRepo.repo}
          onClose={() => setEditRepo(null)}
          onDone={() => {
            const path = editRepo.repo.path
            setEditRepo(null)
            refreshRepo(path)
          }}
        />
      )}
      {editRepo?.mode === 'save' && (
        <SaveRepoModal
          open
          repo={editRepo.repo}
          contacts={contacts}
          onClose={() => setEditRepo(null)}
          onDone={() => {
            const path = editRepo.repo.path
            setEditRepo(null)
            refreshRepo(path)
          }}
        />
      )}

      {/* 运行前拉取多选 */}
      <PullModal
        open={!!pullFor}
        files={pullFor?.files || []}
        onClose={() => setPullFor(null)}
        onConfirm={confirmPull}
      />

      {/* 查看改动模板 */}
      <ChangedTemplatesModal open={!!tplModal} title={tplModal?.title} files={tplModal?.files || []} onClose={() => setTplModal(null)} />

      {/* 设置默认编辑器 */}
      <SettingsModal
        open={settingsOpen}
        defaultEditor={defaultEditor}
        onClose={() => setSettingsOpen(false)}
        onSaved={(id) => {
          setDefaultEditor(id)
          setSettingsOpen(false)
        }}
      />

      {/* 创建项目（克隆模板 _github） */}
      <CreateProjectModal
        open={createProjectOpen}
        workspaceDir={workspaceDir}
        templates={cloneable}
        onClose={() => setCreateProjectOpen(false)}
        onDone={() => {
          setCreateProjectOpen(false)
          refreshCloneable()
        }}
      />

      {/* 模板管理（编辑/删除仅限自建模板，内置锁定） */}
      <ManageTemplatesModal
        open={manageTemplatesOpen}
        onClose={() => setManageTemplatesOpen(false)}
        onChange={refreshCloneable}
      />

      {/* 人员管理（姓名+手机号；负责人下拉与提测 @ 手机号的数据源） */}
      <ContactsModal open={contactsOpen} onClose={() => setContactsOpen(false)} onChange={refreshContacts} />

      {/* 通知群管理（钉钉群机器人） */}
      <GroupsModal open={groupsOpen} onClose={() => setGroupsOpen(false)} />

      {/* 信息模板管理（钉钉消息模板，含占位符） */}
      <DingtalkTemplatesModal open={templatesOpen} onClose={() => setTemplatesOpen(false)} />

      {/* 提测通知（选群+模板，自动预填项目提测链接/描述后发钉钉） */}
      {/* 提测通知（选群+模板，自动预填项目提测链接/描述后发钉钉）
          下拉只列「当前仓库·当前分支」下的项目（复用 projectsByRepoPath 的过滤口径），不展示其它仓库/分支的项目 */}
      <GotestModal
        open={!!gotestFor}
        project={gotestFor}
        projects={gotestFor ? (projectsByRepoPath.get(gotestFor.repoPath) || [gotestFor]) : []}
        contacts={contacts}
        onClose={() => setGotestFor(null)}
      />

      {/* 编辑本地项目（仅 非 _ 开头字段） */}
      <EditProjectModal
        open={!!editProject}
        project={editProject}
        onClose={() => setEditProject(null)}
        onDone={() => {
          setEditProject(null)
          refreshProjects()
        }}
      />

      {/* 关于：版本信息 */}
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* 拉取分支 / 创建 release / 合并 */}
      {gitModal?.mode === 'branch' && (
        <CreateBranchModal
          open
          contacts={contacts}
          repo={gitModal.repo}
          onClose={() => setGitModal(null)}
          onDone={() => {
            const path = gitModal.repo.path
            setGitModal(null)
            refreshRepo(path)
          }}
        />
      )}
      {gitModal?.mode === 'release' && (
        <CreateReleaseModal
          open
          repo={gitModal.repo}
          contacts={contacts}
          onClose={() => setGitModal(null)}
          onDone={() => {
            const path = gitModal.repo.path
            setGitModal(null)
            refreshRepo(path)
          }}
        />
      )}
      {gitModal?.mode === 'merge' && (
        <MergeModal
          open
          repo={gitModal.repo}
          onClose={() => setGitModal(null)}
          onDone={() => {
            const path = gitModal.repo.path
            setGitModal(null)
            refreshRepo(path)
          }}
        />
      )}
    </>
  )
}
