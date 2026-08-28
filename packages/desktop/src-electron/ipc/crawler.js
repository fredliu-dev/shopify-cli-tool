// 爬虫工作流域 IPC：项目 CRUD + 画布导入导出 + 运行控制 + 结果落盘。
// 爬虫页已并入主窗口（左侧栏切换），不再有独立窗口；执行引擎与持久化分别在
// ../crawler-runner.js 与 ../crawler-store.js。
import { ipcMain, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createCrawler,
  deleteCrawler,
  getCrawler,
  listCrawlers,
  renameCrawler,
  saveCrawler,
  saveCrawlerAs,
  validateGraph,
} from '../crawler-store.js'
import { isRunning, MODULE_TYPES, openLoginWindow, runCrawler, stopRun } from '../crawler-runner.js'
import { readTableFile } from '../crawler-table.js'
import { listRunningRuns, removeCheckpoint } from '../crawler-checkpoint.js'

export function registerCrawlerIpc() {
  /* -------- 项目 CRUD -------- */

  ipcMain.handle('crawler:ls', async () => {
    try {
      return { ok: true, data: await listCrawlers() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:create', async (_evt, name) => {
    try {
      return { ok: true, data: await createCrawler(String(name || '').trim() || '未命名爬虫') }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:get', async (_evt, id) => {
    try {
      const doc = await getCrawler(id)
      if (!doc) return { ok: false, error: '项目不存在（可能已被删除）' }
      return { ok: true, data: doc }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:save', async (_evt, opts) => {
    try {
      return await saveCrawler(opts)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:saveAs', async (_evt, opts) => {
    try {
      return await saveCrawlerAs({ name: String(opts?.name || '').trim() || '未命名爬虫', graph: opts.graph })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:rename', async (_evt, opts) => {
    try {
      if (!opts?.name?.trim()) return { ok: false, error: '项目名不能为空' }
      return await renameCrawler({ id: opts.id, name: opts.name })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:delete', async (_evt, id) => {
    try {
      if (isRunning()) stopRun() // 删除时若在跑先停（单任务模型下无法精确匹配项目，直接停）
      return await deleteCrawler(id)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /* -------- 画布导入导出（JSON 文件） -------- */

  ipcMain.handle('crawler:exportGraph', async (_evt, id) => {
    try {
      const doc = await getCrawler(id)
      if (!doc) return { ok: false, error: '项目不存在' }
      const res = await dialog.showSaveDialog({
        title: '导出爬虫画布',
        defaultPath: `${doc.name}.crawler.json`,
        filters: [{ name: '爬虫画布 JSON', extensions: ['json'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, JSON.stringify({ version: 1, name: doc.name, graph: doc.graph }, null, 2), 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:importGraph', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: '导入爬虫画布',
        properties: ['openFile'],
        filters: [{ name: '爬虫画布 JSON', extensions: ['json'] }],
      })
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }
      const raw = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
      // 轻校验：version/名称/画布结构/模块类型/正则可编译（不要求配置完整，允许半成品导入续编）
      if (!raw || typeof raw !== 'object') return { ok: false, error: '文件格式不正确：不是有效的 JSON 对象' }
      if (raw.version !== 1) return { ok: false, error: `文件格式不正确：不支持的版本 ${raw.version}` }
      const check = validateGraph(raw.graph)
      if (!check.ok) return { ok: false, error: `文件格式不正确：${check.error}` }
      for (const n of raw.graph.nodes) {
        if (!MODULE_TYPES.includes(n.type)) {
          return { ok: false, error: `文件格式不正确：未知模块类型「${n.type}」（可能来自更高版本）` }
        }
        for (const s of [n.data?.selector, ...(n.data?.fields || []).map((f) => f.selector)]) {
          if (s?.mode === 'classRegex') {
            try {
              new RegExp(s.value)
            } catch {
              return { ok: false, error: `文件格式不正确：节点「${n.data?.label || n.type}」的 class 正则不合法` }
            }
          }
        }
      }
      const saved = await saveCrawlerAs({ name: String(raw.name || '').trim() || '导入的爬虫', graph: raw.graph })
      return saved
    } catch (err) {
      return { ok: false, error: `导入失败：${err.message}` }
    }
  })

  /* -------- 运行控制 -------- */

  ipcMain.handle('crawler:run', async (_evt, opts) => {
    try {
      // 磁盘=最后一次运行版本（运行前先落盘，下次打开画布与实际执行一致）
      if (opts?.id && opts.graph) {
        await saveCrawler({ id: opts.id, graph: opts.graph })
      }
      // 项目名给表格导出做默认文件名（拿不到也不阻塞运行）
      let projectName
      try {
        const doc = await getCrawler(opts?.id)
        projectName = doc?.name
      } catch {
        /* 忽略 */
      }
      // showWindow：「打开窗口」选项（控制台开关），勾选后 webpage 模块打开网址时显示执行窗口
      return runCrawler({ projectId: opts?.id, projectName, graph: opts.graph, showWindow: !!opts?.showWindow })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('crawler:stop', () => {
    try {
      return stopRun()
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /* -------- 断点继续 -------- */

  // 列出项目下未完成的运行（失败/停止后可续跑），按更新时间倒序
  ipcMain.handle('crawler:pendingRuns', async (_evt, projectId) => {
    try {
      return { ok: true, data: await listRunningRuns(String(projectId || '')) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 从断点继续：graph 传当前画布（用户可能修复过失败节点的配置），没传则用断点快照
  ipcMain.handle('crawler:continue', async (_evt, opts) => {
    try {
      const projectId = String(opts?.id || '')
      const resumeRunId = String(opts?.runId || '')
      if (!projectId || !resumeRunId) return { ok: false, error: '缺少项目或运行编号，无法继续' }
      let projectName
      try {
        const doc = await getCrawler(projectId)
        projectName = doc?.name
      } catch {
        /* 忽略 */
      }
      return runCrawler({ projectId, projectName, graph: opts?.graph, resumeRunId, showWindow: !!opts?.showWindow })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 丢弃断点（放弃续跑，清除该次运行的状态文件）
  ipcMain.handle('crawler:discardRun', async (_evt, opts) => {
    try {
      return await removeCheckpoint(String(opts?.id || ''), String(opts?.runId || ''))
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 登录窗口：与执行窗口同一持久会话，流程外先登录目标站（见 openLoginWindow 注释）
  ipcMain.handle('crawler:openLogin', (_evt, url) => {
    try {
      return openLoginWindow(String(url || ''))
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /* -------- 表格文件选择（导入表格模块配置用：选文件即解析行列，节点只存路径） -------- */

  ipcMain.handle('crawler:pickTableFile', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: '选择表格文件',
        properties: ['openFile'],
        filters: [
          { name: 'CSV / JSON 表格', extensions: ['csv', 'json'] },
          { name: 'CSV 文件', extensions: ['csv'] },
          { name: 'JSON 文件', extensions: ['json'] },
        ],
      })
      if (res.canceled || !res.filePaths.length) return { ok: true, canceled: true }
      const filePath = res.filePaths[0]
      const { columns, rows } = readTableFile(filePath) // 解析失败（格式错）在这里就报给用户
      return { ok: true, data: { path: filePath, columns, rowCount: rows.length } }
    } catch (err) {
      return { ok: false, error: `表格解析失败：${err.message}` }
    }
  })

  /* -------- 选择保存目录（表格导出模块配置用：返回目录路径，不解析） -------- */

  ipcMain.handle('crawler:pickSaveDir', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: '选择表格保存位置',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || !res.filePaths.length) return { ok: true, canceled: true }
      return { ok: true, data: { path: res.filePaths[0] } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /* -------- 结果导出（渲染层无 fs，字符串由渲染层拼好传进来） -------- */

  ipcMain.handle('crawler:saveResults', async (_evt, opts) => {
    try {
      const name = String(opts?.defaultName || 'crawler-results')
      const ext = name.endsWith('.json') ? 'json' : 'csv'
      const res = await dialog.showSaveDialog({
        title: '导出爬虫结果',
        defaultPath: name,
        filters: [ext === 'json' ? { name: 'JSON 文件', extensions: ['json'] } : { name: 'CSV 文件', extensions: ['csv'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, opts.content, 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
