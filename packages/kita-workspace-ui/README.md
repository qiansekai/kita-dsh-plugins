# kita-workspace-ui

`@deepseek-ai/dsh-client-ui-workspace` 的手工 fork（客户端半，纯 web）。官方包在会话行上把操作收进菜单，
且标题被 ellipsis 截断；本 fork 把常用操作直接摆出来：

- 会话行内 `rename` / `fork` / `archive` 按钮常显
- 双击标题直接改名
- 标题完整显示（不截断）

实现方式是把官方构建产物换成自己的 `lib/client.js`，因此**它不是一个可以脱离 dsh 版本独立使用的包**。

## 安装

```powershell
dsh plugin --profile web add link:<仓库绝对路径>/packages/kita-workspace-ui
```

再把 `kita-workspace-ui` 加进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles`。
本包自带的 `cordis.patch.yml` 会**同时停用官方 `ui-workspace` 行**（两个客户端实现抢同一批 slot，
不停用会重复渲染），所以不需要再手改 profile 的 patch。

仓库根 `scripts/install.mjs` 默认**跳过**本包（见下节原因）；确认版本一致时显式安装：

```powershell
node scripts/install.mjs --only kita-workspace-ui
```

## 版本绑定（重要）

`lib/client.js` 是针对 **dsh 0.2.1-rc.2** 的客户端产物，直接 import 该版本内部的 client slot/props 形状。
换到别的 dsh 版本可能表现为：

- 会话列表区域白屏，或整页 `SlotAssemblyError`
- 按钮渲染出来但点击无响应（props 形状变了）

升级 dsh 后正确做法：从新版本的 `@deepseek-ai/dsh-client-ui-workspace` 重新取源码、重新 bundle 出
`lib/client.js`（本仓库的历史做法是用脚本按上游 diff 重基，脚本不在本仓库内）。没重基前，
**不要把它装到版本不同的 dsh 上**，卸载即可恢复官方包（`ui-workspace` 行会跟着恢复）。

## 配置

无配置项。

## 已知限制

- 只覆盖 `ui-workspace` 替换的那部分 UI，官方后续在该组件里加的功能不会自动跟进。
- `README.i18n.yaml` / `README.zh.md` 是上游包自带的多语言文档，与本 fork 无关，保留仅为溯源。
- 客户端产物改动只需硬刷新；但**首次安装**属于新增 client entry，必须重启 dsh web。
