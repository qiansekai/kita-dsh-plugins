# dsh-quota-retry

余额/额度不足 + 凭据类错误的延迟自动重试插件：

- **`QUOTA`**（Insufficient Balance / insufficient quota / credits 耗尽）→ **无界长退避**：
  等充值（默认首次 60s、封顶 30min、不限次数），**而不是让本轮运行直接停下**；
- **`AUTH`**（"API key is invalid" → 401/403 鉴权失败）→ **有界短退避**：
  网关/中继的瞬态鉴权故障值得等一会再试（默认首次 10s、封顶 2min、最多 5 次），
  超过上限仍失败才透传原错误停下——避免无限锤一个真坏的 key。

## 问题

官方 `dsh-llm-retry` 只重试瞬态错误（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
`TIMEOUT` / `TRANSPORT`）。`QUOTA` 和 `AUTH` 都被视为"终态"（一个等充值、一个要换 key），
不在默认重试集合里。于是额度一没 / key 一坏，agent 循环就在 `agent/request-error` 恢复点
放行 → 抛 `LlmError` → **本轮运行直接失败停止**。

## 解决

本插件挂在**同一个恢复扩展点** `agent/request-error` 上（运行时注入，排在官方
llm-retry 之后，只接手它放行的失败）：

1. 检测到匹配错误码 → 先落持久 session 事件 `retry/scheduled`（排程，断点续跑不丢计数），
   再进入**可取消等待**；
2. 等待结束返回 `{ kind: 'retry' }` → agent 循环继续，本轮**挂起而不是停止**；
3. 有界模式（AUTH）超过 `boundedMaxRetries` 次仍失败 → `next()` 透传，本轮照常报错停下；
4. 其余错误码一律 `next()` 透传，不影响既有行为。

期间日志可见：
`[dsh-quota-retry] provider "..." 余额/额度不足（QUOTA: ...）——第 N 次重试将于 Xs 后开始`
`[dsh-quota-retry] provider "..." 凭据/鉴权失败（AUTH: ...）——第 N 次重试将于 Xs 后开始（最多 5 次）`

## 安装

注入器环境内（免重启，重启后由注入器 registry 自动恢复）：

```
dev_inject_plugin <本包路径>
```

或官方装配（重启后由 bundles 接管）：

```
dsh plugin --profile web add <本包路径>
```

卸载：`dev_uninject_plugin dsh-quota-retry`

## 配置（可选）

注入时 config 为 `{}`，全部走默认。需要调整时在装配配置里给 `config` 传：

| 键 | 默认 | 含义 |
|---|---|---|
| `retryCodes` | `["QUOTA"]` | 无界长退避的错误码集合 |
| `initialDelayMs` | `60000` | 无界模式首次等待毫秒（给充值留时间） |
| `maxDelayMs` | `1800000` | 无界模式退避封顶毫秒（30min） |
| `jitterRatio` | `0.2` | 抖动比例 0..1，避免并发恢复同步撞车 |
| `maxRetries` | `0` | 无界模式单步最大重试次数，`0` = 不限 |
| `boundedRetryCodes` | `["AUTH"]` | 有界短退避的错误码集合（`[]` = 禁用该模式） |
| `boundedInitialDelayMs` | `10000` | 有界模式首次等待毫秒 |
| `boundedMaxDelayMs` | `120000` | 有界模式退避封顶毫秒（2min） |
| `boundedMaxRetries` | `5` | 有界模式最大重试次数（超过后仍失败 → 透传原错误停下） |

## 设计

- **零运行时依赖**：纯 ESM、无 import（不引 cordis/schemastery 运行时模块），
  不需要 node_modules junction，无解析/版本漂移风险，DSH 升级不报废；
- **镜像官方 llm-retry 语义**：可取消退避（`AbortSignal.any`）、先落事件再等待、
  重试计数从持久 session 事件推导（同 turn/step/provider 按策略键计数——策略键含
  mode，两种模式互不干扰）、插件热重载时中止在途等待（与官方一致）；
- **资源挂 `ctx.effect`**：fiber dispose 自动注销监听并排空在途等待，卸载即净；
- **供应商 Retry-After 优先**：`failure.providerRetryAfterMs` 存在时以其为准（封顶到该模式 `maxDelayMs`）。

## 验证

注入后可用注入器 staging 区做端到端探针（构造假 session、真实 scope carrier 直接
dispatch `agent/request-error`）：QUOTA 无界排程/等待后返回 `{kind:'retry'}`、
AUTH 有界排程且第 6 次失败透传（次数上限生效）、未匹配错误码透传。
