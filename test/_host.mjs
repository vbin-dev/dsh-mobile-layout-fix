/**
 * 定位宿主的 dsh-tauri 产物，供真实产物级测试使用。
 *
 * 优先读环境变量，其次在几个常见安装位置里找：
 *
 *   DSH_TAURI_RESOURCES  直接指向包含 node_modules 的 resources 目录
 *   DSH_TAURI_CLIENT     直接指向 dsh-tauri/dist/client.cjs
 *
 * `DSH Tauri/resources/node_modules`（Linux 安装包）与
 * `~/.dsh/profiles/<name>/node_modules`（profile 内链接）都能命中，
 * 所以同一份脚本在开发机和用户机器上都能跑。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @returns {string | null} 找到的 client.cjs 绝对路径 */
export function findHostClient() {
  const explicit = process.env.DSH_TAURI_CLIENT
  if (explicit !== undefined && existsSync(explicit))
    return explicit

  const candidates = []

  const resources = process.env.DSH_TAURI_RESOURCES
  if (resources !== undefined)
    candidates.push(join(resources, 'node_modules', 'dsh-tauri', 'dist', 'client.cjs'))

  // Linux / root 安装包解压后的固定位置
  candidates.push('/usr/lib/DSH Tauri/resources/node_modules/dsh-tauri/dist/client.cjs')

  // macOS 应用包
  candidates.push('/Applications/DSH Tauri.app/Contents/Resources/node_modules/dsh-tauri/dist/client.cjs')

  // 用户级安装
  candidates.push(join(homedir(), '.local', 'share', 'dsh-tauri', 'resources', 'node_modules', 'dsh-tauri', 'dist', 'client.cjs'))

  // profile 里的链接依赖
  for (const profile of ['tauri', 'desktop', 'web']) {
    candidates.push(join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-tauri', 'dist', 'client.cjs'))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate))
      return candidate
  }
  return null
}

/**
 * 取上游的 MOBILE_POINTER_QUERIES / MOBILE_BREAKPOINT。
 * 直接从产物里抠字面量，避免手抄常量与上游漂移。
 *
 * @param {string} source dsh-tauri/dist/client.cjs 的内容
 */
export function readUpstreamConstants(source) {
  const pointerMatch = source.match(/(?:MOBILE_POINTER_QUERIES|l)=\[(`[^`]+`(?:,`[^`]+`)*)\]/)
  if (pointerMatch === null)
    throw new Error('没能在上游产物里定位 MOBILE_POINTER_QUERIES')

  const pointerQueries = [...pointerMatch[1].matchAll(/`([^`]+)`/g)].map(m => m[1])

  const breakpointMatch = source.match(/MOBILE_BREAKPOINT[^0-9]*(\d{3,4})/) ?? source.match(/(?:MOBILE_BREAKPOINT|u)=(\d{3,4})/)
  const breakpoint = breakpointMatch === null ? 1024 : Number(breakpointMatch[1])

  return { pointerQueries, breakpoint, mediaQueries: [...pointerQueries, `(max-width: ${breakpoint - 1}px)`] }
}
