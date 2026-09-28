# kita-dsh-gateway

配对码鉴权网关：让 `dsh web` 保持 loopback-only，同时在局域网暴露**唯一一个带认证的入口**（默认 :3081），
并支持**扫码即配对**与**一键开启 Cloudflare 快速隧道**（外网用手机）。

## 解决的问题

dsh webserver 只监听 127.0.0.1，手机/其他设备访问不了；直接改绑 0.0.0.0 则完全裸奔。
本插件在两者之间架一道配对鉴权：首次访问先输配对码，换取长期 token
（HttpOnly cookie + Bearer 头），之后所有请求反代回 `127.0.0.1:<targetPort>` 并重写 Host 头，
dsh 看到的是本地客户端（loopback 围栏通过、本地专属功能可用）；WebSocket 升级
（mux/host 事件流）同样反代。

**对抗的威胁**：局域网邻居，以及指向该端口的任意隧道（cloudflared / frp / sakurafrp / ngrok / tailscale）。
**本机管理面**（配对码 / 二维码 / `/admin`）另需一道本机管理令牌，见「本机管理面为什么需要令牌」。
**不防护**：本机已运行的进程（它们能读 token 文件与令牌文件）。

## 装配

依赖 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`。profile `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: kita-dsh-gateway
      name: kita-dsh-gateway
      config:
        port: 3081                    # LAN 入口端口
        targetPort: 3080              # dsh loopback 端口
        codeMinutes: 10               # 配对码有效期（分钟）
        cloudflaredPath: ''           # 空 = 依次查 CLOUDFLARED_PATH、PATH
        tunnelRestartLimit: 5         # 隧道进程意外退出后的自动重启上限
        tunnelProtocol: http2         # 隧道传输：auto | http2 | quic（默认 http2，见下）
        adminToken: ''                # 可选：钉死本机管理令牌（默认自动生成并存盘）
        tunnelStartTimeoutMs: 25000   # tunnel-start 等待公网地址的上限
```

`cloudflaredPath` 是**部署值**（本机路径写配置，不写进代码）：本机 cloudflared 不在 PATH，
故在生产 profile 的 patch 里显式给出。未配置且探测不到时，隧道卡片会显示明确的提示，
其余功能不受影响。

## 扫码即配对

手机扫二维码即完成配对，**不需要手输 6 位数字**：

- 二维码内容 = `http://<LAN-IP>:3081/gateway-pair#k=<当前配对码>`；
- 配对码放在 **URL fragment**：fragment 不发给服务器、不进访问日志、不随 Referer 外泄；
- 配对页读取 fragment 后自动填入并提交，随后 `history.replaceState` 把 fragment 从地址栏抹掉
  （截图或复制链接都不会带出配对码）；
- 配对码随 `codeMinutes` 轮换，二维码同步刷新；若扫码时恰好轮换，页面会提示改用手输最新码。

二维码出现的位置（三处，同一份数据）：

| 位置 | 可见条件 | 说明 |
|---|---|---|
| WebUI「配对」页签 | 桌面/手机页面均可打开 | 大字配对码 + 二维码 + 访问地址候选 + 设备列表 |
| `GET /admin` 本机管理页 | **本机 + 管理令牌** | 配对码 + 二维码 + 设备吊销 + 熔断解锁 |
| `GET /gateway-pair` 配对页 | 二维码区块在**本机 + 管理令牌**下显示 | 电脑上打开该页时可直接扫给手机 |

**远程页面永不携带配对码**：`/gateway-pair` 与 `/gateway-pair/qr.json` 只在
  **本机 + 管理令牌**（见下节）才能渲染二维码；局域网访客与隧道访客拿到的是纯输入框，
  本机但还没拿到令牌的浏览器会被明确告知去哪里取入口链接。`/admin` 整段路径同样要求令牌。

### 本机管理面为什么需要令牌（2026-09-28 事故）

此前「本机」= socket 对端是 loopback，只对 cloudflared 做过例外（认 `CF-Connecting-IP`）。
但 frp / sakurafrp / ngrok 这类隧道**没有**等价头部：frpc 跑在宿主机上，替公网访客从 127.0.0.1 拨入，
于是 `https://<frp 域名>/gateway-pair` 被判成本机页面，二维码与 `/gateway-pair/qr.json` 把当时的 6 位配对码
直接交给公网（实测 `[MEASURED]`：`/admin/code` 亦一并可达）。配对码就是全部鉴权，
等于任何人访问该公网地址都能换到 90 天凭据、拿到 dsh 全权。

修法不是「再认一个头部」——未知隧道在 socket 层与本机浏览器无法区分 —— 而是要求**本机凭据**：
网关首次启动生成 32 字节令牌存进 `storages/kita-dsh-gateway-admin.json`，
本机浏览器打开一次入口链接（`/gateway-pair?a=<令牌>`）换取 HttpOnly cookie，此后本机面才可见。
loopback 仍要求，但降为第二条件：链接被复制到别处也打不开任何东西。

WebUI「配对」页签走同一把尺子：`GET /kita-gateway/panel` 只在本机来源（`entry === local`）返回
`code` / `localPairUrl` / `tunnel.pairUrl`，手机与隧道访客拿到的是空码 + `codeLocalOnly: true` 与一段说明。
**已配对设备不能从自己屏幕上读走配对码** —— 那是把 90 天凭据再分发出去的唯一入口。
2026-09-20 修复的正是这一条：此前该路由无条件返回配对码，一个已配对手机打开页签即可看到 `[MEASURED]`。

配对页本身也会识别身份：带着有效 cookie 打开 `/gateway-pair` 时显示「这台设备已经配对过了」+ 进入 dsh，
而不是再让你输一遍码。

## 手机该连哪个地址

主机常有多张网卡（本机实测 12 张，其中 5 张是虚拟的）。候选地址按「物理网卡优先 → 与最近活跃设备同 /24 →
网段」排序，**每条都带网卡名**，虚拟网卡另外挂「虚拟网卡」标记：

| 排序因素 | 说明 |
|---|---|
| 物理 / 虚拟 | VMware、VirtualBox、Hyper-V、Radmin、Tailscale、蓝牙、`本地连接*`（Wi-Fi Direct / 移动热点）一律判为虚拟，排在**所有**物理网卡之后 |
| 同 /24 | 与最近活跃设备同网段的候选 +200 分 —— 手机的所在网段就是那一个 |
| 网段 | 192.168/16 (+60) > 10/8 (+40) > 172.16/12 (+15) > 其余 (+5)；VirtualBox host-only 另有 −50 |

**2026-09-20 的修复动机** `[MEASURED]`：修复前只按网段排序，于是 `VMnet8 (192.168.159.1)` 被标成「建议」排第一，
而唯一手机能连的 `WLAN (10.60.139.207)` 排在最后 —— 用户照「建议」连必然失败。虚拟网卡不会被丢弃
（手机可能真的在热点或 VPN 网段里），只是永远排在物理网卡之后。

## 一键 Cloudflare 隧道

面板上的「一键开启 CF 隧道」按钮（`POST /kita-gateway/panel { "action": "tunnel-start" }`）会拉起
`cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`，即 Cloudflare Quick Tunnel：
零配置、无需 CF 账号、随机 `https://<words>.trycloudflare.com` 域名，进程退出即失效。
隧道建立后卡片显示公网地址、开启时间、公网二维码（同样内嵌配对码）与关闭按钮；
进程意外退出会按 `tunnelRestartLimit` 自动重启，插件卸载/重载时隧道一并关闭。

**「就绪」判定**：cloudflared 先打印 hostname，几秒后才打印 `Registered tunnel connection`；
在两者之间公网请求会被边缘回 **HTTP 530**。因此 `tunnel-start` 等到注册行出现
（最多 `READY_GRACE_MS` = 5s 的宽限）才返回，面板按钮在此期间显示「正在开启…」——
否则用户会扫到一个 530 页面。

**传输协议（`tunnelProtocol`，默认 `http2`）**：`auto` 会让 cloudflared 首选 QUIC（UDP 7844），
而**部分网络静默丢弃 QUIC**（校园网 / 访客 Wi-Fi / 个别运营商链路）——这时 cloudflared 反复报
`Failed to dial a quic connection ... timeout: no recent network activity`，边缘连接数恒为 0，
公网请求被判「隧道无连接」，边缘直接回 **Error 1033（Argo Tunnel error）**（刚建好的一瞬是 530）。
`http2` 强制 TCP 443，这些网络能过。实测 2026-09-14 HNGY：同一链路 `--protocol quic` 连拨 30s
**零注册**，`--protocol http2` **1 秒** 打出 `Registered tunnel connection`；端到端 http2 隧道得
**401**（网关配对保护，说明请求真的到达网关），QUIC 隧道得 **530**。需要 QUIC 时把该项设为
`auto`/`quic`。`state().protocol` 会回报实际使用的传输，便于面板/日志归因。

**权限**：只有**本机页面**能开关隧道。手机（无论走局域网还是隧道）调用会得到 `403`：
经局域网/隧道到达的请求会被拒绝，避免已配对的设备把网关暴露到公网或关掉他人正在使用的隧道。

## WebUI 配对面板

同一个包带一个 client 半（`lib/client.js`，由 `package.json` 的 `dsh.client` 声明进 Web 模块图），
在会话页签行 `conversation.view` 的 order 30 注册「配对」页 —— 排在移动端插件的 git 页之后。

页面内容：当前配对码（大字 + 剩余轮换倒计时 + 「立即换码」）、扫码即配对的二维码、
带网卡名的本机访问地址候选（排序见上节）、**远程访问（CF 隧道）卡片**（含实际使用的传输协议）、
已配对设备列表（UA 摘要、来源 IP、配对时间、最近活跃、凭据到期时间）与逐设备吊销；
熔断时额外出现解锁按钮。

**本机专属**：配对码与两个含码 URL、以及「立即换码」「开关隧道」，只有 `entry === local` 才拿得到；
手机端看到的是说明文字，按钮为禁用状态。

**复制按钮给的是「打开即配对」的直链**：隧道卡的「复制公网直链（含配对码）」与每条候选地址的
「复制」都给 `<origin>/gateway-pair#k=<当前配对码>` —— 隧道卡直接复用 host 下发的 `tunnel.pairUrl`，
候选地址用 host 预先拼在 `candidates[].pairUrl` 上的同一形态 —— 对方粘贴打开即自动配对，
不必再口述那 6 位数字。远程页面拿不到 `pairUrl`，复制到的仍是裸地址，
与二维码同一条守则：配对码只在本机落地。

**设备行给的是句柄，不是凭据**：`id = sha256(token)` 的前 16 位（`lib/token-store.js` 的 `deviceId()`），
浏览器全程拿不到 token 本身；吊销按句柄由 host 反查。手机看自己那一行会标「本设备」，
且「吊销其余设备」会保留它，避免误操作把自己踢下线；单个吊销是两步确认（再点一次才执行）。

数据来自 host 半在 dsh webserver 上注册的精确路由 `GET /kita-gateway/panel`；
写操作走同一路由的 `POST { "action": "revoke" | "revoke-all" | "rotate" | "unlock" | "tunnel-start" | "tunnel-stop" }`。
用相对路径调用，桌面页面（loopback 端口）与经网关反代的手机页面（gateway 端口）都能直接命中。
网关反代时只在 `/kita-gateway/` 这条路径上注入 `x-kita-gw-device`（不可逆句柄），
并在注入前剥掉客户端自带的同名头，所以 LAN 客户端无法冒名。

**认证围栏**：优先用 `connection.requestRejection`（Host/Origin 围栏 + 浏览器会话 cookie）；
当该服务在当前上下文不可见时（2026-09 生产启动顺序即如此），**内置围栏接管而不是跳过** ——
Host 必须为本 webserver，Origin 存在时必须同源，否则 403。没有这一步，任意网页都能从用户浏览器
对 127.0.0.1 提交吊销/解锁/开隧道请求。

**来源标记**：网关反代时剥离客户端自带的 `x-kita-gw-entry` 与 `cf-connecting-ip`，再按自己观察到的事实
重新写入（`lan` / `tunnel`），webserver 侧据此判断请求来自哪扇门；伪造 `local` 不被采信。
否则局域网客户端可以伪造 `CF-Connecting-IP` 把自己的失败尝试记进别人的限流桶。

二维码编码器内联了 qrcode-generator（(c) Kazuhiko Arase, MIT）：client bundle 没有构建步骤、
无法解析 node_modules；不用在线二维码 API，是为了让配对码不离开本机。
host 侧（`lib/qr.js`，用于配对页与管理页的服务端渲染）与 client 侧是**同一份库正文**，
由 `node scripts/sync-qr-encoder.mjs --check` 保证不漂移。

## 配对流程

1. 首次部署后，dsh 启动日志会打印「本机管理入口」链接（同一行也写入
   `<DSH_HOME>/storages/kita-dsh-gateway-admin-url.txt`）。在电脑上打开它一次，浏览器即拿到本机管理令牌；
2. 此后配对码可从本机 dsh 页面的「配对」页签（127.0.0.1:3080 直连）或 `http://127.0.0.1:3081/admin` 读取；
3. 手机浏览器打开 `http://<主机LAN-IP>:3081`（或扫二维码直达并自动配对）；
4. 签发 90 天 token，**只把 `sha256(token)` 落到** `<DSH_HOME>/storages/kita-dsh-gateway-tokens.json`；
5. 后续访问免配对，直到 token 过期（在每次请求上判定）、主机吊销，或存储文件被删。

不在同一 Wi-Fi 时：在电脑面板上点「一键开启 CF 隧道」，用公网二维码扫码即可。

## 防护措施

- 配对码随机生成、限时（`codeMinutes`）；轮换时旧码保留 60 秒宽限（`CODE_GRACE_MS`），扫码撞上轮换不会被判错码；
- 单窗口最多 5 次尝试，失败会回传剩余次数；失败突刺阶梯锁 IP：5 分钟 → 30 分钟 → 6 小时 → 24 小时 → 永久（至进程重启）；
- 全局熔断：一小时 300 次失败直接关闭配对直至重启；
- 设备凭据**只落 `sha256` 哈希**（`lib/token-store.js`），认证时把 cookie 哈希后比对；`timingSafeEqual` 用于配对码比较；
- 面板与 `/admin` 只拿到 16 位不可逆句柄，吊销按句柄反查，浏览器全程接触不到 token；
- 90 天 TTL 在**每次请求**上判定（不再只在启动时过滤一次），另有每小时一次的后台清理；
- 状态文件**原子写**（临时文件 + rename）：半截写入不会让全部设备静默登出、配对码也不会无故重置；
- `x-kita-gw-device` 由网关在 `/kita-gateway/` 路径上注入并先剥离同名入站头，LAN 客户端无法冒名；
- 配对码只在本机渲染（见上「扫码即配对」），隧道开关与「立即换码」仅本机可操作；
- **本机管理令牌**：配对码、二维码、`/admin` 全部要求本机浏览器出示令牌（`kita_gw_admin` cookie）；
  令牌由网关首次启动时生成，落在 `<DSH_HOME>/storages/kita-dsh-gateway-admin.json`，
  只有这台机器读得到，任何隧道都伪造不了、也拿不到。

## 安全警告

配对成功即等于获得 dsh 完整操作权限。**默认仅在可信局域网使用**；
开隧道会让公网可达，任何拿到配对码的人都能进入 —— 临时用完请及时关闭。
隧道只暴露网关（带配对鉴权），永远不要直接把 `dsh web` 的 loopback 端口暴露出去。
**不要用 frp / sakurafrp 这类自建穿透暴露 3081**：frpc 就跑在本机，它替公网访客拨的是 127.0.0.1，
任何只看来源地址的判定都会被它骗过（2026-09-28 事故，见下）。要么用插件自带的 CF 隧道，
要么在穿透平台侧加访问认证与来源白名单。

## 实测记录（2026-09-11）

均为本机实测 `[MEASURED]`：

- **扫码即配对**：无头浏览器打开 `http://127.0.0.1:3081/gateway-pair#k=<code>` → 自动提交、
  地址跳转为 `http://127.0.0.1:3081/`（标题 `DeepSeek Harness`、composer 已渲染、无 console 报错），
  设备列表新增该 token。
- **真机经隧道**：Android 16 手机（中国移动 IPv6 出口）经 `*.trycloudflare.com` 完成配对，
  网关日志记录到该设备的 UA 与 `CF-Connecting-IP`。
- **隧道公网可达**：quick tunnel 建立后，公网请求 `https://<host>/gateway-pair` 返回 200
  （`curl --resolve` 实测 connect 0.19s / total 1.36s），页面内容为 `KITA_LOCAL = false`（远程不渲染二维码）。
- **530 窗口**：hostname 出现而注册行未出现时，公网请求得到 HTTP 530 —— 这就是 `start()` 要等注册行的原因。
- **本机 DNS 陷阱**：隧道刚建立时本机解析器可能仍负缓存该域名（或给出本机无法路由的 AAAA），
  使 `fetch` 报 `UND_ERR_CONNECT_TIMEOUT`，而 `curl --resolve` / 公共 DoH 立刻可用 ——
  探针因此内置 DoH + IPv4 直连回退（`KITA_E2E_DOH`，默认阿里 DoH）。

## 实测记录（2026-09-20）

均为本机实测 `[MEASURED]`：

- **面板不再泄露配对码**：从 LAN 入口（`entry=lan`）请求 `/kita-gateway/panel`，修复前 `code` 为 6 位明文，
  修复后为 `''` + `codeLocalOnly: true`；桌面入口仍正常返回。
- **候选地址排序**：修复前 `candidates = [VMnet8, VMnet1, VMnet1, 热点, WLAN]`（「建议」挂在 VMnet8 上），
  修复后 `[WLAN(物理), VMnet8, VMnet1, VMnet1, 热点, VirtualBox]` —— 物理网卡恒在最前。
- **凭据存储**：`kita-dsh-gateway-tokens.json` 的键由 64 位明文 token 变为 `sha256` 十六进制，
  已配对设备无需重新配对（cookie 里的明文 token 哈希后照样命中）。
- **离线回归**：`verify-gateway.mjs` 91 项 + `smoke-gateway.mjs` 40 项全绿。

## 测试

```bash
node scripts/verify-gateway.mjs        # 离线：91 项（纯函数、二维码、隧道状态机、凭据存储与 v1 迁移）
node scripts/smoke-gateway.mjs         # 离线：40 项（真实监听 + 假 webserver：配对流程、entry 围栏、迁移、宽限期）
node scripts/pair-tunnel-e2e.mjs       # 在线：配对页可见性、配对流程、entry 围栏、隧道权限
KITA_E2E_TUNNEL=1 node scripts/pair-tunnel-e2e.mjs   # 额外真实开停一次隧道
node scripts/sync-qr-encoder.mjs --check             # host 与 client 二维码库同源校验
```

`smoke-gateway.mjs` 用私有端口（13080/13081）与临时 `DSH_HOME` 跑真实插件，不碰在役网关；
它需要 `@deepseek-ai/schemastery` 能从本包解析（monorepo 从 dsh 环境链接，`npm install` 亦可）。

在线脚本读取 `KITA_GW_PORT` / `KITA_DSH_PORT` / `KITA_LAN_IP`（默认 3081 / 3080 / 自动探测），
不写死任何本机地址；它会**只**撤销本次新建的配对设备，并保持运行前已存在的隧道与设备原样。
另有 `scripts/tunnel-e2e.mjs`（配对→代理→WebSocket 升级）与 `scripts/tunnel-adversarial.mjs`
（伪造头/旁路 token 对抗用例）。