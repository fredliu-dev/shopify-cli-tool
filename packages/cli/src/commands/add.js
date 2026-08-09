import { readFileSync, writeFileSync } from 'node:fs'
import { input, checkbox, confirm, list } from '@inquirer/prompts'
import initCmd from './init.js'
import { copyLiveTheme } from './copy.js'
import { loadThemeConfig, setEnvField, storeToTemplate, listTemplates, loadProjects, saveProjects, listBranches } from '@shopify-cli-tool/core'

// 需要齐全的字段（store 作为环境身份，是前置门槛；其余缺了就补填）
const REQUIRED_FIELDS = [
  { key: 'domain', message: '请输入 domain：' },
  { key: 'port', message: '请输入 port：', default: '9292', validate: (v) => (/^\d+$/.test(v.trim()) ? true : '需为数字') },
  { key: 'theme', message: '请输入 theme：' },
  { key: 'preview_key', message: '请输入 preview_key（选填）：', optional: true },
  { key: 'project_desc', message: '请输入 project_desc：' },
]

/**
 * `shop add` —— 从当前目录的 shopify.theme.toml 读取环境，补全缺失字段后保存为项目。
 * 流程：
 *   1. 没有配置文件 → 先 shop init
 *   2. 取所有带 store 的环境；逐个补填缺失字段，并写回配置文件
 *      （theme 缺失时询问是否复制线上 live 主题，是则复制并回填新 id）
 *   3. 多选要保存的环境（此时都已补全）
 *   4. 按 store 匹配模板（反查不到则让用户选），构建项目并新增到 projects.json（六要素全同视为已存在）
 */
export default {
  name: 'add',
  aliases: ['add'],
  description: '从当前配置保存项目（按 store 判断模板）',
  usage: 'shop add',
  async run(ctx) {
    const { log } = ctx

    // 当前分支：保存项目时记入 _branch（项目身份 + 「合并」源分支）
    const { current: currentBranch } = await listBranches(process.cwd())

    // ① 确保配置文件存在
    let cfg = loadThemeConfig()
    if (!cfg) {
      log.warn('未找到 shopify.theme.toml，先执行 shop init …')
      await initCmd.run(ctx)
      cfg = loadThemeConfig()
      if (!cfg) {
        log.error('初始化未完成，已取消执行')
        return
      }
    }

    // ② 取带 store 的环境（store 是项目身份，也是模板判断依据）
    const entries = Object.entries(cfg.environments).filter(([, e]) => e && e.store)
    if (entries.length === 0) {
      log.error('没有找到配置了 store 的环境，请先在 shopify.theme.toml 配置 [environments.*].store')
      return
    }

    // ③ 逐个补全缺失字段；同时把补填值写回配置文件
    const original = readFileSync(cfg.path, 'utf8')
    let content = original
    const ready = []
    for (const [name, env] of entries) {
      const filled = {}
      for (const f of REQUIRED_FIELDS) {
        const cur = env[f.key]
        if (cur !== undefined && String(cur).trim() !== '') continue

        // theme 缺失：优先询问是否复制线上 live 主题，是则复制并把新 id 回填到 theme
        if (f.key === 'theme') {
          let doCopy
          try {
            doCopy = await confirm({
              message: `[${name}] 未配置 theme，是否复制线上 live 主题？`,
              default: true,
            })
          } catch (err) {
            if (err?.name === 'ExitPromptError') {
              log.info('已取消')
              return
            }
            throw err
          }
          if (doCopy) {
            const newTheme = await copyLiveTheme(ctx, { envName: name, envConfig: env, showLinks: false })
            if (newTheme?.id) {
              filled.theme = newTheme.id
              continue
            }
            log.warn('复制主题失败，改为手动输入 theme')
          }
        }

        let val
        try {
          val = await input({
            message: `[${name}] ${f.message}`,
            default: f.default,
            validate: f.validate ?? (f.optional ? undefined : (v) => (v.trim() ? true : '不能为空')),
          })
        } catch (err) {
          if (err?.name === 'ExitPromptError') {
            log.info('已取消')
            return
          }
          throw err
        }
        filled[f.key] = val.trim()
      }
      for (const [k, v] of Object.entries(filled)) {
        content = setEnvField(content, name, k, v)
      }
      // 记录当前分支到 _branch（与桌面端保存一致：项目身份 + 合并源分支）
      if (currentBranch) content = setEnvField(content, name, '_branch', currentBranch)
      ready.push({ name, env: { ...env, ...filled } })
    }
    if (content !== original) {
      writeFileSync(cfg.path, content, 'utf8')
      log.success('已将补全字段写回 shopify.theme.toml')
    }

    // ④ 多选要保存的环境（此时都已补全 → 都是合法选项）
    let selected
    try {
      selected = await checkbox({
        message: '选择要保存为项目的环境：',
        choices: ready.map((r) => ({ name: `${r.name}（${r.env.store}）`, value: r, checked: r.name === 'dev' })),
      })
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return
      }
      throw err
    }
    if (!selected.length) {
      log.info('未选择任何环境')
      return
    }

    // ⑤ 按 store 匹配模板（反查不到则让用户选），构建并新增（六要素全同视为已存在 → 跳过；否则追加为新项目）
    const projects = loadProjects()
    let added = 0
    let skipped = 0
    for (let i = 0; i < selected.length; i++) {
      const sel = selected[i]
      let templateName = storeToTemplate(sel.env.store)
      if (!templateName) {
        const tpls = listTemplates().filter((t) => t.name !== 'empty')
        if (tpls.length) {
          try {
            templateName = await list({
              message: `[${sel.name}] store "${sel.env.store}" 未匹配到模板，请选择：`,
              choices: tpls.map((t) => ({ name: t.name, value: t.name })),
            })
          } catch (err) {
            if (err?.name === 'ExitPromptError') {
              log.info('已取消')
              return
            }
            throw err
          }
        } else {
          log.warn(`[${sel.name}] store "${sel.env.store}" 未匹配到模板，且无可用模板，templateName 留空`)
        }
      }
      const proj = {
        id: (Date.now() + i).toString(),
        envName: sel.name,
        templateName,
        store: sel.env.store,
        domain: sel.env.domain,
        theme: String(sel.env.theme),
        previewKey: String(sel.env.preview_key ?? ''),
        port: String(sel.env.port),
        description: sel.env.project_desc,
        _branch: currentBranch || null,
      }
      // 六要素全相同视为已存在：store / domain / theme / preview_key / project_desc / _branch
      // （历史项目无 _branch 视为通配，避免升级后已存项目全部失配）
      const duplicated = projects.find(
        (p) =>
          p.store === proj.store &&
          p.domain === proj.domain &&
          p.theme === proj.theme &&
          p.previewKey === proj.previewKey &&
          p.description === proj.description &&
          (p._branch == null || p._branch === proj._branch),
      )
      if (duplicated) {
        skipped++
        log.warn(`[${sel.name}] 项目已存在（store=${sel.env.store}），跳过保存`)
        continue
      }
      projects.push(proj)
      added++
    }
    saveProjects(projects)
    log.success(`已新增 ${added} 个项目${skipped > 0 ? `（跳过 ${skipped} 个已存在）` : ''}`)
  },
}
