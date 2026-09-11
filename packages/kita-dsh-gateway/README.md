# kita-dsh-gateway

配对码鉴权网关：让 `dsh web` 保持 loopback-only，同时在局域网暴露**唯一一个带认证的入口**（默认 :3081）。

## 解决的问题

dsh webserver 只监听 127.0.0.1，手机/其他设备访问不了；直接改绑 0.0.0.0 则完全裸奔。
本插件在两者之间架一道配对鉴权：首次访问先输配对码，换取长期 token
（HttpOnly cookie + Bearer 头），之后所有请求反代回 `127.0.0.1:<targetPort>` 并重写 Host 头，
dsh 看到的是本地客户端（loopback 围栏通过、本地专属功能可用）；WebSocket 升级
（mux/host 事件流）同样反代。

**对抗的威胁**：局域网邻居，以及未来指向该端口的 frp / cloudflared / tailscale 隧道。
**不防护**：本机已运行的进程（它们能读 token 文件）。

## 装配

依赖 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`。profile `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: kita-dsh-gateway
      name: kita-dsh-gateway
      config:
        port: 3081        # LAN 入口端口
        targetPort: 3080  # dsh loopback 端口
        codeMinutes: 10   # 配对码有效期（分钟）
```

## WebUI 配对面板

同一个包带一个 client 半（`lib/client.js`，由 `package.json` 的 `dsh.client` 声明进 Web 模块图），
在会话页签行 `conversation.view` 的 order 30 注册「配对」页 —— 排在移动端插件的 git 页之后。

页面内容：当前配对码（大字 + 剩余轮换倒计时）、扫码直达配对页的二维码、
按「与手机最近来源同 /24」优先排序的本机访问地址候选（排除回环 / 链路本地 / Radmin / CGNAT 段）、
已配对设备列表（UA 摘要、来源 IP、配对时间、最近活跃）与逐设备吊销；熔断时额外出现解锁按钮。

数据来自 host 半在 dsh webserver 上注册的精确路由 `GET /kita-gateway/panel`；
写操作走同一路由的 `POST { "action": "revoke" | "unlock" }`。用相对路径调用，
桌面页面（loopback 端口）与经网关反代的手机页面（gateway 端口）都能直接命中；
认证复用 `connection.requestRejection`（Host/Origin 围栏 + 浏览器会话 cookie），
所以即使叠加隧道，配对码也不会落到未认证访客手里。

二维码编码器内联了 qrcode-generator（(c) Kazuhiko Arase, MIT）：client bundle 没有构建步骤、
无法解析 node_modules；不用在线二维码 API，是为了让配对码不离开本机。

## 配对流程

1. 启动 dsh 后控制台打印一次性配对码；
2. 手机浏览器打开 `http://<主机LAN-IP>:3081`，输入配对码；
3. 签发 90 天 token（`~/.dsh/storages/kita-dsh-gateway-tokens.json`，已哈希存储）；
4. 后续访问免配对，直到 token 过期或主机删除存储文件。

## 防护措施

- 配对码随机生成、限时（`codeMinutes`）、单窗口最多 5 次尝试；
- 失败突刺阶梯锁 IP：5 分钟 → 30 分钟 → 6 小时 → 24 小时 → 永久（至进程重启）；
- 全局熔断：一小时 300 次失败直接关闭配对直至重启；
- token 比较走 `timingSafeEqual`（哈希后），存储只落哈希。

## 安全警告

配对成功即等于获得 dsh 完整操作权限。**仅限可信局域网使用，切勿直接暴露公网**；
远程访问请叠加 frp / cloudflared / tailscale 等隧道并保管好配对码。

## 测试

`scripts/tunnel-e2e.mjs` 走配对→代理→WebSocket 升级的端到端链路；
`scripts/tunnel-adversarial.mjs` 构造恶意客户端对抗用例（伪造头、旁路 token 等）。
均需一个运行中的 dsh web 实例。
