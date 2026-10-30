# dsh-aurora-theme

此插件由Deepseek模型生成，主要用于DSH的功能和性能测试。
深空极光主题插件（DSH / DeepSeek Harness，Web 界面）。换肤之外自带一个背景图编辑器：从系统文件对话框直选本地图片，实时调节不透明度、亮度、饱和度、模糊、缩放、暗化、填充方式与界面玻璃度。

A DeepSeek Harness plugin that restyles the web UI with a deep-space aurora
palette and adds a live wallpaper editor.

---

## 效果

- **配色**：靛蓝深底 + 青色主色（`#6ee7ff`）+ 紫罗兰辉光；浅色侧为清透冷调。浅色与深色两套同时覆盖。
- **壁纸**：6 个内置预设（极光 / 星云 / 星野 / 晨雾 / 黑曜 / 无），或你自己的图片。
- **界面玻璃**：一个滑块控制所有表面 token 的透明度，让壁纸从界面后面透出来。

## 安装

装进一个 dsh profile。已发布的包：

```sh
dsh plugin --profile web add dsh-aurora-theme
```

从 GitHub 装：

```sh
dsh plugin --profile web add git+https://github.com/aFU-s/dsh-aurora-theme.git
```

从本地目录装（开发用，改动即时可见）：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-aurora-theme
```

然后**重启 profile**（`dsh --profile web`）。安装会把包加进 profile 的
`package.json` 依赖与 `dsh.profile.bundles`，随后包内的 `cordis.patch.yml`
把插件行插入配置树。

卸载：

```sh
dsh plugin --profile web remove dsh-aurora-theme
```

## 使用

**设置 → 极光主题**。

| 分区 | 内容 |
| --- | --- |
| 背景图 | 「选择本地图片…」直开系统对话框；预设按钮；URL 输入；清除 |
| 背景图参数 | 填充方式、位置、不透明度 / 亮度 / 饱和度 / 模糊 / 缩放 / 暗化 |
| 界面玻璃 | 表面不透明度（默认 **0.50**）；极光辉光开关 |
| 字体 | 界面字体族：系统默认 / 无衬线 / 衬线 / 圆体 / 楷体 / 等宽 |

**界面字体**通过在自己的样式表里声明 `body{--dsw-font-family:…}` 实现。平台把这个变量
声明在 `:root` 上、在 `body` 上读取，所以声明在 `body` 就能覆盖全站，不需要 `!important`；
选「系统默认」时不写任何覆盖，完全沿用平台字体栈。

**字号不在这里。** 这个部署已经有官方字号设置（`settings.general.item` 的 `font-size`，
范围 12–17 px），插件刻意不重复提供，避免两个入口写同一个宿主设置而互相打架。

**填充方式怎么选**（图片比例和屏幕不一致时）：

| 选项 | CSS | 表现 |
| --- | --- | --- |
| 铺满 | `cover` | 填满不留白，裁掉溢出的一边 |
| 完整 | `contain` | 整张图可见，允许留白 |
| 拉伸 | `100% 100%` | 不留白不裁边，但会变形 |
| 适应宽度 | `100% auto` | 横图首选，按宽度贴合 |
| 适应高度 | `auto 100%` | 竖图首选，按高度贴合 |
| 平铺 | `auto` + `repeat` | 图案类小图 |

参数记在浏览器 `localStorage`（键 `dsh-aurora-theme/v1`）。

**壁纸图片以 Blob 存进 IndexedDB**（库 `dsh-aurora-theme`，store `wallpaper`）。规格：

- 选中的文件**不做 base64 编码**，原样作为 `File`/`Blob` 存入 IndexedDB
- 样式表里用的是 `URL.createObjectURL()` 生成的 **`blob:` URL**——只有几十个字符
- `localStorage` 里只留一个 `imageStored: true` 指针

为什么这么做：早先的版本把图片转成 base64 data URL，体积膨胀到原图的 ~1.37 倍
（一张 7.4 MB 的 PNG → 约 9.9 MB 的字符串），既超过 `localStorage` 的 ~5 MB 配额，
又要经历一次数百万次迭代的编码、并产生一段近 10 MB 的 CSS 值。`blob:` URL 把整条
链路绕开了，所以单张图片的实际上限只取决于磁盘；代码里的 64 MB 只是防呆。

刷新、重启浏览器、重启 DSH 之后都会自动恢复：加载时参数同步生效，图片异步从
IndexedDB 读回并即时生成新的 `blob:` URL。`blob:` URL 只在生成它的那次页面加载里
有效，所以每次加载都重新生成，旧的在替换时用 `revokeObjectURL` 回收。

两块记录都只存在浏览器本地，不经过 Host，也不写任何文件。点「清除自定义图片」会
连同 IndexedDB 里的字节一起删掉。

## 工作原理

插件由两半组成，通过一个 Cordis 插件行挂载。

**宿主半（`lib/index.js`）是刻意空转的。** 它存在的唯一理由是让插件行存在：
`@deepseek-ai/dsh-client-modules` 扫描宿主 Loader 的条目，收集所有声明了
`dsh.client` 的包，把它们的 `./client` bundle 挂在 `/plugins/<row-id>/client.js`
并组装进 `window.__DSH_BOOT__`。没有行 = 浏览器半永远不会被加载，所以
`cordis.patch.yml` 和 `lib/client.js` 是一起发布的。

**浏览器半（`lib/client.js`）做全部的事**，两层都是可逆的：

1. **主题 token** — 用 `theme.overrideTokens(source, tokens)` 在**当前生效的主题之上**
   叠一层 alias token。它不改注册表、不动基础主题，浅深两套值在一次调用里给全，
   停用时整层撤销。
2. **壁纸** — 插件自己拥有的一个 `<style>`。图片画在 `body::before` 上：

   ```css
   position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
   z-index: -1; pointer-events: none;
   background-attachment: fixed, fixed;
   ```

   三个刻意的选择：

   - `z-index: -1` 让它落在应用 frame 之下，但仍在画布底色之上；
   - **不用 `inset: 0`**。`position: fixed` 一旦因为祖先产生包含块而降级，
     `inset: 0` 会撑成整篇文档那么大，`cover` 随之按文档缩放，滚动就表现为
     在图上平移。`100vw/100vh` 永远是视口尺寸，不依赖这个前提；
   - `background-attachment: fixed` 再加一道保险，把图片锚定在视口而非元素盒。

   界面之所以能透出壁纸，是因为 `--dsw-alias-bg-base` 等表面 token 的 alpha 由
   「表面不透明度」统一驱动；调到 1.00 即回到实心界面。

**所有副作用都由 `ctx.effect` 拥有**，插件行卸载、HMR 换版或进程退出时
`<style>` 元素与 token 层都会被移除。

## 构建

仓库里 `lib/` 是生成物（已 gitignore）。改 `src/` 后：

```sh
npm run build
```

`scripts/build.mjs` 没有依赖：宿主半直接拷贝，浏览器半包进 harness 的客户端
bundle 契约：

```js
window.__ModuleLoader__.load({
  id: "dsh-aurora-theme",
  factory: (require) => { /* CommonJS body */ return module.exports }
})
```

`require` 针对运行时模块表解析（`react` 是 seed word），所以浏览器半保持
CommonJS，`react` 之外的依赖一律通过 `ctx` 拿。

## 兼容性

插件依赖部署的两处契约，升级 DSH 时值得复查：

- **Slot**：`settings.section`（id `aurora-theme`）与 `shell.overlay`
  （id `aurora-glow`）。
- **服务**：客户端 `theme`（`overrideTokens`）与 `slots`（`inject` / `register`）。
- **Token**：覆盖的 13 个 `--dsw-alias-*` / `--dsw-specific-sidebar-fill`
  必须存在且同时接受 light/dark 值。

都不满足时插件安静降级：`theme` 缺失就只上壁纸并在标题旁标注，`slots` 缺失
则整个界面不出现，不会抛错影响宿主。

## 开发调试

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-aurora-theme
```

`link:` 安装指向工作目录。改完 `src/` 跑 `npm run build`，浏览器刷新即可；
装了 `@deepseek-ai/dsh-client-hmr` 时客户端 bundle 重建还能免刷新。

## License

MIT
