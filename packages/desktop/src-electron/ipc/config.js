import { ipcMain, dialog } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { parse } from 'smol-toml'

const THEME_FILE = 'shopify.theme.toml'

// 备份/恢复时需排除的系统垃圾文件（macOS .DS_Store / Windows Thumbs.db）
const SKIP_FILES = new Set(['.DS_Store', 'thumbs.db'])

/**
 * 递归收集目录下所有文件（相对路径用 posix 分隔符，保证 zip 内路径跨平台一致），
 * 跳过 SKIP_FILES。返回 [{ full, rel }]。
 */
function collectFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP_FILES.has(name.toLowerCase())) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, base))
    } else {
      out.push({ full, rel: full.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') })
    }
  }
  return out
}

/**
 * 生成随备份一起打包的中文 README：说明各文件用途 + Windows/macOS 配置目录路径 + 恢复步骤。
 * 配置只存在本地，换设备/重装即丢，故把「放哪、怎么恢复」写清楚。
 */
function buildBackupReadme() {
  return [
    '# Shopify 工具箱 · 本地配置备份',
    '',
    '本压缩包是你导出的本地配置备份。',
    '',
    '> ⚠️ 这些配置**只存储在本地**：卸载程序、重装系统或换电脑都会丢失。建议定期导出，并存到网盘 / U 盘等安全位置。',
    '',
    '## 备份内容',
    '',
    '| 文件 / 目录 | 说明 |',
    '| --- | --- |',
    '| `projects.json` | 本地保存的项目（store / theme / port / preview_key 等） |',
    '| `templates/` | 你**自建**的模板（内置模板随程序发布，无需备份） |',
    '| `settings.json` | 偏好设置（工作区目录、默认编辑器） |',
    '| `contacts.json` | 人员名单（姓名 + 手机号，用于分支命名 / 提测 @） |',
    '| `dingtalk.json` | 钉钉通知群 + 信息模板 |',
    '',
    '## 如何恢复（换设备 / 重装后）',
    '',
    '1. 先在新设备安装并打开一次「Shopify 工具箱」（程序会自动创建配置目录）。',
    '2. **关闭程序**（避免覆盖时文件被锁）。',
    '3. 找到该设备的配置目录：',
    '',
    '   - **Windows**：`%APPDATA%\\shopify-cli-tool\\`',
    '     （即 `C:\\Users\\<你的用户名>\\AppData\\Roaming\\shopify-cli-tool\\`）',
    '   - **macOS**：`~/.config/shopify-cli-tool/`',
    '     （即 `/Users/<你的用户名>/.config/shopify-cli-tool/`）',
    '',
    '4. 把本压缩包里的 `projects.json`、`templates/` 等文件，**解压并覆盖**到上面的目录。',
    '5. 重新打开程序，配置即恢复。',
    '',
    '## 小技巧',
    '',
    '程序内顶部「更多 ▾ → 本地配置」可在系统文件管理器中直接打开上面的配置目录，无需手动找路径。',
    '',
  ].join('\n')
}

export function registerConfigIpc() {
  // 列出可用模板（内置 + 用户自建，core 的 listTemplates 已合并两个目录）
  ipcMain.handle('config:templates', async () => {
    const { listTemplates } = await import('@shopify-cli-tool/core')
    return listTemplates()
  })

  // 本地数据目录（projects.json / templates 所在），供「本地配置」按钮打开
  ipcMain.handle('config:dataDir', async () => {
    const { userDataDir } = await import('@shopify-cli-tool/core')
    try {
      return { ok: true, data: userDataDir() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 一键导出本地配置：把整个 userDataDir 打包成 zip（含中文 README 说明路径/恢复步骤），
  // 弹保存对话框让用户选位置。配置只存本地、换设备即丢，故提供导出备份。
  ipcMain.handle('config:export', async () => {
    const { userDataDir } = await import('@shopify-cli-tool/core')
    try {
      const dir = userDataDir()
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      const res = await dialog.showSaveDialog({
        title: '导出本地配置',
        defaultPath: `shopify-config-backup-${stamp}.zip`,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }

      const zip = new AdmZip()
      collectFiles(dir).forEach(({ full, rel }) => {
        // rel 已是 posix 分隔；zip 内目录取最后一段之前的部分，根文件传 ''
        const slash = rel.lastIndexOf('/')
        zip.addLocalFile(full, slash === -1 ? '' : rel.slice(0, slash))
      })
      zip.addFile('README.md', Buffer.from(buildBackupReadme(), 'utf8'))
      zip.writeZip(res.filePath)
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 新建用户模板：写字段到 userDataDir/templates/<name>.shopify.theme.toml
  ipcMain.handle('config:createTemplate', async (_evt, { name, fields }) => {
    const { saveTemplate } = await import('@shopify-cli-tool/core')
    try {
      await saveTemplate({ name, fields })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取某模板的 [environments.dev] 字段（编辑表单预填；含 _github/_branch 等只读元数据）
  ipcMain.handle('config:templateEnv', async (_evt, name) => {
    const { loadTemplateEnv } = await import('@shopify-cli-tool/core')
    try {
      return { ok: true, data: loadTemplateEnv(name) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 改写用户自建模板字段（内置模板 core 层已拒绝）
  ipcMain.handle('config:updateTemplate', async (_evt, { name, fields }) => {
    const { updateTemplate } = await import('@shopify-cli-tool/core')
    try {
      await updateTemplate({ name, fields })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 删除用户自建模板（内置模板 core 层已拒绝）
  ipcMain.handle('config:deleteTemplate', async (_evt, name) => {
    const { deleteTemplate } = await import('@shopify-cli-tool/core')
    try {
      deleteTemplate(name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 读取目标目录的 init 状态
  ipcMain.handle('config:initStatus', async (_evt, dir) => {
    const target = join(dir, THEME_FILE)
    if (!existsSync(target)) return { exists: false }
    let hasDevDomain = false
    try {
      const parsed = parse(readFileSync(target, 'utf8'))
      hasDevDomain = !!parsed.environments?.dev?.domain
    } catch {}
    return { exists: true, hasDevDomain }
  })

  // 新建 shopify.theme.toml（文件不存在分支）
  ipcMain.handle(
    'config:initCreate',
    async (_evt, { dir, templateName, theme, port, previewKey, projectDesc }) => {
      const { buildThemeConfig } = await import('@shopify-cli-tool/core')
      try {
        const content = buildThemeConfig({ templateName, theme, port, previewKey, projectDesc })
        writeFileSync(join(dir, THEME_FILE), content, 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  )

  // 合并 dev 环境到已有 shopify.theme.toml（文件已存在分支）
  ipcMain.handle('config:initMerge', async (_evt, { dir, templateName }) => {
    const { mergeDevEnv } = await import('@shopify-cli-tool/core')
    try {
      const target = join(dir, THEME_FILE)
      const raw = readFileSync(target, 'utf8')
      writeFileSync(target, mergeDevEnv(raw, templateName), 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
