// dsh-mobile-layout-fix
//
// 修复 dsh-tauri-mobile-ui / dsh-tauri 在「误报 hover 能力」的 WebView 上
// 不激活移动布局的问题（vivo V2353A、Android 14 / Chrome 116 一类老内核）。
//
// ── 为什么上游那次修复没生效、反而更糟 ─────────────────────────────────
// 上游 #1149 只把三条判据里的第一条从 `(hover: none)` 换成了 `(pointer: coarse)`，
// 但 MOBILE_POINTER_QUERIES 仍是 `every` 合取：
//
//     ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)']
//
// 这些内核对 `(hover: none)` 与 `(any-hover: none)` 是**同时**误报的（原 commit
// message 自己就写了 `(any-hover: hover)`），所以只换第一条等于没换：`every`
// 仍然死在 `(any-hover: none)` 上，移动布局整体不激活。同一个常量又被拼进两条
// CSS 的 @media 头（1023px 侧栏表、767px 设置表），于是 CSS 侧一并失效。
// 换句话说：写进注释的「hover 不参与 `every`」和真正落地的代码不是一回事。
//
// ── 本插件做什么 ──────────────────────────────────────────────────────
// 判据收敛到「主指针是否触摸」这一个语义，hover 能力不再能否决移动布局：
//
//   1. matchMedia 兜底：触摸设备 + 窄视口时，把 `(hover: none)` /
//      `(any-hover: none)` 视为 true；若内核连 `(pointer: coarse)` 都报了 false
//      （彻底坏掉的内核），也一并兜底。可见的 `(pointer: coarse)` 报 true 时
//      不覆盖，桌面分支语义保持不变。
//   2. 样式表改写：@media 头由内核自己解析，JS 侧兜底管不到，所以把 cssr 输出
//      的能力条件换成真正的宽度门槛——只在「触摸 + 窄屏」时改写，且必须带宽度
//      条件，否则不碰，避免把能力查询退化成 `all` 而全站套用。
//   3. Promise.withResolvers：WebView < Chrome 119 缺该 API，会话控制器在
//      类字段里求值它，缺失即抛 TypeError，点会话没反应。补等价实现。
//
// 全部改动在卸载时逐字还原，不污染全局。

const name = 'dsh-mobile-layout-fix'
// 不注入任何服务：本插件只 patch 全局 matchMedia / 样式表，
// 不消费别的插件的 cordis 服务。写成插件 id 会让入口永远 pending
// （inject 认的是服务名，如 slots / layout / locale / sessions）。
const inject = []

/** 与 dsh-tauri 的 MOBILE_BREAKPOINT 保持一致。 */
const BREAKPOINT = 1024
const TOUCH_UA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i
const POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)']
const HOVER_QUERIES = ['(hover: none)', '(any-hover: none)']
/** 一条 @media 头里的设备能力子句（pointer / hover 家族）。 */
const CAPABILITY = /\(\s*(?:any-)?(?:pointer|hover)\s*:\s*[^)]*\)/gi
const WIDTH = /\(\s*(?:max|min)-width\s*:[^)]*\)/gi
const ORIENTATION = /\(\s*orientation\s*:[^)]*\)/gi

function normalize(query) {
  return typeof query === 'string' ? query.replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

function isTouchDevice() {
  try {
    const nav = typeof navigator === 'undefined' ? null : navigator
    if (nav === null)
      return false
    if ((nav.maxTouchPoints ?? 0) > 0)
      return true
    if ((nav.msMaxTouchPoints ?? 0) > 0)
      return true
    return TOUCH_UA.test(nav.userAgent ?? '')
  }
  catch {
    return false
  }
}

function isNarrow() {
  return typeof window !== 'undefined' && window.innerWidth < BREAKPOINT
}

/** 只在「触摸 + 窄屏」时接管判据；桌面分支一律不动。 */
function shouldOwn() {
  return isTouchDevice() && isNarrow()
}

// ── 1. matchMedia ──────────────────────────────────────────────────

/** 被强制为 true 的查询（规范化后）。 */
const forced = new Set()
/** 规范化查询 -> 包装后的 mql，保持对象身份稳定，免得订阅者重复挂监听。 */
const wrappers = new Map()
let installed = false
let nativeMatchMedia = null

/**
 * 包装一条 mql：`matches` 在接管期内被拉成 true，其余成员转发给原生对象，
 * 所以 `addEventListener` / `addListener` 的订阅者仍然收到真实 change。
 */
function wrap(mql, key) {
  return {
    __source: mql,
    media: mql.media,
    onchange: null,
    get matches() {
      return forced.has(key) ? true : mql.matches
    },
    addEventListener: (...args) => mql.addEventListener(...args),
    removeEventListener: (...args) => mql.removeEventListener(...args),
    addListener: listener => mql.addListener?.(listener),
    removeListener: listener => mql.removeListener?.(listener),
    dispatchEvent: event => mql.dispatchEvent(event),
  }
}

/** 原生是否已经认为存在粗指针（真机上的正常情况）。 */
function nativeCoarse() {
  if (nativeMatchMedia === null)
    return false
  try {
    return POINTER_QUERIES.some(query => nativeMatchMedia(query).matches)
  }
  catch {
    return false
  }
}

/** 重算 takeover 集合，返回是否发生变化。 */
function refreshForced() {
  const own = shouldOwn()
  // hover 误报是已知的坏点，接管期一律兜底；
  // 指针只在「内核连粗指针都不认」时才替它答，正常设备保留原生语义。
  const enablePointer = own && !nativeCoarse()
  const next = new Set()
  if (own) {
    for (const query of HOVER_QUERIES)
      next.add(query)
    if (enablePointer) {
      for (const query of POINTER_QUERIES)
        next.add(query)
    }
  }

  let changed = false
  for (const query of next) {
    if (!forced.has(query))
      changed = true
  }
  for (const query of forced) {
    if (!next.has(query))
      changed = true
  }
  forced.clear()
  for (const query of next)
    forced.add(query)
  return changed
}

function patchMatchMedia() {
  if (installed)
    return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return

  installed = true
  nativeMatchMedia = window.matchMedia.bind(window)
  window.__dshMobileUiFixNativeMatchMedia = nativeMatchMedia

  window.matchMedia = function (query) {
    const mql = nativeMatchMedia(query)
    const key = normalize(query)
    if (!POINTER_QUERIES.includes(key) && !HOVER_QUERIES.includes(key))
      return mql
    const cached = wrappers.get(key)
    if (cached !== undefined && cached.__source === mql)
      return cached
    const wrapper = wrap(mql, key)
    wrappers.set(key, wrapper)
    return wrapper
  }

  window.__dshMobileUiFixMatchMedia = true
  refreshForced()
}

function unpatchMatchMedia() {
  if (!installed)
    return
  installed = false
  wrappers.clear()
  forced.clear()
  if (nativeMatchMedia !== null && window.matchMedia !== nativeMatchMedia)
    window.matchMedia = nativeMatchMedia
  nativeMatchMedia = null
  delete window.__dshMobileUiFixNativeMatchMedia
  delete window.__dshMobileUiFixMatchMedia
}

// ── 2. 样式表 ──────────────────────────────────────────────────────

/**
 * 把一条 @media 头重写成只由宽度/朝向决定。
 * 返回 null 表示「不该改写」——没有宽度条件时宁可不动，避免退化成 `all`。
 */
function rewriteMediaHead(condition, own) {
  const widths = condition.match(WIDTH) ?? []
  const orientations = condition.match(ORIENTATION) ?? []
  if (own)
    return widths.length + orientations.length === 0 ? null : [...widths, ...orientations].join(' and ')
  // 非接管期：只摘掉 hover 子句，指针条件原样保留，尽量少扰。
  const kept = (condition.match(CAPABILITY) ?? []).filter(part => !/hover/i.test(part))
  if (kept.length + widths.length === 0)
    return null
  return [...kept, ...widths].join(' and ')
}

function rewriteStyleText(text, own) {
  if (typeof text !== 'string' || !/pointer|hover/i.test(text))
    return null
  let touched = false
  const next = text.replace(/@media([^{]*)\{/gi, (whole, condition) => {
    if (!/pointer|hover/i.test(condition))
      return whole
    const head = rewriteMediaHead(String(condition), own)
    if (head === null)
      return whole
    touched = true
    return `@media ${head}{`
  })
  return touched ? next : null
}

function patchStyles(own) {
  if (typeof document === 'undefined')
    return false
  let changed = false
  for (const style of document.querySelectorAll('style[cssr-id]')) {
    const id = style.getAttribute('cssr-id') ?? ''
    if (!id.startsWith('dsh-tauri-mobile-ui'))
      continue
    const next = rewriteStyleText(style.textContent, own)
    if (next === null || next === style.textContent)
      continue
    // 记下原文，卸载时逐字还原
    if (!style.hasAttribute('data-dsh-mobile-ui-fix-original'))
      style.setAttribute('data-dsh-mobile-ui-fix-original', style.textContent)
    style.textContent = next
    changed = true
  }
  return changed
}

function restoreStyles() {
  if (typeof document === 'undefined')
    return
  for (const style of document.querySelectorAll('style[data-dsh-mobile-ui-fix-original]')) {
    const original = style.getAttribute('data-dsh-mobile-ui-fix-original')
    if (original !== null)
      style.textContent = original
    style.removeAttribute('data-dsh-mobile-ui-fix-original')
  }
}

// ── 3. Promise.withResolvers ───────────────────────────────────────

let shimmed = null

function installWithResolvers() {
  const P = typeof Promise === 'function' ? Promise : null
  if (!P || typeof P.withResolvers === 'function')
    return
  const impl = function withResolvers() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  try {
    Object.defineProperty(P, 'withResolvers', { configurable: true, writable: true, value: impl })
    shimmed = impl
  }
  catch (error) {
    console.warn('[dsh-mobile-layout-fix] Promise.withResolvers shim 安装失败', error)
  }
}

function uninstallWithResolvers() {
  const P = typeof Promise === 'function' ? Promise : null
  const owned = shimmed
  shimmed = null
  if (!P || owned === null)
    return
  if (P.withResolvers === owned) {
    try {
      delete P.withResolvers
    }
    catch {
      /* 某些内核 delete 失败；留着等价实现无害 */
    }
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────

/** 判据或样式状态变了就通知原插件重算：它靠 change / resize 收敛。 */
function resync() {
  const changed = refreshForced()
  patchStyles(shouldOwn())
  if (changed && typeof window !== 'undefined')
    window.dispatchEvent(new Event('resize'))
  return changed
}

/**
 * 安装全部接管逻辑，返回还原函数。
 * 安装发生在 effect 的 setup 里，所以 dispose 之后再次 apply（模块重载）
 * 能重新装一遍；而 factory 求值时的那次 patchMatchMedia 保证 dsh-tauri
 * 第一次算判据之前就已经就位。
 */
function install() {
  installWithResolvers()
  patchMatchMedia()
  refreshForced()
  patchStyles(shouldOwn())

  const onResize = () => {
    resync()
  }
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('orientationchange', onResize, { passive: true })

  // 原插件在它自己 apply 时挂样式，重载还会换标签；持续盯着。
  let observer = null
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      patchStyles(shouldOwn())
    })
    observer.observe(document.head ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  // 原插件可能已经按旧判据算过状态；补几次重算覆盖异步挂载。
  const timers = [0, 60, 300, 1200].map(delay => window.setTimeout(() => resync(), delay))

  return () => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    observer?.disconnect()
    for (const timer of timers)
      window.clearTimeout(timer)
    restoreStyles()
    unpatchMatchMedia()
    uninstallWithResolvers()
  }
}

function apply(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  if (ctx && typeof ctx.effect === 'function')
    ctx.effect(install)
  else if (ctx && typeof ctx.on === 'function')
    ctx.on('dispose', install())
  else
    install()
}

// factory 求值比任何 apply 都早：先接管，后面的插件才拿到包装后的 mql。
patchMatchMedia()
