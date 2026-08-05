import { readdir, stat, mkdir, copyFile } from 'node:fs/promises'
import { join, extname, basename, isAbsolute } from 'node:path'
import { select, input } from '@inquirer/prompts'
import { log } from '../ui/logger.js'
import ora from 'ora'
import sharp from 'sharp'

// 支持的图片格式
const SUPPORTED_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']

// 颜色容差默认值（RGB 欧氏距离）：相邻像素颜色差不超过此值即视为同一片背景
// 阴影是平滑渐变，相邻像素差极小，所以这个值主要用来在「主体边缘」处停下
const DEFAULT_TOLERANCE = 20

// 检查是否为支持的图片格式
function isImageFile(filename) {
  const ext = extname(filename).toLowerCase()
  return SUPPORTED_FORMATS.includes(ext)
}

// 解析命令行参数：shop handleimg [--tolerance 20 | -t 20 | --tolerance=20]
function parseOptions(argv) {
  const args = argv.slice(1)
  let tolerance = DEFAULT_TOLERANCE
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = args[i + 1]
    if (a === '--tolerance' || a === '-t') {
      const v = Number(next)
      if (!Number.isNaN(v)) {
        tolerance = v
        i++
      }
    } else if (a.startsWith('--tolerance=')) {
      const v = Number(a.slice('--tolerance='.length))
      if (!Number.isNaN(v)) tolerance = v
    }
  }
  // 容差必须为正
  return { tolerance: tolerance > 0 ? tolerance : DEFAULT_TOLERANCE }
}

// 裁掉图片四周的「透明空白 + 阴影 / 边框」，保留主体（卡片）及其内部内容。
// 输出 = 原图裁剪到主体包围盒；不抠图、不擦除背景，主体连同它自身的背景原样保留。
//
// · 自带透明通道的图（渲染卡片 / 截图最常见）：卡片是完全不透明的，四周的 box-shadow
//   是半透明、再外是全透明。直接裁到「完全不透明像素」的包围盒即得到卡片，
//   半透明阴影与全透明留白一并被裁掉。
// · 完全不透明的图（拍平的 JPEG / 截图）：没有 alpha 可借，用颜色从四边 flood 找最外层
//   背景（边框 / 暗角 / 大面积底色），裁到剩余内容里最大一块（主体）的包围盒。
//   容差 tolerance 控制颜色生长范围（仅此分支生效）。
async function trimToContentBox(imagePath, tolerance) {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height
  const ch = info.channels // ensureAlpha 后恒为 4

  // 带透明边距 / 阴影的图：直接裁到「完全不透明内容（卡片）」包围盒，
  // 半透明阴影与全透明留白一并裁掉，卡片及其内部内容原样保留
  let transparent = 0
  for (let i = 0; i < w * h; i++) if (data[i * ch + 3] < 10) transparent++
  if (transparent / (w * h) > 0.01) {
    return bboxByAlpha(data, w, h, ch, 250) ?? bboxByAlpha(data, w, h, ch, 10)
  }

  // ---- 以下仅完全不透明图：颜色 flood 找最外层背景，裁到最大内容块包围盒 ----
  const tol2 = tolerance * tolerance
  // state: 0 = 内容，1 = 背景
  const state = new Uint8Array(w * h)
  // DFS 栈（flood 与连通域复用），预分配最大容量
  const stack = new Int32Array(w * h)
  let sp = 0
  const push = (i) => {
    if (state[i] === 0) {
      state[i] = 1
      stack[sp++] = i
    }
  }

  // 四条边上的像素默认属于背景
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 1; y < h - 1; y++) {
    push(y * w)
    push(y * w + w - 1)
  }

  // 区域生长：邻居与「已是背景的当前像素」颜色差在容差内 → 纳入背景
  // 用相邻像素比较（而非与种子点比较），可顺着渐变背景 / 阴影一路生长
  const flood = () => {
    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i / w) | 0
      const pi = i * ch
      const pr = data[pi]
      const pg = data[pi + 1]
      const pb = data[pi + 2]
      const grow = (ni) => {
        if (state[ni] !== 0) return
        const qi = ni * ch
        const dr = pr - data[qi]
        const dg = pg - data[qi + 1]
        const db = pb - data[qi + 2]
        if (dr * dr + dg * dg + db * db <= tol2) push(ni)
      }
      if (y > 0) grow(i - w)
      if (y < h - 1) grow(i + w)
      if (x > 0) grow(i - 1)
      if (x < w - 1) grow(i + 1)
    }
  }
  flood()

  // 阶段 1 背景占比
  let bg1 = 0
  for (let i = 0; i < w * h; i++) if (state[i] === 1) bg1++
  const remaining = 1 - bg1 / (w * h)

  // 阶段 2：剩余内容仍很多 → 深边框隔断了内部浅底，识别内部底色再 flood 一次
  if (remaining > 0.3) {
    // 统计「阶段 1 背景」紧邻的内侧像素颜色，取众数 = 内部底色
    const hist = new Map()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (state[i] !== 1) continue
        const neighbors = []
        if (y > 0 && state[i - w] === 0) neighbors.push(i - w)
        if (y < h - 1 && state[i + w] === 0) neighbors.push(i + w)
        if (x > 0 && state[i - 1] === 0) neighbors.push(i - 1)
        if (x < w - 1 && state[i + 1] === 0) neighbors.push(i + 1)
        for (const ni of neighbors) {
          const qi = ni * ch
          // 颜色量化到每通道 4 bit 做直方图，抗轻微渐变 / 噪点
          const key = ((data[qi] >> 4) << 12) | ((data[qi + 1] >> 4) << 8) | ((data[qi + 2] >> 4) << 4)
          hist.set(key, (hist.get(key) || 0) + 1)
        }
      }
    }
    let bestKey = -1
    let bestCnt = 0
    for (const [k, c] of hist) {
      if (c > bestCnt) {
        bestCnt = c
        bestKey = k
      }
    }
    if (bestKey >= 0) {
      const ir = ((bestKey >> 12) & 0xf) << 4
      const ig = ((bestKey >> 8) & 0xf) << 4
      const ib = ((bestKey >> 4) & 0xf) << 4
      // 全图与内部底色接近的像素直接作为种子（处理被边框 / 主体隔断的多片底色）
      for (let i = 0; i < w * h; i++) {
        if (state[i] !== 0) continue
        const qi = i * ch
        const dr = data[qi] - ir
        const dg = data[qi + 1] - ig
        const db = data[qi + 2] - ib
        if (dr * dr + dg * dg + db * db <= tol2) {
          state[i] = 1
          stack[sp++] = i
        }
      }
      flood()
    }
  }

  // 连通域：在剩余内容里找最大一块（主体），丢弃零散噪点，取其包围盒
  const label = new Int32Array(w * h) // 0 = 未标记
  let lid = 0
  let bestSize = 0
  let bestBox = null
  for (let i = 0; i < w * h; i++) {
    if (state[i] !== 0 || label[i] !== 0) continue
    lid++
    let size = 0
    let minx = w
    let miny = h
    let maxx = -1
    let maxy = -1
    stack[sp++] = i
    label[i] = lid
    while (sp > 0) {
      const j = stack[--sp]
      const x = j % w
      const y = (j / w) | 0
      size++
      if (x < minx) minx = x
      if (x > maxx) maxx = x
      if (y < miny) miny = y
      if (y > maxy) maxy = y
      const expand = (nj) => {
        if (state[nj] === 0 && label[nj] === 0) {
          label[nj] = lid
          stack[sp++] = nj
        }
      }
      if (y > 0) expand(j - w)
      if (y < h - 1) expand(j + w)
      if (x > 0) expand(j - 1)
      if (x < w - 1) expand(j + 1)
    }
    if (size > bestSize) {
      bestSize = size
      bestBox = { left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 }
    }
  }

  // 主体太小（<0.5%，例如主体与背景颜色过近被一并吃掉）→ 视为无可裁内容
  if (!bestBox || bestSize / (w * h) < 0.005) return null
  return bestBox
}

// 求 alpha >= threshold 的像素包围盒；内容太少（<2%）视为无效返回 null
function bboxByAlpha(data, w, h, ch, threshold) {
  let minx = w
  let miny = h
  let maxx = -1
  let maxy = -1
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * ch + 3] >= threshold) {
        n++
        if (x < minx) minx = x
        if (x > maxx) maxx = x
        if (y < miny) miny = y
        if (y > maxy) maxy = y
      }
    }
  }
  if (maxx < 0 || n / (w * h) < 0.02) return null
  return { left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 }
}

// 根据扩展名决定输出格式：webp 优先，其次裁剪需要透明 → png，否则保留原格式
function outputExtension(file, trim, toWebp) {
  if (toWebp) return '.webp'
  if (trim) return '.png'
  return extname(file)
}

// 处理单个图片：按 trim / toWebp 的组合执行。
// 不自行打印日志（避免与外层 ora spinner 抢行），把结果 { ok, note } 返回给调用方统一输出。
//   trim + toWebp → 裁剪空白/阴影 + webp
//   trim only     → 裁剪空白/阴影 + png（保留透明圆角）
//   toWebp only   → 原样转 webp
//   都不选        → 原样复制
export async function processImage(inputPath, outputPath, { trim, toWebp, tolerance }) {
  try {
    // 两个选项都关 → 直接复制原文件
    if (!trim && !toWebp) {
      await copyFile(inputPath, outputPath)
      return { ok: true, note: '复制' }
    }

    let pipeline
    if (trim) {
      const box = await trimToContentBox(inputPath, tolerance)
      if (!box) {
        // 没有可裁剪的空白 / 阴影（或主体与背景过近无法识别）：按目标格式保留原图，避免误删数据
        await sharp(inputPath).toFile(outputPath)
        return { ok: true, note: '无空白/阴影，保留原图' }
      }
      pipeline = sharp(inputPath).extract(box)
    } else {
      pipeline = sharp(inputPath)
    }

    if (toWebp) {
      pipeline = pipeline.webp({ quality: 85 })
    } else if (trim) {
      pipeline = pipeline.png()
    }

    await pipeline.toFile(outputPath)
    return { ok: true, note: trim ? '裁剪' : '转换' }
  } catch (error) {
    return { ok: false, note: `失败：${error.message}` }
  }
}

export default {
  name: 'handleimg',
  aliases: ['handleimg'],
  description:
    '交互式处理图片：依次选择是否裁剪（去四周空白/阴影）、是否转 webp、容差、保存文件夹，再按选择执行',
  usage: 'shop handleimg [--tolerance 20]',
  async run(ctx) {
    const currentDir = process.cwd()
    let { tolerance } = parseOptions(ctx.argv || [])

    let trim
    let toWebp
    let outputDir
    try {
      // 先确认当前目录下有图，再进入交互
      const files = await readdir(currentDir)
      const imageFiles = files.filter((file) => isImageFile(file))

      if (imageFiles.length === 0) {
        log.warn('当前文件夹下没有找到支持的图片文件')
        log.info('支持的格式: jpg, jpeg, png, gif, bmp, tiff, webp')
        return 0
      }
      log.info(`找到 ${imageFiles.length} 个图片文件`)

      // 依次选择各配置项
      log.step('配置处理选项')
      trim = await select({
        message: '是否裁剪（去掉四周空白与阴影边框，保留卡片）？',
        choices: [
          { name: '是', value: true },
          { name: '否', value: false },
        ],
        default: true,
      })
      toWebp = await select({
        message: '是否转换为 webp 格式？',
        choices: [
          { name: '是', value: true },
          { name: '否', value: false },
        ],
        default: true,
      })
      // 容差：仅裁剪时选择，默认取命令行 --tolerance（若是预设值则高亮它，否则作为自定义项）
      if (trim) {
        const presets = [
          { name: '10 — 保守（少去背景，边缘更完整）', value: 10 },
          { name: '20 — 标准（推荐）', value: 20 },
          { name: '30 — 宽松（多吃浅色背景）', value: 30 },
          { name: '40 — 激进（易误吃浅色主体）', value: 40 },
        ]
        const choices = presets.some((p) => p.value === tolerance)
          ? presets
          : [{ name: `${tolerance} — 自定义（--tolerance）`, value: tolerance }, ...presets]
        tolerance = await select({
          message: '颜色容差：',
          choices,
          default: tolerance,
        })
      }
      const dirInput = (
        await input({
          message: '保存到哪个文件夹？',
          default: 'processed',
        })
      ).trim()
      outputDir = isAbsolute(dirInput) ? dirInput : join(currentDir, dirInput)

      // 准备输出
      await mkdir(outputDir, { recursive: true })
      log.info(`输出文件夹: ${outputDir}`)
      if (trim) {
        log.info(`颜色容差: ${tolerance}`)
      }

      const total = imageFiles.length
      const spinner = ora({
        text: `开始处理（裁剪: ${trim ? '是' : '否'}，webp: ${toWebp ? '是' : '否'}）`,
        color: 'cyan',
      }).start()

      let successCount = 0
      let skipCount = 0
      const failures = []

      for (let idx = 0; idx < imageFiles.length; idx++) {
        const file = imageFiles[idx]
        const inputPath = join(currentDir, file)
        const ext = outputExtension(file, trim, toWebp)
        const outputPath = join(outputDir, basename(file, extname(file)) + ext)

        // 输出文件已存在则跳过
        try {
          await stat(outputPath)
          skipCount++
          spinner.text = `(${idx + 1}/${total}) 跳过已存在: ${file}`
          continue
        } catch {
          // 文件不存在，继续处理
        }

        spinner.text = `(${idx + 1}/${total}) 处理中: ${file}`
        const res = await processImage(inputPath, outputPath, { trim, toWebp, tolerance })
        if (res.ok) {
          successCount++
        } else {
          skipCount++
          failures.push(`${file}（${res.note}）`)
        }
      }

      const summary = `处理完成！成功: ${successCount}, 跳过: ${skipCount}`
      if (failures.length) {
        spinner.warn(summary)
        for (const f of failures) log.error(`处理失败: ${f}`)
      } else {
        spinner.succeed(summary)
      }
      return 0
    } catch (err) {
      // Ctrl+C / ESC 取消：优雅退出，不报「处理失败」
      if (err?.name === 'ExitPromptError') {
        log.info('已取消')
        return 0
      }
      log.error(`处理失败: ${err.message}`)
      return 1
    }
  },
}
