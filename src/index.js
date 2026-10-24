/**
 * dsh-mobile-layout-fix — host 半侧入口。
 *
 * 本插件没有任何服务端逻辑：全部修复都发生在浏览器里（patch `matchMedia`、
 * 改写 cssr 输出的 `@media` 头、补 `Promise.withResolvers`）。
 *
 * 之所以仍需要这个入口：`cordis.patch.yml` 的 insert 行指向本包，
 * 宿主需要一个可加载的 host 入口来承载这一层 bundle。apply 是空实现。
 *
 * 浏览器半侧见 `client/index.js`（构建产物 `client/bundle.js`）。
 */

const name = 'dsh-mobile-layout-fix'

function apply() {}

export { apply, name }
