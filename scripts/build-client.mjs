/**
 * 把 `client/index.js` 包成 `client/bundle.js`。
 *
 * 客户端插件产物遵循 client-modules 的 bundle 协议：
 * `window.__ModuleLoader__.load({ id, factory })` 注册一个惰性 CJS 工厂，
 * 模块体内的副作用（含样式注入）只在 factory 被求值时才跑。
 *
 * 本插件不 require 任何框架模块（不碰 react，也不消费别的插件的服务），
 * 所以工厂签名不带 `require`。
 *
 * 运行：`node scripts/build-client.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, '..', 'client', 'index.js')
const bundlePath = join(here, '..', 'client', 'bundle.js')

const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const source = readFileSync(sourcePath, 'utf8')

// 源文件开头的说明性注释块提到产物最前面，让读产物的人先看到结论。
const lines = source.replace(/\s+$/, '').split('\n')
let docEnd = 0
while (docEnd < lines.length && (lines[docEnd].startsWith('//') || lines[docEnd].trim() === ''))
  docEnd += 1
const doc = lines.slice(0, docEnd).join('\n').replace(/\s+$/, '')
const body = lines.slice(docEnd)

const banner = `${doc}
window.__ModuleLoader__.load({
  id: '${pkg.name}',
  factory: () => {
`

const footer = `

    return { name, inject, apply }
  },
})
`

const indented = body
  .map(line => (line.length === 0 ? line : '    ' + line))
  .join('\n')

writeFileSync(bundlePath, banner + indented + footer)
console.log(`built ${bundlePath}`)
