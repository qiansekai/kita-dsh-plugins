# 插件包规范（对齐 DSH 0.2.1-rc.2 官方 bundle 形态）

本文件是仓库内所有 `packages/*` 的硬性契约。任何人（人或 agent）改包前先读本文件。

判据来源：生产机 `alpha-022` = `@deepseek-ai/dsh@0.2.1-rc.2`，对照样本为该版本随包发布的官方 bundle：
`@deepseek-ai/dsh-experimental-session-titles-bundle`、`@deepseek-ai/dsh-experimental-plugin-market-bundle`。

## 0. 为什么是 bundle

DSH 0.2.x 里一个「插件」要被 GUI / CLI 识别为**可安装单元**，靠的是 `package.json` 的 `dsh.bundle.patch`：
它指向本包自带的 `cordis.patch.yml`，profile 把它加进 `dsh.profile.bundles` 数组后，装配该 patch
（而不是让用户手改 `cordis.patch.yml`）。朋友装插件 = `dsh plugin --profile web add <spec>` + 包名进 bundles。

## 1. package.json 必填形状

```json
{
  "name": "kita-xxx",
  "version": "1.0.0",
  "description": "一句话说明它替换/增强了什么",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/schemastery": "~3.18.5"
  }
}
```

规则：

1. **`dsh.bundle.patch` 必填**，值为 `"./cordis.patch.yml"`，且 `exports` 必须有 `"./cordis.patch.yml"` 键，否则 profile 解析不到 patch。
2. **只有 client 半才写 `dsh.client`**；`inject` 列本包客户端用到的 `@deepseek-ai/dsh-client-*` 服务（缺了运行时报 `cannot get property ... without inject`）。纯 host 包删掉 `dsh.client`。
3. **peerDependencies 用 `@deepseek-ai/cordis`**，范围 `~4.0.5`（0.2.1-rc.2 随包的 4.0.5）。禁止写裸 `cordis`，禁止 `*`。
   `@deepseek-ai/schemastery` 用 `~3.18.5`。其它官方包按 `>=0.2.1-rc.2 <0.3.0-0` 这类区间写，不要钉死到本机私有 patch 版本。
4. **不要 `private: true`**：仓库要能 `npm pack`，朋友也可能直接 `file:` 依赖。私有包只用于本机开发时才另说。
5. `files` 必须覆盖运行时真正需要的文件（`lib`、`cordis.patch.yml`、README、LICENSE），不能漏 patch。
6. 有构建产物 client bundle 的包（如 office-preview），`lib/client.js` 必须**入库**，不能让朋友跑构建。
7. 纯 host 包若不需要 `schemastery`，就只留 `@deepseek-ai/cordis`。
8. `cordis.patch.yml` 的 `config` 只放**可移植默认值**（见第 4 节）。

## 2. cordis.patch.yml 写法

本包插入自己：

```yaml
# <包名> bundle patch：一句话说明
- insert:
    - id: <包名>
      name: '<包名>'
      config:
        <key>: <可移植默认值>
```

**替代/停用官方行时必须显式写 `disabled: true`**，否则官方那行仍会装，两行抢同一个服务：

```yaml
- id: ui-workspace
  disabled: true
```

已确认的替代关系（写到各自包里，不要再靠用户手改 profile patch）：

| 包 | 必须停用的官方行 |
|---|---|
| kita-workspace-ui | `ui-workspace` |
| kita-session-title-auto | `session-title-llm` |
| 其余包 | 无（纯新增） |

`id` 是**装配行的唯一标识**，与包名无关（官方 `session-titles-bundle` 就写作 `optional-session-title-all-prompts`）。
本仓库约定：**`id` 用目录名**（`dsh-quota-retry` 这种包名带 scope 的包也能有短 id），**`name` 必须是包名**，
否则 profile 解析不到模块引用。

### 2.1 客户端半拿不到 config（0.2.1-rc.2 实测）

客户端 runner 是 `loader.create({ name: id })`，**不向客户端半下发 patch 的 `config`**。因此：

- patch `config` 只对 host 半生效。纯客户端插件不要写 `config`（写了也不会被读到，属于谎报可配）。
- 客户端要可调的值，只能走 `localStorage`（如 shell-bridge 的 `kita-shell-bridge.dropzonePort`），
  并在 README 里写明键名与默认值。
- 客户端插件里不要出现「配置项表列出 patch config 键」的写法。

### 2.2 cordis 服务名到官方包的映射（`dsh.client.inject` 用）

`inject` 写的是**客户端服务名对应的官方包名**，不是服务名本身。实测对照：

| client 里 `inject` 的服务 | 要写进 `dsh.client.inject` 的包 |
|---|---|
| `slots` | `@deepseek-ai/dsh-client-ui-renderer` |
| `sessions` | `@deepseek-ai/dsh-api-session-controller` |
| `remote` | `@deepseek-ai/dsh-api-gateway` |
| `remote.session` | `@deepseek-ai/dsh-api-session-controller`（命名空间由它注册）；`remote` 的包同时要列 |
| `conversation` 相关 slot 改动 | `@deepseek-ai/dsh-client-ui-conversation` |

漏写会在运行时报 `cannot get property "x" without inject`；多写官方包无副作用。

## 3. 装配失败必须降级，不许 throw

`apply()` 里任何「本机专属前置条件」缺失时，只允许 `console.log('[<包名>] ... 已禁用/跳过')` 后 return，
**禁止 throw**。理由：throw 会让整个 profile 装配失败，朋友的 GUI 直接打不开 —— 插件最差只该自己不工作。

已加固的两处：
- `kita-dsh-restart`：找不到 `start.ps1` / `active-env.txt` 时不注册计划任务，只记日志。
- `kita-version-check`：找不到 `active-env.txt` 时仍能报运行版本，只是缺部署名。

## 4. 可移植性红线

- 代码里**禁止**出现本机绝对路径（`D:\Kita-Tools`、`C:\Users\...`）、本机用户名、本机环境目录名（`alpha-022`）。
- 机器相关的值走配置项或环境变量，且**默认值必须是通用值或空**：
  - 路径类：默认 `''`，为空即表示「该功能不可用」，README 说明怎么配。
  - 端口类：默认写在 `cordis.patch.yml` 的 `config` 里（用户可改），不要写死在代码常量。
  - 目录探测：允许「两级以上推断」，但推断失败必须降级（第 3 节）。
- 不得要求本机专属外部程序（`start.ps1`、`dropzone.exe`、`cloudflared.exe`）存在才能启动，只要求存在才能用对应功能。

## 5. 每包交付物

1. `package.json`：按第 1 节补齐（`dsh.bundle`、`exports`、peer、files、去掉 private）。
2. `cordis.patch.yml`：按第 2 节新建或修正。
3. `README.md`：必须包含四段 —— 做什么 / 装法与版本要求 / 配置项表（含默认值与「为空时怎样」）/ 已知限制。缺 README 的包补齐。
4. 不新增 `.bak` 文件到仓库（`.gitignore` 已忽略，但别写在 `lib/` 里当产物）。

## 6. 自检（改完必须全过）

在仓库根执行：

```powershell
node scripts/check-packages.mjs
```

该脚本逐包校验：package.json 可解析、必填字段存在、patch 文件存在且可被 `js-yaml` 解析、
patch 里 `id` 与包名一致、`exports` 覆盖 `./cordis.patch.yml`、`lib/` 里无 `.bak`、
`node --check` 语法通过（`lib/index.js`、`lib/client.js`）。

## 7. 安装形态（给朋友的口径）

- 仓库根 `scripts/install.mjs` 负责：探测 profile → `pnpm add file:<本仓库绝对路径>` 每包 → 包名写入
  `dsh.profile.bundles` → 打印「重启 dsh web」提示。可加 `--only <包名,...>` 选择性安装。
- 装完必须重启 dsh web（host 半与新增 client entry 都要重启才生效），本仓库自带
  `kita-dsh-restart` 的侧栏按钮可省这一步（但它本身要重启一次后才出现）。
- 卸载：`scripts/install.mjs --uninstall [--only ...]`。
