// End-to-end verification of the dsh Cloudflare Tunnel chain:
// 1. unauthenticated visit redirects to the pairing page
// 2. /admin is NOT reachable through the tunnel (loopback guard)
// 3. wrong pairing code rejected; real code pairs (code read from local admin API)
// 4. paired cookie serves the dsh app + the mobile-files route through the tunnel
// 5. websocket upgrade to /mobile-terminal proxies through the tunnel
// 6. the test token is revoked afterwards (local admin API)
const TUNNEL = process.argv[2] ?? 'https://cheque-phpbb-correction-trains.trycloudflare.com'
const LOCAL = 'http://127.0.0.1:3081'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const out = { pass: [], fail: [] }
  const check = (name, ok, detail = '') => {
    ;(ok ? out.pass : out.fail).push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  }

  // 1. unauthenticated browser visit → pairing redirect (browsers send text/html)
  const anon = await fetch(`${TUNNEL}/`, { redirect: 'manual', headers: { Accept: 'text/html' } })
  check('未登录访问重定向配对页', anon.status === 302 && (anon.headers.get('location') ?? '').includes('/gateway-pair'), `HTTP ${anon.status} → ${anon.headers.get('location')}`)

  // 2. /admin through the tunnel → blocked
  const adminRemote = await fetch(`${TUNNEL}/admin`)
  check('隧道访问 /admin 被拦', adminRemote.status === 404, `HTTP ${adminRemote.status}`)

  // 3. local admin API → pairing code + existing devices
  const localAdmin = await (await fetch(`${LOCAL}/admin/code`)).json()
  check('本机 /admin/code 可读', typeof localAdmin.code === 'string' && localAdmin.code.length === 6, `code=${localAdmin.code}`)

  // 4. wrong code through the tunnel
  const wrong = await fetch(`${TUNNEL}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '000000' }),
  })
  check('错误配对码被拒', wrong.status === 401, `HTTP ${wrong.status}`)

  // 5. real code through the tunnel → cookie
  const pair = await fetch(`${TUNNEL}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: localAdmin.code }),
  })
  const setCookie = pair.headers.get('set-cookie') ?? ''
  const token = /kita_gw=([a-f0-9]+)/.exec(setCookie)?.[1] ?? null
  check('真实配对码配对成功', pair.status === 200 && token !== null, `HTTP ${pair.status}${token ? ' token=' + token.slice(0, 8) + '…' : ''}`)
  if (token === null) throw new Error('pairing failed, abort')

  // 6. paired request serves the dsh app
  const app = await fetch(`${TUNNEL}/`, { headers: { Cookie: `kita_gw=${token}` } })
  const html = await app.text()
  check('配对后隧道可访问 dsh', app.status === 200 && html.includes('__DSH_BOOT__'), `HTTP ${app.status}, ${html.length} bytes`)

  // 7. mobile-files route through the tunnel
  const files = await fetch(`${TUNNEL}/mobile-files/list?path=${encodeURIComponent('D:\\Kita-Tools')}`, {
    headers: { Cookie: `kita_gw=${token}` },
  })
  const filesBody = await files.json()
  check('隧道走通 /mobile-files', files.status === 200 && filesBody.ok === true && Array.isArray(filesBody.entries), `entries=${filesBody.entries?.length}`)

  // 8. websocket upgrade through the tunnel (terminal route answers with its
  //    JSON envelope; a fatal for pwsh is expected until the next restart,
  //    any envelope proves the upgrade proxied end to end)
  const { WebSocket } = await import('file:///C:/Users/Tairitsu/.dsh/profiles/web/node_modules/ws/wrapper.mjs')
  const wsUrl = TUNNEL.replace('https://', 'wss://') + '/mobile-terminal?cwd=' + encodeURIComponent('D:\\Kita-Tools') + '&cols=80&rows=24'
  const wsResult = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `kita_gw=${token}` } })
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 10000)
    ws.on('open', () => resolve('opened'))
    ws.on('message', (data) => { clearTimeout(timer); resolve(String(data).slice(0, 120)); ws.close() })
    ws.on('error', (e) => { clearTimeout(timer); resolve('error:' + e.message) })
    ws.on('close', () => { clearTimeout(timer); resolve('closed') })
  })
  check('隧道走通终端 WebSocket', wsResult.startsWith('{') || wsResult === 'opened', wsResult)

  // 9. revoke the test token (local admin)
  const revoke = await fetch(`${LOCAL}/admin/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const revokeBody = await revoke.json()
  check('测试 token 已吊销', revoke.status === 200 && revokeBody.ok === true, `HTTP ${revoke.status}`)

  console.log(out.pass.join('\n'))
  console.log(out.fail.join('\n'))
  console.log(`\n结果: ${out.pass.length} 通过, ${out.fail.length} 失败`)
  process.exit(out.fail.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('ABORT:', e.message)
  process.exit(1)
})
