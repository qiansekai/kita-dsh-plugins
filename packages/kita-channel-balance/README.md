# kita-channel-balance

把本机 DSH 各 provider（渠道）的**可用余额**常驻显示在 composer 工具行（模型选择器同排），
点开看全部渠道明细。官方 DeepSeek 走 \`/user/balance\`，其余渠道**自动探测**常见中转站的计费端点。

## 组成

| 半 | 文件 | 职责 |
|---|---|---|
| host | \`lib/index.js\` | 现场读 settings 里的渠道定义、按次解析凭据、探测/轮询余额端点，暴露只读快照路由 |
| client | \`lib/client.js\` | composer 胶囊（\`conversation.input.left\`）+ 明细面板（\`shell.overlay\`），轮询快照 |

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | \`/kita-balance/state\` | 聚合快照（client 轮询；命中快照缓存则不重复打上游） |
| POST | \`/kita-balance/refresh\` | 强制重建快照（面板里的「刷新」） |

两个路由都先过同源校验（与 \`kita-dsh-restart\` 同口径）；远程访问经 \`kita-dsh-gateway\` 时另加配对鉴权。

## 渠道来源

1. \`settings.describe()\` 里各条目的 \`providers\` 字典（\`llm-pi-ai\` 等中转站 / 自建反代）
2. \`settings.describe()\` 里形如 \`{ apiKeyEnv, baseURL }\` 的单条配置（官方 DeepSeek 路由，id 归一为 \`deepseek-official\`）
3. 本插件 \`config.channels\`（显式覆盖/追加）

凭据不走配置文件：每次请求按 \`apiKeyEnv\` 经 \`ctx.credentials.resolve(ref)\` 现场解析，
解析不到再退回宿主环境变量；未配置的渠道在 UI 上标「未配置凭据」。**key 不进快照、不进响应体、不落日志。**

官方路由（`llm-deepseek` 声明的 provider `deepseek-official`）**优先读平台钱包**：
`ctx.get('deepseekAccount').getBalance()`（充值余额 + 赠金余额，Host-only）；未登录或查询失败才回退 API key 的 `/user/balance`。
官方路由的 baseURL 在设置里通常为空，此时用 `config.officialBaseURL`（默认 `https://api.deepseek.com/anthropic`）兜底。

## 余额端点（自动探测，命中后按 provider 缓存 30 分钟）

| 模板 | 请求 | 取值 |
|---|---|---|
| \`deepseek\` | \`GET {root}/user/balance\` | \`balance_infos[].total_balance\`（优先 CNY） |
| \`newapi\` | \`GET {root}/v1/dashboard/billing/subscription\` + \`/usage\` | \`hard_limit_usd - total_usage/100\` |
| \`moonshot\` | \`GET {root}/v1/users/me/balance\` | \`data.available_balance\` |
| \`credit-grants\` | \`GET {root}/dashboard/billing/credit_grants\` | \`total_available\` |
| 自定义 | \`config.channels[].balanceUrl\` | \`format\` 指定解析器，缺省按已知字段名宽松取数 |

\`root\` = provider 的 \`baseURL\` 剥掉协议后缀（\`/v1\`、\`/anthropic\`、\`/v1beta\`、\`/openai\`、\`/beta\`）。
探测顺序按 hint 排：host 命中 \`officialHosts\`（默认 \`api.deepseek.com\`）或 provider 名含 deepseek → \`deepseek\` 优先；
其余先 \`newapi\`，再 \`credit-grants\`。返回 JSON 但没有余额字段 = 不是余额端点，继续试下一个；
返回鉴权错误 = 端点存在但 key 不认（状态 \`auth\`，UI 显示「鉴权失败」而不是假装没端点）。

## 配置

\`\`\`yaml
- id: 'kita-channel-balance'
  name: 'kita-channel-balance'
  config:
    refreshIntervalMs: 60000      # 上游轮询间隔（client 跟随同节奏）
    requestTimeoutMs: 8000        # 单个上游请求超时
    endpointCacheMs: 1800000      # 端点模板命中后的缓存时长
    officialHosts: ['api.deepseek.com']
    channels:                     # 可选：显式覆盖/追加
      - provider: 'newapi'
        currency: 'CNY'           # 该站点按人民币展示时钉住币种
      - provider: 'some-relay'
        baseURL: 'https://relay.example.com/v1'
        apiKeyRef: 'SOME_RELAY_KEY'
        balanceUrl: 'https://relay.example.com/api/user/balance'
        format: 'generic'
\`\`\`

## 装配与生效

1. 本包通过 pnpm workspace junction 挂在 web profile：
   \`home/profiles/web/node_modules/kita-channel-balance -> home/profiles/web/plugins-src/kita-channel-balance\`
2. profile patch 里 insert 一行 \`- id: 'kita-channel-balance'\`（见 mono repo README 的装配节）
3. **新增客户端 entry 会改变启动图 ⇒ 必须重启 dsh web**（硬刷新不够）

## 已知边界

- 只读：不写任何上游状态；\`/user/balance\` 与计费端点都是无副作用的 GET。
- 快照是**进程内存缓存**，重启后第一拍需要等一次探测（首轮在 apply 后 1.5s 触发）。
- 币种以端点返回为准；端点不带币种时用 \`config.channels[].currency\`，缺省 \`USD\`（Moonshot 缺省 \`CNY\`）。
- 未做鉴权代理：宿主进程直连上游。需要代理时给宿主设 \`HTTPS_PROXY\`。