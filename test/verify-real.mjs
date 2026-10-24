// 真实产物级验证：加载上线的 dsh-tauri + dsh-tauri-mobile-ui，
// 用假的「误报 hover」内核行为跑 detectMobileDevice 与 CSS 头，
// 再加载我们的插件，确认两者都被修正。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { findHostClient } from './_host.mjs'

// 宿主产物位置按平台自动探测，可用 DSH_TAURI_CLIENT / DSH_TAURI_RESOURCES 覆盖。
const HOST_CLIENT = findHostClient()
if (HOST_CLIENT === null) {
  console.error('找不到宿主的 dsh-tauri/dist/client.cjs。请设置 DSH_TAURI_CLIENT 指向该文件后重试。')
  process.exit(2)
}
const FIX = fileURLToPath(new URL('../client/bundle.js', import.meta.url))

// ── 假内核：vivo V2353A / Android 14 / Chrome 116 ───────────────────────
const mediaState = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(hover: none)': false,
  '(any-hover: none)': false,
  '(hover: hover)': true,
  '(any-hover: hover)': true,
  '(max-width: 1023px)': true,
  '(max-width: 767px)': true,
  '(min-width: 0)': true,
}

const styles = new Map()
function makeStyle(id, text) {
  const attrs = new Map([['cssr-id', id]])
  const node = {
    textContent: text,
    getAttribute: n => attrs.get(n) ?? null,
    setAttribute: (n, v) => attrs.set(n, v),
    removeAttribute: n => attrs.delete(n),
    hasAttribute: n => attrs.has(n),
    appendChild(c) { this.textContent += c.textContent ?? '' },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '', getPropertyPriority: () => '' },
    setAttributeNS() {},
  }
  styles.set(id, node)
  return node
}

const head = {
  appendChild: () => {},
  removeChild: () => {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: sel => {
    const m = sel.match(/style\[cssr-id="(.+)"\]/)
    return m ? styles.get(m[1]) ?? null : null
  },
}
const documentElement = {
  ...head,
  setAttribute() {},
  removeAttribute() {},
  toggleAttribute() {},
  style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '', getPropertyPriority: () => '' },
}
const documentMock = {
  head,
  documentElement,
  body: { ...head, appendChild() {} },
  querySelectorAll(sel) {
    if (sel === 'style[cssr-id]') return [...styles.values()]
    if (sel.includes('data-dsh-mobile-ui-fix-original'))
      return [...styles.values()].filter(n => n.hasAttribute('data-dsh-mobile-ui-fix-original'))
    return []
  },
  querySelector(sel) {
    const m = sel.match(/style\[cssr-id="(.+)"\]/)
    return m ? styles.get(m[1]) ?? null : null
  },
  createElement() {
    return { textContent: '', setAttribute() {}, appendChild() {}, remove() {}, isConnected: false, style: {} }
  },
  createTextNode(t) { return { textContent: t } },
  getElementById: () => null,
}

const listeners = new Map()
const windowMock = {
  innerWidth: 360,
  innerHeight: 800,
  matchMedia: q => ({
    media: q,
    get matches() { return mediaState[q] ?? false },
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return true },
    onchange: null,
  }),
  addEventListener: (t, f) => { const s = listeners.get(t) ?? new Set(); s.add(f); listeners.set(t, s) },
  removeEventListener: (t, f) => listeners.get(t)?.delete(f),
  dispatchEvent: e => { listeners.get(e.type)?.forEach(f => f(e)); return true },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  Event: class { constructor(t) { this.type = t } },
  MutationObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  performance: { now: () => Date.now() },
  parent: null,
  location: { href: 'http://localhost/' },
  document: documentMock,
  navigator: null,
}

const navigatorMock = {
  maxTouchPoints: 5,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; vivo V2353A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
}

globalThis.window = windowMock
globalThis.document = documentMock
globalThis.Event = windowMock.Event
globalThis.MutationObserver = windowMock.MutationObserver
globalThis.performance = windowMock.performance
globalThis.getComputedStyle = windowMock.getComputedStyle
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => navigatorMock })
windowMock.navigator = navigatorMock
windowMock.parent = windowMock

// ── 模块加载器 ──────────────────────────────────────────────────────────
const registry = new Map()
globalThis.window.__ModuleLoader__ = { load: r => registry.set(r.id, r) }

const reactStub = new Proxy({}, { get: () => () => null })
const jsxStub = new Proxy({}, { get: () => () => null })
const reactDomStub = { createPortal: () => null }

function requireStub(spec) {
  if (spec === 'react')
    return reactStub
  if (spec === 'react/jsx-runtime')
    return jsxStub
  if (spec === 'react-dom')
    return reactDomStub
  throw new Error(`未预期的外部依赖: ${spec}`)
}

function loadBundle(file, id) {
  const code = readFileSync(file, 'utf8')
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports)
  const reg = registry.get(id)
  if (reg === undefined)
    throw new Error(`bundle 没有注册 ${id}`)
  return reg.factory(requireStub)
}

// ── 基线（不装插件）──────────────────────────────────────────────────────
const brokenState = { ...mediaState }
const dshTauri = loadBundle(HOST_CLIENT, 'dsh-tauri')

const beforeMobile = dshTauri.detectMobileDevice()
const MOBILE_QUERIES = dshTauri.MOBILE_MEDIA_QUERIES
const POINTER_QUERIES = dshTauri.MOBILE_POINTER_QUERIES

console.log('上游 MOBILE_POINTER_QUERIES =', JSON.stringify(POINTER_QUERIES))
console.log('上游 MOBILE_MEDIA_QUERIES   =', JSON.stringify(MOBILE_QUERIES))

// 用上游常量构造两条 CSS 头（与 mobile.cssr / settings.cssr 完全一致）
const MOBILE_HEAD = `@media ${MOBILE_QUERIES.join(' and ')}`
const SETTINGS_HEAD = `@media ${POINTER_QUERIES.join(' and ')} and (max-width: 767px)`
const ORIGINAL_MOBILE_CSS = `${MOBILE_HEAD}{html[data-dsh-mobile-sidebar]{overflow:hidden}}`
const ORIGINAL_SETTINGS_CSS = `${SETTINGS_HEAD}{[data-dsh-mobile-settings]{display:flex}}`
makeStyle('dsh-tauri-mobile-ui-styles', ORIGINAL_MOBILE_CSS)
makeStyle('dsh-tauri-mobile-ui-settings-styles', ORIGINAL_SETTINGS_CSS)

// ── 装载插件 ────────────────────────────────────────────────────────────
const fix = loadBundle(FIX, 'dsh-mobile-layout-fix')
const cleanups = []
fix.apply({ effect: run => { cleanups.push(run()) }, on() {} })

const afterMobile = dshTauri.detectMobileDevice()
const mobileCss = styles.get('dsh-tauri-mobile-ui-styles').textContent
const settingsCss = styles.get('dsh-tauri-mobile-ui-settings-styles').textContent

await new Promise(r => setTimeout(r, 1400))

const settledMobile = dshTauri.detectMobileDevice()

let failed = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n       实际=${actual}  期望=${expected}`)
}

console.log('\n--- 结果 ---')
check('修复前 detectMobileDevice()（这台机器上的真实表现）', beforeMobile, false)
check('插件装好后 detectMobileDevice()', afterMobile, true)
check('1.4s 后仍为 true（异步重算稳定）', settledMobile, true)
check('mobile CSS 头已无能力条件', !/pointer|hover/i.test(mobileCss), true)
check('mobile CSS 头保留了 1023px 门槛', /max-width:\s*1023px/.test(mobileCss), true)
check('settings CSS 头已无能力条件', !/pointer|hover/i.test(settingsCss), true)
check('settings CSS 头保留了 767px 门槛', /max-width:\s*767px/.test(settingsCss), true)

// 桌面分支回归：1440px 且无触摸
const savedWidth = windowMock.innerWidth
const savedTouch = navigatorMock.maxTouchPoints
const savedUA = navigatorMock.userAgent
mediaState['(max-width: 1023px)'] = false
windowMock.innerWidth = 1440
navigatorMock.maxTouchPoints = 0
navigatorMock.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
windowMock.dispatchEvent({ type: 'resize' })
const desktopMobile = dshTauri.detectMobileDevice()
check('桌面端（1440px / 鼠标）不被误判为移动', desktopMobile, false)

// 触屏笔记本：粗指针 + 宽屏 -> 桌面分支
windowMock.innerWidth = 1440
navigatorMock.maxTouchPoints = 5
navigatorMock.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
windowMock.dispatchEvent({ type: 'resize' })
check('触屏笔记本（粗指针 + 宽屏）走桌面分支', dshTauri.detectMobileDevice(), false)

// 还原
windowMock.innerWidth = savedWidth
navigatorMock.maxTouchPoints = savedTouch
navigatorMock.userAgent = savedUA
mediaState['(max-width: 1023px)'] = true
windowMock.dispatchEvent({ type: 'resize' })

// 卸载还原
cleanups.forEach(fn => fn())
check('卸载后 detectMobileDevice() 回到 false', dshTauri.detectMobileDevice(), false)
check('卸载后 mobile CSS 逐字还原', styles.get('dsh-tauri-mobile-ui-styles').textContent === ORIGINAL_MOBILE_CSS, true)
check('卸载后 settings CSS 逐字还原', styles.get('dsh-tauri-mobile-ui-settings-styles').textContent === ORIGINAL_SETTINGS_CSS, true)

console.log('\n--- CSS 头对比 ---')
console.log('修复前:', MOBILE_HEAD)
console.log('修复后:', mobileCss.slice(0, mobileCss.indexOf('{')))
console.log('设置前:', SETTINGS_HEAD)
console.log('设置后:', settingsCss.slice(0, settingsCss.indexOf('{')))

process.exit(failed === 0 ? 0 : 1)
