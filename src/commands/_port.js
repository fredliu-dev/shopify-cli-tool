import { execSync } from 'node:child_process'

/**
 * 查询占用指定端口的进程 PID 列表。
 * 跨平台：Windows 用 netstat，macOS/Linux 用 lsof。
 * @param {number|string} port
 * @returns {string[]} PID 列表（去重）
 */
export function getPortPids(port) {
  const p = Number(port)
  const pids = new Set()

  if (process.platform === 'win32') {
    let out = ''
    try {
      out = execSync('netstat -ano', { encoding: 'utf8' })
    } catch {
      return []
    }
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      // TCP: Proto Local Foreign State PID；UDP 无 State；跳过表头/空行
      if (cols.length < 4) continue
      const local = cols[1] ?? ''
      const pid = cols[cols.length - 1]
      // 形如 0.0.0.0:9292 / [::]:9292，只匹配末尾端口，避免误伤 92920
      const m = local.match(/:([0-9]+)$/)
      if (m && Number(m[1]) === p && /^\d+$/.test(pid)) {
        pids.add(pid)
      }
    }
    return [...pids]
  }

  // macOS / Linux
  try {
    const out = execSync(`lsof -ti tcp:${p}`, { encoding: 'utf8' }).trim()
    if (out) out.split(/\r?\n/).forEach((pid) => pid && pids.add(pid))
  } catch {
    // 端口空闲时 lsof 以非零退出，属正常
  }
  return [...pids]
}

/**
 * 杀掉占用指定端口的所有进程。
 * @param {number|string} port
 * @returns {number} 实际杀掉的进程数
 */
export function killPort(port) {
  const pids = getPortPids(port)
  let killed = 0
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        // /T 连带子进程一起杀（dev server 常派生子进程）
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' })
      } else {
        process.kill(Number(pid), 'SIGKILL')
      }
      killed++
    } catch {
      // 进程可能已退出，忽略
    }
  }
  return killed
}
