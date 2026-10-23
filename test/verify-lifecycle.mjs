/**
 * 生命周期验证：卸载逐字还原、重复 apply 不泄漏监听。
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'

const source = readFileSync(new URL('../client/bundle.js', import.meta.url), 'utf8')

const styles = new Map()
const makeStyle = (id, text) => {
  const attrs = new Map([['cssr-id', id]])
  const node = {
    textContent: text,
    getAttribute: n => attrs.get(n) ?? null,
    setAttribute: (n, v) => attrs.set(n, v),
    removeAttribute: n => attrs.delete(n),
    hasAttribute: n => attrs.has(n),
  }
  styles.set(id, node)
  return node
}
const head = { addEventListener() {}, removeEventListener() {} }
const documentMock = {
  head,
  documentElement: { ...head, setAttribute() {}, removeAttribute() {} },
  querySelectorAll(selector) {
    if (selector === 'style[cssr-id]')
      return [...styles.values()]
    if (selector === 'style[data-dsh-mobile-ui-fix-original]')
      return [...styles.values()].filter(n => n.hasAttribute('data-dsh-mobile-ui-fix-original'))
    return []
  },
}

const listeners = new Map()
const state = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(hover: none)': false,
  '(any-hover: none)': false,
  '(max-width: 1023px)': true,
}
const nativeMatchMedia = q => ({
  media: q,
  get matches() { return state[q] ?? false },
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return true },
})
const windowMock = {
  innerWidth: 360,
  matchMedia: nativeMatchMedia,
  addEventListener: (t, f) => { const s = listeners.get(t) ?? new Set(); s.add(f); listeners.set(t, s) },
  removeEventListener: (t, f) => listeners.get(t)?.delete(f),
  dispatchEvent: e => { listeners.get(e.type)?.forEach(f => f(e)); return true },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  Event: class { constructor(t) { this.type = t } },
}
const navigatorMock = { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14; vivo V2353A) Chrome/116.0.0.0 Mobile Safari/537.36' }

globalThis.window = windowMock
globalThis.document = documentMock
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => navigatorMock })
globalThis.Event = windowMock.Event
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const POINTER = ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)']
const MEDIA = [...POINTER, '(max-width: 1023px)']
const every = m => MEDIA.every(q => m(q))
const ORIGINAL = `@media ${MEDIA.join(' and ')}{html[data-dsh-mobile-sidebar]{overflow:hidden}}`
makeStyle('dsh-tauri-mobile-ui-styles', ORIGINAL)

let registration = null
globalThis.window.__ModuleLoader__ = { load: r => { registration = r } }
const mod = { exports: {} }
new Function('require', 'module', 'exports', source)(() => {}, mod, mod.exports)

const cleanups = []
const ctx = { effect: run => { cleanups.push(run()) }, on() {} }
const api = registration.factory()

let failed = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok)
    failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}（期望 ${expected}）`)
}

api.apply(ctx)
await new Promise(r => setTimeout(r, 1400))
check('接管生效', every(q => windowMock.matchMedia(q).matches), true)
check('样式已改写', styles.get('dsh-tauri-mobile-ui-styles').textContent !== ORIGINAL, true)

// 卸载
cleanups.forEach(fn => fn())
check('卸载后 matchMedia 回到原生语义（不再包装）', windowMock.matchMedia('(hover: none)').matches, false)
check('卸载后 every 判定回到 false', every(q => windowMock.matchMedia(q).matches), false)
check('卸载后样式逐字还原', styles.get('dsh-tauri-mobile-ui-styles').textContent === ORIGINAL, true)
check('卸载后无残留标记属性', styles.get('dsh-tauri-mobile-ui-styles').hasAttribute('data-dsh-mobile-ui-fix-original'), false)

// 重载：apply 两次，检查监听器不泄漏
cleanups.length = 0
api.apply(ctx)
api.apply(ctx)
await new Promise(r => setTimeout(r, 1400))
const resizeCount = listeners.get('resize')?.size ?? 0
check('重复 apply 后 resize 监听数不膨胀', resizeCount <= 2, true)

cleanups.forEach(fn => fn())
check('二次卸载后再次还原', styles.get('dsh-tauri-mobile-ui-styles').textContent === ORIGINAL, true)

process.exit(failed === 0 ? 0 : 1)
