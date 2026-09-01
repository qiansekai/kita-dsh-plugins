// Adversarial test battery against the dsh gateway through the Cloudflare
// Tunnel — attacker perspective (no cookie), plus remote-capability checks
// with a legitimately paired token. Run AFTER the normal e2e pair flow.
const TUNNEL = process.argv[2] ?? 'https://ladder-slow-motorola-adam.trycloudflare.com'
const LOCAL = 'http://127.0.0.1:3081'

async function main() {
  const out = { pass: [], fail: [] }
  const check = (name, ok, detail = '') => {
    ;(ok ? out.pass : out.fail).push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  const j = async (res) => { try { return await res.json() } catch { return null } }

  // ── A. 未授权攻击面 ────────────────────────────────────────────────
  // 1. 管理面三个端点经隧道必须全部 404
  for (const p of ['/admin', '/admin/code', '/admin/revoke']) {
    const r = await fetch(`${TUNNEL}${p}`)
    check(`隧道 ${p} 被拦`, r.status === 404, `HTTP ${r.status}`)
  }
  // 2. 配对接口畸形输入
  const empty = await fetch(`${TUNNEL}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' })
  check('配对空请求体被拒', empty.status === 401, `HTTP ${empty.status}`)
  const malformed = await fetch(`${TUNNEL}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json{{{ ' })
  check('配对畸形 JSON 被拒', malformed.status === 401, `HTTP ${malformed.status}`)
  const noField = await fetch(`${TUNNEL}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: 1 }) })
  check('配对缺 code 字段被拒', noField.status === 401, `HTTP ${noField.status}`)
  // 3. 伪造 token
  const fake = await fetch(`${TUNNEL}/`, { headers: { Cookie: 'kita_gw=' + 'a'.repeat(64) } })
  check('伪造 token 被拒', fake.status === 401, `HTTP ${fake.status}`)
  // 4. 未授权访问文件路由
  const filesNoAuth = await fetch(`${TUNNEL}/mobile-files/list?path=${encodeURIComponent('D:\\Kita-Tools')}`)
  check('未授权文件列举被拒', filesNoAuth.status === 401, `HTTP ${filesNoAuth.status}`)

  // ── B. 正常配对后的远程能力 ─────────────────────────────────────────
  const localAdmin = await (await fetch(`${LOCAL}/admin/code`)).json()
  const pair = await fetch(`${TUNNEL}/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: localAdmin.code }),
  })
  const token = /kita_gw=([a-f0-9]+)/.exec(pair.headers.get('set-cookie') ?? '')?.[1] ?? null
  check('合法配对成功', pair.status === 200 && token !== null, `HTTP ${pair.status}`)
  if (token === null) throw new Error('pair failed, abort')
  const authed = { Cookie: `kita_gw=${token}` }

  // 5. 路径穿越（配对后的正常请求应被路由层拒绝：相对路径/穿越/编码变体）
  for (const evil of ['C:..%5C..%5CWindows', '..%2F..%2FWindows', '%5C%5Cevil', 'D:/Kita-Tools/../../../']) {
    const r = await fetch(`${TUNNEL}/mobile-files/list?path=${evil}`, { headers: authed })
    check(`路径穿越被拒 (${evil.slice(0, 20)})`, r.status === 400, `HTTP ${r.status}`)
  }
  // 6. HTTP 方法滥用
  const postList = await fetch(`${TUNNEL}/mobile-files/list`, { method: 'POST', headers: authed })
  check('POST /mobile-files/list 被拒', postList.status === 405, `HTTP ${postList.status}`)
  // 7. 二进制文件拒绝预览
  const bin = await fetch(`${TUNNEL}/mobile-files/read?path=${encodeURIComponent('C:\\Windows\\System32\\notepad.exe')}`, { headers: authed })
  check('二进制文件拒绝预览', bin.status === 415, `HTTP ${bin.status}`)

  // 8. 客户端 bundle 经隧道加载（移动端插件 1.1MB 大文件）
  const started = Date.now()
  const bundle = await fetch(`${TUNNEL}/plugins/%40dsh-external%2Fdsh-mobile-nav/client.js`, { headers: { Cookie: `kita_gw=${token}` } })
  const bundleMs = Date.now() - started
  check('移动端 bundle 经隧道加载', bundle.status === 200 && (await bundle.text()).length > 100000, `HTTP ${bundle.status}, ${bundleMs}ms`)

  // 9. 终端全链路：wss 经隧道 → pwsh 往返
  const { WebSocket } = await import('file:///C:/Users/Tairitsu/.dsh/profiles/web/node_modules/ws/wrapper.mjs')
  const wsUrl = TUNNEL.replace('https://', 'wss://') + '/mobile-terminal?cwd=' + encodeURIComponent('D:\\Kita-Tools') + '&cols=100&rows=30'
  const wsRoundtrip = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `kita_gw=${token}` } })
    let buff = ''
    let opened = false
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 20000)
    ws.on('open', () => {
      opened = true
      setTimeout(() => ws.send(JSON.stringify({ t: 'input', d: 'echo remote-ok\r' })), 2500)
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.t === 'data') {
        buff += String(msg.d)
        if (buff.includes('remote-ok')) { clearTimeout(timer); resolve('echo roundtrip ok'); ws.close() }
      } else if (msg.t === 'fatal') { clearTimeout(timer); resolve('fatal: ' + msg.d); ws.close() }
    })
    ws.on('error', (e) => { clearTimeout(timer); resolve('error: ' + e.message) })
    ws.on('close', () => { clearTimeout(timer); if (!opened) resolve('closed before open') })
  })
  check('终端 pwsh 经隧道往返', wsRoundtrip === 'echo roundtrip ok', wsRoundtrip)

  // 10. 吊销测试 token
  const revoke = await fetch(`${LOCAL}/admin/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
  check('测试 token 吊销', revoke.status === 200 && (await j(revoke))?.ok === true, `HTTP ${revoke.status}`)
  const afterRevoke = await fetch(`${TUNNEL}/`, { headers: { Cookie: `kita_gw=${token}` } })
  check('吊销后 token 失效', afterRevoke.status === 401, `HTTP ${afterRevoke.status}`)

  // ── C. 配对暴力限速（最后跑：会锁定本出口 IP 的配对窗口 60 秒）─────
  let rateLimited = false
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${TUNNEL}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000' }),
    })
    if (r.status === 429) { rateLimited = true; break }
  }
  check('连续错误配对触发 429 限速', rateLimited, rateLimited ? '6 次内触发' : '未触发')

  console.log(out.pass.join('\n'))
  console.log(out.fail.join('\n'))
  console.log(`\n对抗测试: ${out.pass.length} 通过, ${out.fail.length} 失败`)
  process.exit(out.fail.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('ABORT:', e.message)
  process.exit(1)
})
