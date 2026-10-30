# kita-office-preview

DeepSeek Harness (dsh) Web 右侧栏文件预览的 Office 渲染器：在「文件」标签页里直接打开
Word（`.docx`）、Excel（`.xlsx`）、PowerPoint（`.pptx`），不再需要下载后另开应用。

## 为什么需要它

产品自带的 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 只渲染
Markdown、代码、图片、PDF、HTML 与纯文本。且它的候选判定逻辑把

```js
const matched = matchingDocumentPreviews(definitions, path)
if (matched.length > 0 && binaryDocumentPath(definitions, path)) return matched
if (matched.length === 0 && unviewable) return matched   // ← Office 走这里
```

`doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp` 全在它的 `UNVIEWABLE_BINARY_EXTENSIONS`
硬编码列表里，于是在没有任何 renderer 认领时显示「不支持」占位，**连文件都不会去读**。

它是可扩展的：只要同时满足「注册了匹配后缀的实现」与「把这些后缀声明为 binary」，
上述两个分支都为真，候选直接落到我们的 renderer —— **不需要改官方包**（改了会在
dsh 升级时丢，本机已有 11 条这类源码补丁，不再增加）。

## 架构

```
src/client/index.ts      注册 definition（后缀 / binaryExtensions / bytes-complete）
src/client/OfficeBody.tsx 渲染 body：按后缀分派到三个库，含错误态与卸载清理
build.mjs                esbuild 打包 + 两个兼容插件（见下）
lib/index.js             host 半边（空 apply，只为出现在 Loader 里）
lib/client.js            浏览器半边（产物，被 git 跟踪以便生产直接装配）
```

内容不由本插件读取：definition 声明 `loading: 'bytes-complete'`，官方预览会用
`remote.workspaceFiles.readAll` 读完整文件再交给 body，因此这里只做「字节 → DOM」。

### 三个渲染引擎

| 后缀 | 库 | 入口 |
|---|---|---|
| `.docx` `.docm` | `docx-preview` | `renderAsync(bytes, host)`，自带样式注入 |
| `.xlsx` `.xlsm` | `@js-preview/excel` | `init(host).preview(bytes)`，需注入其 CSS |
| `.pptx` `.pptm` | `pptx-preview` | `init(host, {width,height,mode}).preview(arrayBuffer)` |

### 两个构建兼容点（build.mjs）

1. **`@js-preview/excel` 只有 UMD 是浏览器版**。包清单的 `main` 指向
   `lib/index.js`（node 版 ESM，顶层无条件 `import 'stream'/'events'/'buffer'/'util'`），
   且没有 `browser` 字段可供选择。构建时把 `lib/index.umd.js` 复制成 `.cjs`
   再解析，esbuild 才会走 UMD 的 `module.exports` 分支而不是 `require("stream")` 分支。
2. **node 内置 stub**。上述 UMD 内联的 lodash 带一处 `require("util").types`
   特性探测，处在 `module`/`require` 存在性判断加 try/catch 之内，浏览器不会走到，
   但 esbuild 会静态解析它（CJS 中 try/catch 内的 require 被保留）。提供一个空 stub
   把这件事显式记录下来。

## 构建

```
npm install
npm run build        # → lib/client.js
```

产物是一个客户端模块系统的 CJS bundle，形如
`window.__ModuleLoader__.load({ id, factory })`。**第三方库必须内联**：client bundle
的 `require` 只解析 seed 词（`react`、`react/jsx-runtime`、`url`）与已注册的 module-graph
行，普通 npm 包不在模块表里，`react` 因此保持 external、其余全部打包进来（约 3.0 MB）。

## 装法与版本要求

要求 DSH `0.2.1-rc.2`（`@deepseek-ai/dsh`），宿主提供 `@deepseek-ai/cordis ~4.0.5`
（已声明为 peerDependency，随 dsh 发布）。**拿到包不需要跑构建**：`lib/client.js`
（约 3.0 MB 的客户端 bundle）已随包入库。

朋友安装（bundle 形态，推荐）：

```
dsh plugin --profile web add <本仓库路径>/packages/kita-office-preview
```

再把包名 `kita-office-preview` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组，
profile 会装配本包自带的 `cordis.patch.yml`（insert 行 id 与 name 都是包名）；
本仓库根 `node scripts/install.mjs --only kita-office-preview` 会一次做完这两步。

**新增客户端 entry 会改变启动图，装完必须重启 dsh web 才生效**（仅硬刷新不够）。

本机开发装配（pnpm workspace junction）：包通过 junction 挂到 profile 的 `node_modules`，
再在 profile 的 `cordis.patch.yml` 里插入 `- id: 'kita-office-preview'` / `name: 'kita-office-preview'`。

## 配置项

本包**没有配置项**：host 半是空 apply（只为出现在 Loader 里），client 半认领哪些后缀由
`src/client/index.ts` 的 `EXTENSIONS` 常量决定。文件读取上限也不归本包管 —— 走官方
`readAll`，受宿主 `maxFileBytes`（默认 32 MiB）限制。

## 已知边界

- **只做只读预览**，没有编辑与搜索。
- **旧版二进制格式不支持**：`.doc` / `.xls` / `.ppt` 不是 OOXML 包，浏览器端没有库能解析。
  这些后缀仍被本插件认领，目的是给出「请另存为 .docx/.xlsx/.pptx」的明确提示，
  而不是产品的通用「不支持」占位。`.odt` / `.ods` / `.odp` 同理。
- **整包读取上限**：走 `readAll`，受 Host `maxFileBytes` 限制（默认 32 MiB），
  超限是拒绝而非截断。超大表格/演示需要调高该配置。
- **保真度**：xlsx 以数据与基本样式为主，图表/条件格式等不保证；pptx 复杂版式可能偏移；
  宏（VBA）一律不执行。要求像素级保真应改用 LibreOffice 转 PDF 的路线。
- **体积**：约 3.0 MB 打进客户端 bundle（其中 echarts 约 1 MB，供 pptx 图表使用）。

## 许可

MIT。三个渲染库各自许可：`docx-preview` Apache-2.0、`@js-preview/excel` MIT、
`pptx-preview` MIT（含 echarts Apache-2.0）。
