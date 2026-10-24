/**
 * 单元级验证：用一个假内核跑插件，覆盖判据接管与样式改写。
 *
 * 假内核模拟 vivo V2353A（Android 14 / Chrome 116）的误报组合：
 *
 *   (pointer: coarse)      -> true
 *   (any-pointer: coarse)  -> true
 *   (hover: none)          -> false   ← 误报
 *   (any-hover: none)      -> false   ← 误报
 *
 * 窄视口 360px。上游 `every` 合取判据 -> false（移动布局不激活）；
 * 插件接管后 -> true。
 *
 * 上游常量为能从宿主产物里读到就用产物的值，读不到就退回提交里记录的那组，
 * 这样没装 DSH 的机器也能跑 `npm test`。
 */
import { readFileSync, existsSync } from 'node:fs'
import process from 'node:process'
import { findHostClient, readUpstreamConstants } from './_host.mjs'

const BUNDLE = new URL('../client/bundle.js', import.meta.url)
const source = readFileSync(BUNDLE, 'utf8')

// ── 上游常量 ────────────────────────────────────────────────────────────
const FALLBACK_POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)']
const FALLBACK_BREAKPOINT = 1024

let POINTER_QUERIES = FALLBACK_POINTER_QUERIES
let BREAKPOINT = FALLBACK_BREAKPOINT

const hostClient = findHostClient()
if (hostClient !== null) {
  try {
    const upstream = readUpstreamConstants(readFileSync(hostClient, 'utf8'))
    POINTER_QUERIES = upstream.pointerQueries
    BREAKPOINT = upstream.breakpoint
    console.log(`上游常量来源: ${hostClient}`)
  }
  catch (error) {
    console.log(`读取上游常量失败，退回内置副本: ${error.message}`)
  }
}
else {
  console.log('没找到宿主 dsh-tauri 产物，使用内置的上游常量副本')
}

const MEDIA_QUERIES = [...POINTER_QUERIES, `(max-width: ${BREAKPOINT - 1}px)`]

// ── 极简 DOM ────────────────────────────────────────────────────────────
const styles = new Map()
function makeStyle(id, text) {
  const attrs = new Map([['cssr-id', id]])
  const node = {
    tagName: 'STYLE',
    textContent: text,
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    hasAttribute: name => attrs.has(name),
  }
  styles.set(id, node)
  return node
}

const head = {
  childList: [],
  addEventListener() {},
  removeEventListener() {},
}
const documentMock = {
  head,
  documentElement: { ...head, setAttribute() {}, removeAttribute() {} },
  querySelectorAll(selector) {
    if (selector === 'style[cssr-id]' || selector === 'style[data-dsh-mobile-ui-fix-original]') {
      return [...styles.values()].filter(node =>
        selector.includes('cssr-id') || node.hasAttribute('data-dsh-mobile-ui-fix-original'))
    }
    return []
  },
  createElement() {
    return { setAttribute() {}, append() {}, remove() {}, isConnected: false }
  },
}

// ── 极简 window / navigator ─────────────────────────────────────────────
const listeners = new Map()
const mediaQueryState = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(hover: none)': false,
  '(any-hover: none)': false,
  [`(max-width: ${BREAKPOINT - 1}px)`]: true,
}
const nativeMatchMedia = query => ({
  media: query,
  get matches() {
    return mediaQueryState[query] ?? false
  },
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return true },
})

const windowMock = {
  innerWidth: 360,
  matchMedia: nativeMatchMedia,
  addEventListener: (type, fn) => {
    const set = listeners.get(type) ?? new Set()
    set.add(fn)
    listeners.set(type, set)
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  dispatchEvent: (event) => {
    listeners.get(event.type)?.forEach(fn => fn(event))
    return true
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  Event: class Event {
    constructor(type) { this.type = type }
  },
}

const VIVO_UA = 'Mozilla/5.0 (Linux; Android 14; vivo V2353A) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36'
const navigatorMock = { maxTouchPoints: 5, userAgent: VIVO_UA }

globalThis.window = windowMock
globalThis.document = documentMock
// Node 22 自带只读的 navigator，必须 redefine
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => navigatorMock })
globalThis.Event = windowMock.Event
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const everyProbe = match => MEDIA_QUERIES.every(q => match(q))
const before = everyProbe(q => windowMock.matchMedia(q).matches)

// ── 样式表：上游 mobile.cssr 用 MEDIA_QUERIES.join(' and ') 拼 @media 头 ──
const MOBILE_HEAD = `@media ${MEDIA_QUERIES.join(' and ')}`
makeStyle('dsh-tauri-mobile-ui-styles', `${MOBILE_HEAD}{html[data-dsh-mobile-sidebar]{overflow:hidden}}`)
makeStyle('dsh-tauri-mobile-ui-settings-styles', `@media ${POINTER_QUERIES.join(' and ')} and (max-width: 767px){[data-dsh-mobile-settings]{display:flex}}`)

// ── 加载插件 ────────────────────────────────────────────────────────────
let registration = null
globalThis.window.__ModuleLoader__ = { load: r => { registration = r } }

const moduleShim = { exports: {} }
const fn = new Function('require', 'module', 'exports', source)
fn(() => { throw new Error('插件不应 require 任何外部模块') }, moduleShim, moduleShim.exports)

if (registration === null) {
  console.error('FAIL: 插件没有调用 __ModuleLoader__.load')
  process.exit(1)
}
const { name, apply } = registration.factory()
if (name !== 'dsh-mobile-layout-fix') {
  console.error(`FAIL: name 不对 -> ${name}`)
  process.exit(1)
}

apply({
  effect: run => run(),
  on() {},
})

const after = everyProbe(q => windowMock.matchMedia(q).matches)

await new Promise(r => setTimeout(r, 1500))

const finalAfter = everyProbe(q => windowMock.matchMedia(q).matches)

const mobileCss = styles.get('dsh-tauri-mobile-ui-styles').textContent
const settingsCss = styles.get('dsh-tauri-mobile-ui-settings-styles').textContent
const mobileOk = !/pointer|hover/i.test(mobileCss) && new RegExp(`max-width:\\s*${BREAKPOINT - 1}px`).test(mobileCss)
const settingsOk = !/pointer|hover/i.test(settingsCss) && /max-width:\s*767px/.test(settingsCss)

const wr = typeof Promise.withResolvers === 'function'

// 桌面端不应该被接管
let desktopOwned = null
{
  const savedWidth = windowMock.innerWidth
  const savedTouch = navigatorMock.maxTouchPoints
  const savedUA = navigatorMock.userAgent
  windowMock.innerWidth = 1440
  navigatorMock.maxTouchPoints = 0
  navigatorMock.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  windowMock.dispatchEvent({ type: 'resize' })
  desktopOwned = everyProbe(q => windowMock.matchMedia(q).matches)
  windowMock.innerWidth = savedWidth
  navigatorMock.maxTouchPoints = savedTouch
  navigatorMock.userAgent = savedUA
  windowMock.dispatchEvent({ type: 'resize' })
}

// 触屏笔记本：粗指针 + 宽屏，也应走桌面分支
let touchLaptopOwned = null
{
  windowMock.innerWidth = 1440
  windowMock.dispatchEvent({ type: 'resize' })
  touchLaptopOwned = everyProbe(q => windowMock.matchMedia(q).matches)
  windowMock.innerWidth = 360
  windowMock.dispatchEvent({ type: 'resize' })
}

const rows = [
  ['上游 every 判定（修复前）', before, 'false'],
  ['插件接管后 every 判定', after, 'true'],
  ['1.5s 后（异步重算）every 判定', finalAfter, 'true'],
  ['mobile.cssr @media 头已去能力条件', mobileOk, 'true'],
  ['settings.cssr @media 头已去能力条件', settingsOk, 'true'],
  ['Promise.withResolvers 可用', wr, 'true'],
  ['桌面端（1440px / 无触摸）不被接管', desktopOwned, 'false'],
  ['触屏笔记本（粗指针 + 宽屏）不被接管', touchLaptopOwned, 'false'],
]

let failed = 0
for (const [label, actual, expected] of rows) {
  const ok = String(actual) === expected
  if (!ok)
    failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}（期望 ${expected}）`)
}

console.log('\n--- mobile CSS 头 ---')
console.log(mobileCss.slice(0, 90))
console.log('--- settings CSS 头 ---')
console.log(settingsCss.slice(0, 90))

process.exit(failed === 0 ? 0 : 1)
