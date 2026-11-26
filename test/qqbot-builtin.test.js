// 内置「官方 QQBot」模块单元测试（协议引擎 / 虚拟 ID / 多平台路由器 / 路由前缀与凭据脱敏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkAllowed, isOwner } from '../src/chat/access.js'
import { acquirePlatformRouter, createVirtualIdMapper, createRuntimeAllowSync } from '../src/modules/qqbot/router.js'
import { parseImQqbotFromPatchYaml } from '../src/modules/qqbot/sdk-loader.js'
import { LiteQQBot, createPassiveReplyTracker } from '../src/modules/qqbot/lite.js'
import qqbotModule from '../src/modules/qqbot/index.js'

test('parseImQqbotFromPatchYaml: 解析 @tencent-connect/dsh-qqbot 的 cordis.patch.yml 凭据与白名单', () => {
  const yaml = `
# profile patch
- id: other-plugin
  config:
    foo: bar
- id: im-qqbot
  config:
    appId: "102938475"
    appSecret: "sec_xyz_999"
    requireMention: true
    access:
      c2cMode: allowlist
      c2cAllow:
        - "OPENID_USER_001"
      groupMode: allowlist
      groupAllow: ["OPENID_GRP_A", "OPENID_GRP_B"]
`

  const parsed = parseImQqbotFromPatchYaml(yaml)
  assert.ok(parsed)
  assert.equal(parsed.appId, '102938475')
  assert.equal(parsed.appSecret, 'sec_xyz_999')
  assert.equal(parsed.c2cMode, 'allowlist')
  assert.deepEqual(parsed.c2cAllow, ['OPENID_USER_001'])
  assert.deepEqual(parsed.groupAllow, ['OPENID_GRP_A', 'OPENID_GRP_B'])
  assert.equal(parsed.disabled, false)
})

test('createPassiveReplyTracker: 单条 msg_id 4 次额度与超时/耗尽降级主动推送', () => {
  const tracker = createPassiveReplyTracker({ limitPerMsg: 4 })
  tracker.recordInboundMsg('group', 'GRP_OPENID_1', 'MSG_IN_1')

  for (let i = 0; i < 4; i++) {
    const r = tracker.resolve('group', 'GRP_OPENID_1', '')
    assert.equal(r.msgId, 'MSG_IN_1')
  }
  const r5 = tracker.resolve('group', 'GRP_OPENID_1', '')
  assert.equal(r5.msgId, undefined)
  assert.equal(r5.targetId, 'GRP_OPENID_1')
})

test('createVirtualIdMapper: 12 位安全正整数双向映射且满足 Number.isSafeInteger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-idmap-'))
  try {
    const file = join(dir, 'id-map.json')
    const map1 = createVirtualIdMapper({ file, prefixUser: '81', prefixGroup: '82', prefixChannel: '83', prefixMsg: '89' })
    const vu = map1.toVirtualUser('USER_OPENID_ABCDEF', '测试用户')
    const vg = map1.toVirtualGroup('GROUP_OPENID_123456', '测试群')
    const vc = map1.toVirtualChannel('guild:CHAN_999', '测试频道')
    const vm = map1.rememberMessage('group:GROUP_OPENID_123456|MSG_001', { realMsgId: 'MSG_001' })

    assert.equal(vu, '810000000001')
    assert.equal(vg, '820000000001')
    assert.equal(vc, '830000000001')
    assert.equal(vm, '890000000001')
    assert.ok(Number.isSafeInteger(Number(vu)))
    assert.ok(Number.isSafeInteger(Number(vg)))
    assert.ok(Number.isSafeInteger(Number(vc)))
    assert.ok(Number.isSafeInteger(Number(vm)))
    map1.flush()

    const map2 = createVirtualIdMapper({ file, prefixUser: '81', prefixGroup: '82', prefixChannel: '83', prefixMsg: '89' })
    assert.equal(map2.toRealUser('810000000001'), 'USER_OPENID_ABCDEF')
    assert.equal(map2.toRealGroup('820000000001'), 'GROUP_OPENID_123456')
    assert.equal(map2.toRealChannel('830000000001'), 'guild:CHAN_999')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LiteQQBot: WebSocket 握手 + Markdown 无权限自动降级纯文本 + 撤回 API', async () => {
  const fakeFetch = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : null

    if (u.endsWith('/app/getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'tok_123', expires_in: 7200 }), { status: 200 })
    }
    if (u.endsWith('/gateway')) {
      return new Response(JSON.stringify({ url: 'wss://mock.qq.gateway/ws' }), { status: 200 })
    }
    if (u.includes('/v2/groups/GRP_1/messages') && init.method === 'POST') {
      if (body?.msg_type === 2) {
        return new Response(JSON.stringify({ code: 304014, message: 'markdown not allowed' }), { status: 403 })
      }
      return new Response(JSON.stringify({ id: 'OUT_MSG_99', timestamp: Date.now() }), { status: 200 })
    }
    if (u.includes('/v2/groups/GRP_1/messages/OUT_MSG_99') && init.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ id: 'OK_1', file_info: 'FI_123', file_uuid: 'UUID_1', ttl: 3600 }), { status: 200 })
  }

  let wsInstance = null
  class MockWs {
    constructor(url) {
      this.url = url
      this.readyState = 1
      this.listeners = {}
      wsInstance = this
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) })
      }, 5)
    }
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn) }
    emit(ev, payload) { for (const fn of this.listeners[ev] || []) fn(payload) }
    send(data) {
      const p = JSON.parse(data)
      if (p.op === 2) {
        this.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess_abc' } }) })
      }
    }
    close() { this.readyState = 3 }
  }

  const bot = new LiteQQBot({
    appId: '10001',
    appSecret: 'secret_1',
    markdownSupport: true,
    fetchImpl: fakeFetch,
    WsImpl: MockWs,
    logger: { info() {}, warn() {}, error() {} },
  })

  let readyFired = false
  let inboundGot = null
  bot.on('ready', () => { readyFired = true })
  bot.on('message', (_ctx, msg) => { inboundGot = msg })

  await bot.start()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(readyFired, true)

  wsInstance.emit('message', {
    data: JSON.stringify({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'IN_MSG_1',
        group_openid: 'GRP_1',
        content: '<@!10001> 你好大肥鱼',
        timestamp: new Date().toISOString(),
        author: { member_openid: 'MEM_1', username: '小明' },
      },
    }),
  })
  assert.ok(inboundGot)
  assert.equal(inboundGot.groupOpenid, 'GRP_1')
  assert.equal(inboundGot.senderId, 'MEM_1')

  const sentRes = await bot.sendText({ scope: 'group', targetId: 'GRP_1', msgId: 'IN_MSG_1' }, '**测试回复**')
  assert.equal(sentRes.id, 'OUT_MSG_99')
  await bot.recallMessage({ scope: 'group', targetId: 'GRP_1' }, 'OUT_MSG_99')
  bot.stop()
})

test('内置 qqbot 模块：路由器 base64 落盘清理 / 错误截断 / /qqbot/ 路由前缀与密钥脱敏', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aurabot-builtin-qqbot-'))
  try {
    const snowlumaCalls = []
    const listeners = new Map()
    const cfg = {
      enabled: true,
      dryRun: false,
      botQQ: '99887766',
      ownerQQ: '12345678',
      ownerName: '主人',
      allow: { private: [], groups: ['555666'] },
      modules: {},
      ext: {
        qqbot: {
          enabled: false,
          appId: '102030405',
          appSecret: 'SUPER_SECRET_SHOULD_NOT_LEAK',
          autoSyncFromDshPlugin: false,
          ownerOpenid: 'OWNER_OPENID_XYZ',
          ownerSessionMode: 'shared',
          c2cMode: 'open',
          groupMode: 'open',
        },
      },
    }

    let customSnowlumaHandler = null
    const onebot = {
      state: 'connected',
      async call(action, params) {
        if (customSnowlumaHandler) return customSnowlumaHandler(action, params)
        snowlumaCalls.push({ action, params })
        if (action === 'get_group_list') return [{ group_id: 555666, group_name: '原版QQ群' }]
        return { message_id: 1001 }
      },
    }

    const offs = []
    const routes = new Map()
    const qqApi = {
      id: 'qqbot',
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: () => cfg,
      settings: () => ({ ...(qqbotModule.defaults || {}), ...(cfg.ext.qqbot || {}) }),
      saveSettings: (patch) => { cfg.ext.qqbot = { ...(cfg.ext.qqbot || {}), ...patch }; return cfg.ext.qqbot },
      dataDir: (...p) => join(tmp, ...p),
      core: {
        onebot,
        hub: { async onMessage() {} },
        http: { body: async (req) => req || {} },
      },
      on(ev, fn) {
        const l = listeners.get(ev) || []
        l.push(fn)
        listeners.set(ev, l)
        const off = () => listeners.set(ev, (listeners.get(ev) || []).filter((x) => x !== fn))
        offs.push(off)
        return off
      },
      emit(ev, ...args) {
        for (const fn of listeners.get(ev) || []) fn(...args)
      },
      every: () => () => {},
      later: () => () => {},
      route: (p, h) => { routes.set(p, h); return () => routes.delete(p) },
      command: () => () => {},
      onDispose: (fn) => offs.push(fn),
      _disposeAll: () => { for (const fn of offs.splice(0).reverse()) fn() },
    }

    const qqExports = qqbotModule.setup(qqApi)

    // 1. 所有注册的 HTTP 路由必须以 /qqbot/ 开头（内置模块无 /ext/ 前缀，防冲突）
    assert.ok(routes.size > 0)
    for (const path of routes.keys()) {
      assert.ok(path.startsWith('/qqbot/'), `路由缺少 /qqbot/ 前缀：${path}`)
    }
    assert.ok(routes.has('/qqbot/status'))
    assert.ok(routes.has('/qqbot/save'))

    // 2. /qqbot/status 不含 appSecret 明文
    const st1 = await routes.get('/qqbot/status')()
    assert.equal(st1.ok, true)
    assert.equal(st1.settings.appId, '102030405')
    assert.equal(st1.settings.appSecretSet, true)
    assert.equal(JSON.stringify(st1).includes('SUPER_SECRET_SHOULD_NOT_LEAK'), false, '/qqbot/status 不应包含 appSecret 明文')

    // 3. /qqbot/save 传入空 appSecret 时保留原有密钥不覆盖
    const saveRes = await routes.get('/qqbot/save')({
      enabled: false,
      appId: '102030405',
      appSecret: '',
      ownerOpenid: 'OWNER_UPDATED',
      requireMentionInGroup: false,
      nonMentionReplyMode: 'aurabot',
      markdownSupport: true,
    })
    assert.equal(saveRes.ok, true)
    assert.equal(cfg.ext.qqbot.appSecret, 'SUPER_SECRET_SHOULD_NOT_LEAK')
    assert.equal(cfg.ext.qqbot.ownerOpenid, 'OWNER_UPDATED')
    assert.equal(cfg.ext.qqbot.requireMentionInGroup, false)
    assert.equal(cfg.ext.qqbot.nonMentionReplyMode, 'aurabot')
    assert.equal(cfg.ext.qqbot.markdownSupport, true)

    const st2 = await routes.get('/qqbot/status')()
    assert.equal(st2.settings.ownerOpenid, 'OWNER_UPDATED')
    assert.equal(st2.settings.appSecretSet, true)
    assert.equal(JSON.stringify(st2).includes('SUPER_SECRET_SHOULD_NOT_LEAK'), false)

    // 4. summary() 与虚拟 ID / checkAllowed 兼容
    const sum = qqExports.summary()
    assert.equal(sum.state, 'stopped')
    assert.equal(sum.enabled, false)
    assert.equal(sum.appId, '102030405')

    const qqVirtGroup = qqExports.toVirtualGroup('QQBOT_GROUP_OPENID_1', '官方QQBot测试群')
    assert.equal(qqVirtGroup.slice(0, 2), '82')
    const qqOwnerVirt = qqExports.toVirtualUser('OWNER_UPDATED', '主人')
    assert.equal(qqOwnerVirt, '12345678')
    assert.equal(isOwner(cfg, qqOwnerVirt), true)
    assert.equal(checkAllowed(cfg, { kind: 'private', userId: qqOwnerVirt, groupId: '' }).allowed, true)

    // 5. 路由器：add_custom_face base64 落盘临时路径 + 清理、错误截断、offline 静默
    const fakePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    let capturedFacePath = ''
    let capturedExisted = false
    customSnowlumaHandler = async (action, params) => {
      if (action === 'add_custom_face') {
        capturedFacePath = params.file
        capturedExisted = existsSync(capturedFacePath)
        return { emoji_id: 'face_ok_1' }
      }
      return { message_id: 1002 }
    }
    const faceRes = await onebot.call('add_custom_face', { file: 'base64://' + fakePng.toString('base64') })
    assert.equal(faceRes.emoji_id, 'face_ok_1')
    assert.ok(!capturedFacePath.startsWith('base64://'))
    assert.ok(capturedFacePath.endsWith('.png'))
    assert.equal(capturedExisted, true)
    assert.equal(existsSync(capturedFacePath), false)

    customSnowlumaHandler = async () => {
      throw new Error(`ENAMETOOLONG: name too long, stat 'base64://${'A'.repeat(500)}'`)
    }
    await assert.rejects(
      () => onebot.call('send_private_msg', { user_id: 888999, message: 'x' }),
      (err) => err.message.includes('base64://[omitted ') && !err.message.includes('A'.repeat(200)),
    )
    customSnowlumaHandler = null

    onebot.state = 'disconnected'
    assert.deepEqual(await onebot.call('add_custom_face', { file: 'base64://' + fakePng.toString('base64') }), {})
    assert.deepEqual(await onebot.call('fetch_custom_face', { count: 50 }), [])
    onebot.state = 'connected'

    qqApi._disposeAll()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('内置接线契约：BUILTINS 含 qqbot，面板「连接」页含 QQBotCard 与状态展示，表情同步传本地路径', async () => {
  const { readFileSync } = await import('node:fs')
  const { BUILTINS } = await import('../src/modules/index.js')
  assert.ok(BUILTINS.some((m) => m && m.id === 'qqbot'), 'BUILTINS 应包含 qqbot 模块')

  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(clientSrc.includes('function QQBotCard({ toast, reload })'), 'client.js 缺少 QQBotCard 组件')
  assert.ok(clientSrc.includes('h(QQBotCard, { toast, reload })'), 'Connect 页未挂载 QQBotCard')
  assert.ok(clientSrc.includes("post('/qqbot/save', form)"), 'QQBotCard 缺少 /qqbot/save 保存调用')
  assert.ok(clientSrc.includes("!(st.qqbot && st.qqbot.state === 'connected')"), '概览页未兼容仅连官方 QQBot 的在线态')

  const hostSrc = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  assert.ok(hostSrc.includes("qqbot: use('qqbot')?.summary?.() ?? null"), 'overview() 缺少 qqbot 摘要字段')

  const stickerSrc = readFileSync(new URL('../src/features/stickers.js', import.meta.url), 'utf8')
  assert.ok(stickerSrc.includes("onebot.call('add_custom_face', { file: localPath })"), 'stickers.js 未改为传本地文件路径')
})

