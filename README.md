# dsh-tauri-mobile-ui-fix

> 修复 DSH Tauri 桌面版在部分 Android WebView 上**移动布局完全不激活**的问题。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 这是什么问题

DSH Tauri 的移动端适配靠三条 `matchMedia` 判据**同时成立**才激活：

```ts
// packages/dsh-tauri/src/client/utils/device.ts
const MOBILE_POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)']
return MOBILE_POINTER_QUERIES.every(query => match(query))
```

有一批 Android WebView 内核（vivo V2353A / Android 14 / Chrome 116 这类）对 hover 家族是**成对误报**的——它们同时报 `(hover: hover)` 和 `(any-hover: hover)`，于是 `(any-hover: none)` 恒为 `false`，`every` 直接死在最后一条上。

同一个常量还被拼进两条 CSS 的 `@media` 头：

```css
/* mobile.cssr */   @media (pointer: coarse) and (any-pointer: coarse) and (any-hover: none) and (max-width: 1023px)
/* settings.cssr */ @media (pointer: coarse) and (any-pointer: coarse) and (any-hover: none) and (max-width: 767px)
```

所以 JS 判据和 CSS 样式**一起失效**：侧栏不切移动态，设置面板不变成全屏抽屉，整个移动布局等于没有。

## 上游那版修复为什么没解决

上游 PR #1149 只把三条里的**第一条**换掉了：

```diff
- ['(hover: none)', '(any-pointer: coarse)', '(any-hover: none)']
+ ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)']
```

改动意图是对的（判据收敛到「主指针是否触摸」），但实现只动了一条，`every` 合取结构原样保留。而这批机器误报的恰恰是 hover 家族，`(any-hover: none)` 仍然是否决项，所以：

- `every` 照样返回 `false`，**移动布局仍然不激活**
- 两条 CSS 头的最后一条能力条件也还在，**样式侧同样不生效**
- 更麻烦的是 commit message 和代码注释都写成了「hover 不再参与判据」，与实际落地代码相反，下次照着注释排查会走错方向

要真修好，得把 hover 从判据里彻底拿掉，只留主指针：

```ts
const MOBILE_POINTER_QUERIES = ['(pointer: coarse)']
```

## 这个插件做了什么

三条独立改动，都在卸载时逐字还原：

| # | 改动 | 解决什么 |
|---|---|---|
| 1 | **`matchMedia` 兜底** — 触摸设备（`maxTouchPoints` / UA）+ 视口窄于 1024px 时，把 `(hover: none)` / `(any-hover: none)` 视为 `true`；内核连 `(pointer: coarse)` 都报 `false` 时也一并兜底 | JS 判据恢复为「触摸即移动」 |
| 2 | **样式表改写** — cssr 输出的 `@media` 能力条件换成纯宽度门槛，只在「触摸 + 窄屏」且**确实带宽度条件**时改写 | CSS 侧同步生效，且不会退化成 `all` 全站套用 |
| 3 | **`Promise.withResolvers` 补丁** — WebView < Chrome 119 缺这个 ES2024 API | 会话控制器在类字段里求值它，缺失即抛 `TypeError`，点会话没反应 |

设计上刻意保守：

- **桌面分支零改动**——宽屏或非触摸设备一律不接管，指针语义保持原生
- **只在必要时改写样式**——`@media` 头里没有宽度条件时宁可不碰，避免把能力查询退化成 `all`
- **对象身份稳定**——包装后的 `mql` 按查询串缓存，订阅者不会重复挂监听
- **逐字还原**——样式原文存在 `data-dsh-mobile-ui-fix-original`，卸载时原样写回

## 安装

### 作为 git 插件安装（推荐）

```bash
dsh plugin --profile <profile> add github:vbin-dev/dsh-tauri-mobile-ui-fix
```

`package.json` 里声明了 `dsh.bundle.patch`，装好后 profile 的 `bundles` 会自动带上这一层，无需手工改 `cordis.patch.yml`。

**装完必须完全退出并重启 DSH Tauri。** `dsh-client-modules` 把 `dsh.client` 声明缓存在进程内的 `pkgMeta` Map 里（`resolveMeta` 只读一次 package.json），改完 package.json 不重启，manifest 里还是旧值。

如果安装时卡在别的依赖上（例如国内镜像还没同步某个刚发布的版本），加上官方源重试：

```bash
dsh plugin --profile <profile> add github:vbin-dev/dsh-tauri-mobile-ui-fix --registry=https://registry.npmjs.org
```

### 手动挂载

如果不用 `dsh plugin`，也可以把本包放到 profile 的 `node_modules` 下，然后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-tauri-mobile-ui-fix
      name: dsh-tauri-mobile-ui-fix
```

### 一个容易踩的坑：`inject` 填的是服务名

`dsh.client.inject` 认的是 **cordis 服务名**（`slots` / `layout` / `locale` / `sessions`），不是插件 id。填成插件 id 会让入口永远 `pending`，控制台报 `web boot: 1 entry did not activate`。

本插件不消费任何服务，所以 `inject` 留空——它只 patch 全局 `matchMedia`、样式表和 `Promise`。

## 验证

```bash
npm test        # 判据接管 + 生命周期还原（不需要装 DSH）
npm run test:real   # 真实产物级，需要本机有 dsh-tauri
```

`test:real` 加载**已上线的真实 `dsh-tauri` 产物**，模拟 vivo V2353A 的误报组合，检查 12 项：修复前 `detectMobileDevice()` 为 `false`、装插件后为 `true`、CSS 头去能力条件且保留宽度门槛、桌面端与触屏笔记本不被误判、卸载后样式逐字还原。

`test/verify.mjs` 会自动探测宿主产物位置，也可以用环境变量指定：

```bash
DSH_TAURI_CLIENT=/path/to/dsh-tauri/dist/client.cjs npm run test:real
```

探测顺序：`DSH_TAURI_CLIENT` → `DSH_TAURI_RESOURCES` → Linux 安装包 → macOS 应用包 → 用户级安装 → profile 内链接。

两套脚本都能在没有 DSH 的机器上运行：`npm test` 一组读不到宿主产物时会退回内置的上游常量副本，CI 里就是这么跑的。

## 仓库结构

```
client/index.js          客户端源码（可读，带完整推导注释）
client/bundle.js         构建产物（client-modules bundle 协议）
scripts/build-client.mjs 把 index.js 包成 bundle.js
src/index.js             host 半侧入口（无服务端逻辑）
cordis.patch.yml         bundle patch，装到 profile 时自动插入挂载行
test/                    三组验证脚本 + 宿主产物探测
```

改源码后重新构建，产物与源码逻辑一一对应：

```bash
node scripts/build-client.mjs
```

本插件不依赖 React，也不 require 任何框架模块，所以工厂签名不带 `require`。

## 已知边界

- **只针对误报 hover 的内核**。真正不支持触摸 API 的内核救不回来，`isTouchDevice()` 会返回 `false`。
- **样式改写依赖 `cssr-id`**。只处理 `cssr-id` 以 `dsh-tauri-mobile-ui` 开头的 `<style>`，上游改 id 命名后需要同步更新。
- **不修上游**。这是纯运行时垫片，DSH 升级后如果上游真的修好了（`MOBILE_POINTER_QUERIES` 只剩 `(pointer: coarse)`），本插件会自动变成无害的空操作——它的判据此时本来就是 `true`。可以放心卸载。

## License

MIT
