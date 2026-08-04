/**
 * 根据环境配置生成预览相关的几组链接（与 shop pre 输出一致）。
 * 纯函数：不读文件、不打印，输入 env 对象即可。
 * @param {{ domain: string, store: string, theme: string, preview_key?: string, port: number|string }} env
 * @returns {{ devLink: string, previewLink: string, adminLink: string, editorLink: string }}
 */
export function buildLinks(env) {
  const previewLink = env.preview_key
    ? `${env.domain}/pages?preview_key=${env.preview_key}&preview_theme_id=${env.theme}`
    : `${env.domain}?_ab=0&_fd=0&_sc=1&preview_theme_id=${env.theme}`

  const adminLink = `https://admin.shopify.com/store/${env.store.split('.')[0]}/themes`
  const editorLink = `${adminLink}/${env.theme}/editor`
  const devLink = `http://127.0.0.1:${env.port}${env.preview_key ? `/pages?preview_key=${env.preview_key}` : ''}`

  return { devLink, previewLink, adminLink, editorLink }
}
