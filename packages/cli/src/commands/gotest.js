import { select, input } from '@inquirer/prompts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import ora from 'ora'
import {
  loadDingtalkConfig,
  saveDingtalkConfig,
  getDingtalkFile,
  sendText,
  loadProjects,
  buildLinks,
  parsePlaceholders,
  fillTemplate,
  setDingtalkTemplateDefaults,
} from '@shopify-cli-tool/core'

// 列表末尾的「新增」哨兵值（用字符串避免与真实对象冲突）
const NEW_GROUP = '__new_group__'
const NEW_TEMPLATE = '__new_template__'

const VALIDATE = {
  phone: (v) =>
    /^\+?[\d\- ]{6,}(\s*[（(][^）)]*[）)]\s*)?$/.test(v.trim()) ? true : '请输入有效手机号（可附 （姓名））',
  http: (v) => (/^https?:\/\//.test(v.trim()) ? true : '需为 http(s) 链接'),
  nonempty: (v) => (v.trim() ? true : '不能为空'),
}

/**
 * 录入一个新通知群（name / webhook / secret 全必填）。
 * @param {object} log
 * @returns {Promise<{ id: string, name: string, webhook: string, secret: string } | null>}
 */
async function promptNewGroup(log) {
  try {
    const name = await input({
      message: '群名称：',
      validate: VALIDATE.nonempty,
    })
    const webhook = await input({
      message: 'webhook 地址：',
      validate: VALIDATE.http,
    })
    const secret = await input({
      message: '加签 secret：',
      validate: VALIDATE.nonempty,
    })
    return { id: randomUUID(), name: name.trim(), webhook: webhook.trim(), secret: secret.trim() }
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return null
    }
    throw err
  }
}

/**
 * 录入一个新发布模板（name + content 必填，content 支持字面 \n 转换为换行）。
 * @param {object} log
 * @returns {Promise<{ id: string, name: string, content: string } | null>}
 */
async function promptNewTemplate(log) {
  try {
    const name = await input({
      message: '模板名称：',
      validate: VALIDATE.nonempty,
    })
    const content = await input({
      message: '模板内容（{{@person as 姓名}} {{@url as 链接}} {{@title as 标题}} {{@content as 备注}} {{@all}}；多行用 \\n）：',
      validate: VALIDATE.nonempty,
    })
    return { id: randomUUID(), name: name.trim(), content: content.replace(/\\n/g, '\n') }
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return null
    }
    throw err
  }
}

/**
 * 二选一交互：用列表选「是/否」（而非输入）。
 * 取消（Ctrl+C）时打印「已取消」并返回 null。
 * @param {object} log
 * @param {string} message
 * @param {boolean} [defaultValue=true] 光标默认停在哪一项
 * @returns {Promise<boolean | null>}
 */
async function yesNo(log, message, defaultValue = true) {
  try {
    return await select({
      message,
      default: defaultValue,
      choices: [
        { name: '是', value: true },
        { name: '否', value: false },
      ],
    })
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return null
    }
    throw err
  }
}

/** 按占位符类型交互输入一个值（提示用 label 展示）。 */
function askValue(it) {
  if (it.type === 'person') {
    return input({ message: `${it.label} 的钉钉手机号：`, validate: VALIDATE.phone }).then((v) => v.trim())
  }
  if (it.type === 'url') {
    return input({ message: `${it.label} 的链接：`, validate: VALIDATE.http }).then((v) => v.trim())
  }
  if (it.type === 'content') {
    // 备注为可选：允许留空（直接回车跳过）
    return input({ message: `${it.label}（可选，回车跳过）：` }).then((v) => v.trim())
  }
  return input({ message: `${it.label} 内容：`, validate: VALIDATE.nonempty }).then((v) => v.trim())
}

/**
 * 从「手机号（姓名）」里拆出手机号和展示名；括号支持中文（）或英文 ()。
 * 无括号时手机号与展示名都为原值。
 *   展示用 display（优先括号内姓名），@ 替换/atMobiles 用 phone。
 * @param {string} raw
 * @returns {{ phone: string, display: string }}
 */
function splitPhoneDefault(raw) {
  const m = String(raw).match(/^(.+?)\s*[（(](.+?)[）)]\s*$/)
  if (!m) return { phone: String(raw).trim(), display: String(raw).trim() }
  return { phone: m[1].trim(), display: m[2].trim() }
}

/**
 * 交互输入一个值并拆分存储：
 *   - value（用于替换）：person 取纯手机号
 *   - input（用于存默认值）：person 保留 （姓名），更友好
 * @param {{token:string,label:string,type:string}} it
 * @returns {Promise<{ value: string, input: string }>}
 */
async function askAndStore(it) {
  const v = await askValue(it)
  const value = it.type === 'person' ? splitPhoneDefault(v).phone : v
  return { value, input: v }
}

/**
 * 解析所有占位符取值：
 *   - 项目自动取值：提测项目时 {{@url}} = 提测链接、{{@title}} = 项目描述（不提示、不存默认）
 *   - 有默认值：合并询问「是否使用默认」，选否则逐个输入
 *   - 无默认值：逐个输入
 * 返回 values（按 token，用于替换）与 inputValues（仅 person 类型，可存为默认值）；取消返回 null。
 * @param {object} log
 * @param {{persons:any[], urls:any[], titles:any[], hasAll:boolean}} ph
 * @param {Record<string,string>} defaults
 * @param {string | null} previewLink
 * @param {string | undefined} description
 */
async function resolvePlaceholders(log, ph, defaults, previewLink, description) {
  const values = {}
  const inputValues = {}

  // 项目自动取值
  if (previewLink) {
    const u = ph.urls.find((x) => x.token === '@url')
    if (u) {
      values['@url'] = previewLink
      log.info(`「${u.label}」：${previewLink}`)
    }
  }
  if (description) {
    const t = ph.titles.find((x) => x.token === '@title')
    if (t) {
      values['@title'] = description
      log.info(`「${t.label}」：${description}`)
    }
  }

  // 需要交互的项（排除已被项目自动取值的 {{@url}}/{{@title}}）
  const items = [
    ...ph.persons.map((it) => ({ ...it, type: 'person' })),
    ...ph.urls.filter((it) => !(previewLink && it.token === '@url')).map((it) => ({ ...it, type: 'url' })),
    ...ph.titles.filter((it) => !(description && it.token === '@title')).map((it) => ({ ...it, type: 'title' })),
    ...ph.contents.map((it) => ({ ...it, type: 'content' })),
  ]
  if (!items.length) return { values, inputValues }

  try {
    const withDefault = items.filter((it) => defaults[it.token])
    if (withDefault.length) {
      const preview = withDefault
        .map((it) => {
          const raw = defaults[it.token]
          const display = it.type === 'person' ? splitPhoneDefault(raw).display : raw
          return `${it.label}=${display}`
        })
        .join('\n')
      const useDefault = await yesNo(log, `以下有默认值，是否使用？\n${preview}`, true)
      if (useDefault === null) return null
      for (const it of withDefault) {
        if (useDefault) {
          const raw = defaults[it.token]
          values[it.token] = it.type === 'person' ? splitPhoneDefault(raw).phone : raw
        } else {
          const { value, input } = await askAndStore(it)
          values[it.token] = value
          if (it.type === 'person') inputValues[it.token] = input
        }
      }
    }
    for (const it of items.filter((x) => !defaults[x.token])) {
      const { value, input } = await askAndStore(it)
      values[it.token] = value
      if (it.type === 'person') inputValues[it.token] = input
    }
    return { values, inputValues }
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      log.info('已取消')
      return null
    }
    throw err
  }
}

/**
 * `shop gotest`     —— （可选）选本地项目 → 选群 → 选模板 → 填占位 → 发送到钉钉群。
 * `shop gotest -e`  —— 打印本地配置文件路径。
 * 群和模板都存在本机 dingtalk.json，列表末尾可「新增」。
 */
export default {
  name: 'gotest',
  aliases: ['gotest'],
  description: '发送通知到钉钉群（选群 → 选模板 → 填占位 → 发送）',
  usage: 'shop gotest [-e]',
  async run(ctx) {
    const { log, argv } = ctx

    // -e / --edit：仅输出本地配置文件路径
    if (argv.some((a) => a === '-e' || a === '--edit')) {
      const file = getDingtalkFile()
      if (!existsSync(file)) saveDingtalkConfig(loadDingtalkConfig()) // 文件不存在则建空结构
      log.step(`钉钉配置文件：${file}`)
      return
    }

    const cfg = loadDingtalkConfig()

    // ⓪ 是否提测本地项目（仅当有项目时询问）
    const projects = loadProjects()
    let project = null
    if (projects.length > 0) {
      const useProject = await yesNo(log, '是否提测本地项目？', true)
      if (useProject === null) return
      if (useProject) {
        try {
          project = await select({
            message: '选择项目：',
            choices: projects.map((p) => ({
              name: `${p.templateName ?? p.store ?? '?'} - ${p.description || '无描述'}`,
              value: p,
            })),
          })
        } catch (err) {
          if (err?.name === 'ExitPromptError') {
            log.info('已取消')
            return
          }
          throw err
        }
      }
    }

    // ① 选群
    const groupChoices = [
      ...cfg.groups.map((g) => ({ name: g.name, value: g })),
      { name: '＋ 新增通知群', value: NEW_GROUP },
    ]
    let groupChoice
    try {
      groupChoice = await select({ message: '选择通知群：', choices: groupChoices })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    let group
    if (groupChoice === NEW_GROUP) {
      group = await promptNewGroup(log)
      if (!group) return
      cfg.groups = [...cfg.groups, group]
      saveDingtalkConfig(cfg)
      log.success(`已保存群：${group.name}`)
    } else {
      group = groupChoice
    }

    // ② 选模板（保留 tpl 引用以读写 defaults）
    const tplChoices = [
      ...cfg.templates.map((t) => ({ name: t.name, value: t })),
      { name: '＋ 新增模板', value: NEW_TEMPLATE },
    ]
    let tplChoice
    try {
      tplChoice = await select({ message: '选择发布模板：', choices: tplChoices })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    let tpl
    if (tplChoice === NEW_TEMPLATE) {
      tpl = await promptNewTemplate(log)
      if (!tpl) return
      cfg.templates = [...cfg.templates, tpl]
      saveDingtalkConfig(cfg)
      log.success(`已保存模板：${tpl.name}`)
    } else {
      tpl = tplChoice
    }
    const content = tpl.content

    // ③ 填占位符
    const ph = parsePlaceholders(content)

    const previewLink = project
      ? buildLinks({
          domain: project.domain,
          store: project.store,
          theme: project.theme,
          preview_key: project.previewKey, // camelCase → snake_case（buildLinks 读 snake_case）
          preview_path: project.previewPath,
          port: project.port,
        }).previewLink
      : null

    const resolved = await resolvePlaceholders(log, ph, tpl.defaults ?? {}, previewLink, project?.description)
    if (!resolved) return
    const { values, inputValues } = resolved

    // ③ bis 手动输入的值 → 询问是否存为默认（合并进 tpl.defaults）
    // 与现有默认值（按手机号比对）相同的不再提示——存了也是重复
    const defaults = tpl.defaults ?? {}
    const inputEntries = Object.entries(inputValues).filter(([tok, v]) => {
      const cur = defaults[tok]
      if (cur == null) return true // 无默认值 → 视为新默认，保留
      return splitPhoneDefault(v).phone !== splitPhoneDefault(cur).phone
    })
    if (inputEntries.length) {
      const allItems = [...ph.persons, ...ph.urls, ...ph.titles]
      const isPerson = (tok) => ph.persons.some((x) => x.token === tok)
      const preview = inputEntries
        .map(([tok, v]) => {
          const label = allItems.find((x) => x.token === tok)?.label ?? tok
          const display = isPerson(tok) ? splitPhoneDefault(v).display : v
          return `${label}=${display}`
        })
        .join('\n')
      const save = await yesNo(log, `是否将以下保存为默认值？\n${preview}`, false)
      if (save === null) return
      if (save) {
        // 统一走 setDingtalkTemplateDefaults：系统模板的默认值须存 systemDefaults
        // （saveDingtalkConfig 会剥离 system:true 模板，直接改 tpl.defaults 再存会静默丢失）
        const merged = { ...(tpl.defaults ?? {}), ...Object.fromEntries(inputEntries) }
        const saved = setDingtalkTemplateDefaults(tpl.id, merged)
        if (saved) {
          tpl.defaults = saved.defaults
          log.success('已保存为默认值')
        } else {
          log.warn('未找到该模板，默认值未保存')
        }
      }
    }

    const { text, atMobiles, isAtAll } = fillTemplate(content, values)

    // ④ 发送
    const spinner = ora(`正在发送到「${group.name}」…`).start()
    try {
      const errmsg = await sendText(text, group, { atMobiles, isAtAll })
      spinner.succeed(`已发送到「${group.name}」（${errmsg}）`)
    } catch (err) {
      spinner.fail(`发送失败：${err.message}`)
      log.warn('常见原因：关键词不匹配 / 加签 secret 错误 / 手机号不在群内 / 出口 IP 未放行 / webhook 失效')
      return 1
    }
  },
}
