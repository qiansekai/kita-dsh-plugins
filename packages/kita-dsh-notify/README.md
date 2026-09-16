# kita-dsh-notify

会话**完成**或**出错**时弹一条 Windows 桌面通知。Host 侧实现，**不依赖浏览器页面**。

## 为什么不是浏览器通知

dsh 官方没有任何浏览器通知能力（0.1.6-alpha.1 前端 bundle 里 `Notification` 与 `serviceWorker` 出现次数均为 0，实测）。

自研 Client 插件可以补上这一块 —— `window.__ModuleLoader__.load` 运行在真实页面 realm，`window` / `document` / `Notification` 都可达，
授权后 `new Notification(...)` 确实能弹出（2026-09-16 实测通过）。

但它有一个**结构性缺陷**：Client 插件按 Session 挂载，用户切到别的会话时插件即被卸载 —— 而「任务完成提醒」恰恰要在用户不看该会话时才有用。
于是同样条件下 Host 侧观察 + 系统 toast 是唯一能覆盖该场景的形态，本插件据此实现。

## 行为

| 时机 | 条件 | 通知 |
|---|---|---|
| `api-session/status` 由 `running` 变 `false` | 运行时长 ≥ `minRunningMs` | `titleComplete` |
| `api-session/error` | 非子代理会话 | `titleError` |

正文格式：`<cwd 末段> · <sessionId 前 8 位> · <时长>`，便于区分并行运行的多个会话。

## 实现要点

- 用 `ctx.shell` 起一个 `powershell.exe` 进程，脚本经 **UTF-16LE base64 `-EncodedCommand`** 传递，因此 CJK 标题与含空格路径不会在引号或控制台代码页上损坏。
- 必须用 **Windows PowerShell 5.1**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）：PowerShell 7 没有 WinRT 投影，
  直接调 `Windows.UI.Notifications` 会报 `Unable to find type [Windows.UI.Notifications.ToastNotificationManager, ... ContentType=WindowsRuntime]`。
- toast 的 AppUserModelID 默认取 Windows 已注册的 Windows PowerShell AUMID，因此**不需要**额外的开始菜单快捷方式；
  换成本机其它 AUMID 属于部署值，写进配置而不是代码。
- 非 Windows 平台直接跳过并在日志里说明。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifyOnComplete` | `true` | 完成通知 |
| `notifyOnError` | `true` | 出错通知 |
| `excludeSubagentSessions` | `true` | 跳过声明了 parent 或 `origin: 'subagent'` 的会话 |
| `minRunningMs` | `5000` | 短于此时长的运行不通知（降噪） |
| `powershellPath` | `''` | 空则由 `%SystemRoot%` 推导 |
| `appId` | Windows PowerShell AUMID | toast 来源标识 |
| `titleComplete` / `titleError` | `DSH 任务完成` / `DSH 会话出错` | 通知标题 |
| `timeoutMs` | `20000` | toast 进程超时 |
| `sandboxMode` | `danger-full-access` | toast 进程的沙箱策略；只在渲染本地通知，可收紧 |
| `workspaceRoot` | `''` | 空则用 dsh 进程工作目录 |

## 装配

1. 包目录进 profile 的 `plugins-src/`，并在 `pnpm-workspace.yaml` 的 `packages:` 增列 `plugins-src/kita-dsh-notify`；
2. profile 的 `package.json` 依赖加 `"kita-dsh-notify": "workspace:*"`；
3. `node_modules/kita-dsh-notify` 建 junction 指向 `plugins-src/kita-dsh-notify`（hoisted linker 下这与 `pnpm install` 的产物一致，
   因此**装配时不必跑 `pnpm install`** —— dsh web 运行时严禁重建 node_modules）；
4. profile 的 `cordis.patch.yml` 插行：

```yaml
- insert:
    - id: 'kita-dsh-notify'
      name: 'kita-dsh-notify'
```

5. **重启 dsh web**（host 侧改动，不重启不生效）。

## 验证

启动日志里应有：

```
[kita-dsh-notify] ready (complete=true error=true skipSubagents=true minRunningMs=5000)
```

每发一条通知会记 `[kita-dsh-notify] notified: <标题> — <正文>`；失败记 `toast failed (exit ...)`。

## 限制

- 只覆盖桌面端；手机 / 远程浏览器不弹（也不打算用浏览器通知补，理由见上）。
- 依赖 Windows 通知中心被允许（专注助手 / 通知设置可能拦截 toast）。
- 子代理会话过滤默认开启，`minRunningMs` 默认 5 秒 —— 两者共同决定“什么样的任务值得弹”。
