import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import ora from 'ora'
import { APP_NAME, detectPlatform, fetchLatestRelease, pickAsset, downloadAsset, openFile } from './_desktop.js'

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * `shop download` —— 根据当前系统（os + arch）从 GitHub Release 下载对应的安装包，
 * 下载完成后自动打开安装包（macOS 挂载 dmg / Windows 运行 exe）。
 */
export default {
  name: 'download',
  aliases: ['download'],
  description: '按当前系统下载 Shopify Toolbox 桌面应用安装包',
  usage: 'shop download',
  async run({ log }) {
    const pf = detectPlatform()
    if (pf.os !== 'darwin' && pf.os !== 'win32') {
      log.error(`暂不支持该系统（${pf.os}/${pf.arch}），目前提供 macOS 与 Windows 版本。`)
      return 1
    }

    const spin = ora('正在查询最新版本…').start()
    let release
    try {
      release = await fetchLatestRelease()
    } catch (err) {
      spin.fail(`查询最新版本失败：${err.message}`)
      log.info('已自动尝试直连与国内镜像加速仍失败，请检查网络（或开代理）后重试。')
      return 1
    }
    if (!release) {
      spin.fail('还没有发布版本，请稍后再试或联系开发者。')
      return 1
    }

    const asset = pickAsset(release, pf)
    if (!asset) {
      spin.fail(`版本 ${release.tag_name} 未找到适配 ${pf.os}/${pf.arch} 的安装包。`)
      log.info('可前往发布页手动下载：' + pc.cyan(`https://github.com/fredliu-dev/shopify-cli-tool/releases/tag/${release.tag_name}`))
      return 1
    }

    spin.succeed(`最新版本 ${pc.cyan(release.tag_name)}：${pc.bold(asset.name)}（${mb(asset.size || 0)}）`)

    const dest = join(process.cwd(), asset.name)
    const dl = ora(`下载中 → ${pc.gray(dest)}`).start()
    try {
      const bytes = await downloadAsset(asset.browser_download_url, dest, ({ loaded, total }) => {
        if (total) dl.text = `下载中 ${Math.round((loaded / total) * 100)}% → ${pc.gray(dest)}`
      })
      dl.succeed(`已下载：${pc.green(dest)}（${mb(bytes)}）`)
    } catch (err) {
      const hint = existsSync(`${dest}.part`) ? '（已保留半截文件，下次运行自动从断点续传）' : ''
      dl.fail(`下载失败：${err.message}${hint}`)
      log.info('已自动尝试直连与国内镜像加速仍失败，请检查网络（或开代理）后重试。')
      return 1
    }

    log.info(`正在打开安装包，按提示完成「${APP_NAME}」安装。`)
    openFile(dest)
  },
}
