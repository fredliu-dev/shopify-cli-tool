/**
 * 规范化网页路径：去首尾空白与斜杠后补单个前导斜杠（"pages/xx/" → "/pages/xx"）。
 * 空值返回 ''；保证拼进 URL 时不会出现 // 或缺斜杠。
 */
function normalizePreviewPath(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return '/' + s.replace(/^\/+|\/+$/g, '')
}

/**
 * 根据环境配置生成预览相关的几组链接（与 shop pre 输出一致）。
 * 纯函数：不读文件、不打印，输入 env 对象即可。
 * preview_path（网页路径，如 /pages/back-to-school-sale）是 preview_key 缺失时的降级定位方式：
 *   - 提测/开发链接：有 preview_key 走原逻辑；无 key 但有路径 → 路径拼到路由后面再挂参数
 *   - 编辑器链接：有路径即追加 ?previewPath=<路径>（斜杠转 %2F，encodeURIComponent）
 * @param {{ domain: string, store: string, theme: string, preview_key?: string, preview_path?: string, port: number|string }} env
 * @returns {{ devLink: string, previewLink: string, adminLink: string, editorLink: string }}
 */
export function buildLinks(env) {
  const previewPath = normalizePreviewPath(env.preview_path)

  const previewLink = env.preview_key
    ? `${env.domain}/pages?preview_key=${env.preview_key}&preview_theme_id=${env.theme}`
    : previewPath
      ? `${env.domain}${previewPath}?_ab=0&_fd=0&_sc=1&preview_theme_id=${env.theme}`
      : `${env.domain}?_ab=0&_fd=0&_sc=1&preview_theme_id=${env.theme}`

  const adminLink = `https://admin.shopify.com/store/${env.store.split('.')[0]}/themes`
  const editorLink = `${adminLink}/${env.theme}/editor${previewPath ? `?previewPath=${encodeURIComponent(previewPath)}` : ''}`
  const devLink = `http://127.0.0.1:${env.port}${env.preview_key ? `/pages?preview_key=${env.preview_key}` : previewPath}`

  return { devLink, previewLink, adminLink, editorLink }
}
