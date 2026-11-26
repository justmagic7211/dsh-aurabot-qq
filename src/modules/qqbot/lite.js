// 腾讯官方 QQ 开放平台协议层双引擎封装：
// 1. 若环境或 DSH Profile 中已安装 @tencent-connect/qqbot-nodejs，则优先使用官方 QQBot SDK；
// 2. 若尚未安装依赖，则自动无缝回退到本文件内置的零依赖 Node 22 原生协议客户端（LiteQQBot）；
// 3. 内置对齐 @tencent-connect/dsh-qqbot 的被动回复窗口（群 5min / 私聊 30min）与 4 次回复额度三级兜底器。

import { readFileSync } from 'node:fs'

export const MediaFileType = Object.freeze({
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
})

export const MsgType = Object.freeze({
  TEXT: 0,
  MARKDOWN: 2,
  ARK: 3,
  EMBED: 4,
  MEDIA: 7,
})

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
}

const FULL_INTENTS =
  INTENTS.GUILDS |
  INTENTS.GUILD_MEMBERS |
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION

// 无 GUILD_MEMBERS 特权时的兼容 intents（遇到 4914/4915 自动降级）
const SAFE_INTENTS =
  INTENTS.GUILDS |
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION

const GROUP_ONLY_INTENTS = INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

function nextMsgSeq() {
  return ((Date.now() % 100_000_000) ^ Math.floor(Math.random() * 65536)) % 65536
}

function parseRefIndices(ext, msgType, msgElements) {
  let refMsgIdx = undefined
  let msgIdx = undefined
  if (Array.isArray(ext)) {
    for (const entry of ext) {
      if (typeof entry !== 'string') continue
      const eq = entry.indexOf('=')
      if (eq < 0) continue
      const k = entry.slice(0, eq).trim()
      const v = entry.slice(eq + 1).trim()
      if (!v) continue
      if (k === 'msg_idx') msgIdx = v
      else if (k === 'ref_msg_idx') refMsgIdx = v
    }
  }
  if (msgType === 103 && Array.isArray(msgElements)) {
    for (const el of msgElements) {
      if (el?.msg_idx) { refMsgIdx = el.msg_idx; break }
    }
  }
  return { refMsgIdx, msgIdx }
}

export function normalizeGatewayEvent(eventType, data) {
  if (eventType === 'READY') return { action: 'ready', data, sessionId: data?.session_id || '' }
  if (eventType === 'RESUMED') return { action: 'resumed', data }
  if (eventType === 'INTERACTION_CREATE') return { action: 'interaction', event: data }

  if (eventType === 'C2C_MESSAGE_CREATE') {
    const ev = data || {}
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements)
    const senderId = String(ev.author?.user_openid || ev.author?.id || '')
    return {
      action: 'message',
      msg: {
        rawEventType: eventType,
        kind: 'c2c',
        senderId,
        content: String(ev.content || ''),
        messageId: String(ev.id || ''),
        timestamp: String(ev.timestamp || ''),
        attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        messageScene: ev.message_scene,
        msgElements: ev.msg_elements,
        replyTarget: { scope: 'c2c', targetId: senderId, msgId: String(ev.id || '') },
        raw: ev,
      },
    }
  }

  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
    const ev = data || {}
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements)
    const groupOpenid = String(ev.group_openid || ev.group_id || '')
    const senderId = String(ev.author?.member_openid || ev.author?.id || '')
    return {
      action: 'message',
      msg: {
        rawEventType: eventType,
        kind: 'group',
        senderId,
        senderName: ev.author?.username || '',
        senderIsBot: Boolean(ev.author?.bot),
        content: String(ev.content || ''),
        messageId: String(ev.id || ''),
        timestamp: String(ev.timestamp || ''),
        groupOpenid,
        attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        mentions: ev.mentions,
        messageScene: ev.message_scene,
        msgElements: ev.msg_elements,
        replyTarget: { scope: 'group', targetId: groupOpenid, msgId: String(ev.id || '') },
        raw: ev,
      },
    }
  }

  if (eventType === 'AT_MESSAGE_CREATE' || eventType === 'DIRECT_MESSAGE_CREATE') {
    const ev = data || {}
    const isDm = eventType === 'DIRECT_MESSAGE_CREATE'
    const senderId = String(ev.author?.id || '')
    return {
      action: 'message',
      msg: {
        rawEventType: eventType,
        kind: isDm ? 'dm' : 'guild',
        senderId,
        senderName: ev.author?.username || '',
        senderIsBot: Boolean(ev.author?.bot),
        content: String(ev.content || ''),
        messageId: String(ev.id || ''),
        timestamp: String(ev.timestamp || ''),
        channelId: ev.channel_id ? String(ev.channel_id) : undefined,
        guildId: ev.guild_id ? String(ev.guild_id) : undefined,
        attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
        replyTarget: {
          scope: isDm ? 'c2c' : 'group',
          targetId: String(isDm ? ev.guild_id : ev.channel_id),
          msgId: String(ev.id || ''),
        },
        raw: ev,
      },
    }
  }

  return { action: 'raw', type: eventType, data }
}

/**
 * 零依赖 Node 22 原生 QQ Open Platform 客户端（与 @tencent-connect/qqbot-nodejs 的 QQBot 接口一致）
 */
export class LiteQQBot {
  constructor(opts = {}) {
    this.appId = String(opts.appId || '').trim()
    this.appSecret = String(opts.appSecret || '').trim()
    this.markdownSupport = Boolean(opts.markdownSupport)
    this.baseUrl = String(opts.baseUrl || process.env.QQBOT_BASE_URL || 'https://api.bot.qq.com').replace(/\/+$/, '')
    this.tokenBaseUrl = String(opts.tokenBaseUrl || process.env.QQBOT_TOKEN_BASE_URL || 'https://bots.qq.com').replace(/\/+$/, '')
    this.userAgent = String(opts.userAgent || `aurabot-qqbot/1.0 (Node/${process.versions.node})`)
    this.logger = opts.logger || console
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.WsImpl = opts.WsImpl || globalThis.WebSocket

    this._token = ''
    this._tokenExpiresAt = 0
    this._tokenPending = null
    this._handlers = new Map()
    this._ws = null
    this._hb = null
    this._reconnectTimer = null
    this._stopped = true
    this._sessionId = ''
    this._lastSeq = null
    this._intentCandidates = [opts.intents ?? FULL_INTENTS, SAFE_INTENTS, GROUP_ONLY_INTENTS]
    this._intentIdx = 0
  }

  on(event, fn) {
    const list = this._handlers.get(event) || []
    list.push(fn)
    this._handlers.set(event, list)
    return this
  }

  off(event, fn) {
    const list = this._handlers.get(event) || []
    this._handlers.set(event, list.filter((x) => x !== fn))
    return this
  }

  _emit(event, ...args) {
    for (const fn of this._handlers.get(event) || []) {
      try {
        const r = fn(...args)
        if (r && typeof r.catch === 'function') r.catch((e) => this.logger.warn?.(`qqbot ${event} handler error:`, e.message))
      } catch (e) {
        this.logger.warn?.(`qqbot ${event} handler error:`, e.message)
      }
    }
  }

  async getAccessToken(force = false) {
    if (!force && this._token && Date.now() < this._tokenExpiresAt - 120_000) {
      return this._token
    }
    if (this._tokenPending) return this._tokenPending
    this._tokenPending = (async () => {
      try {
        const res = await this.fetchImpl(`${this.tokenBaseUrl}/app/getAppAccessToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
          body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
          signal: AbortSignal.timeout(12_000),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data?.access_token) {
          throw new Error(`获取 QQBot access_token 失败（HTTP ${res.status}）：${data?.message || JSON.stringify(data).slice(0, 160)}`)
        }
        this._token = String(data.access_token)
        this._tokenExpiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000
        return this._token
      } finally {
        this._tokenPending = null
      }
    })()
    return this._tokenPending
  }

  async _request(method, path, body, { timeoutMs = 30_000, retried401 = false } = {}) {
    const token = await this.getAccessToken()
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': this.appId,
        'User-Agent': this.userAgent,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 && !retried401) {
      this._token = ''
      return this._request(method, path, body, { timeoutMs, retried401: true })
    }
    if (res.status === 204) return {}
    const text = await res.text().catch(() => '')
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (!res.ok) {
      const err = new Error(`QQBot API ${method} ${path} 失败（HTTP ${res.status}）：${data?.message || data?.msg || text.slice(0, 200)}`)
      err.httpStatus = res.status
      err.bizCode = data?.code ?? data?.err_code
      throw err
    }
    return data
  }

  get api() {
    return {
      get: (p, q) => {
        const qs = q ? '?' + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString() : ''
        return this._request('GET', p + qs)
      },
      post: (p, b) => this._request('POST', p, b),
      put: (p, b) => this._request('PUT', p, b),
      patch: (p, b) => this._request('PATCH', p, b),
      delete: (p) => this._request('DELETE', p),
      getToken: () => this.getAccessToken(),
    }
  }

  async start() {
    if (!this.appId || !this.appSecret) throw new Error('QQBot AppID 或 AppSecret 未配置')
    if (!this.WsImpl) throw new Error('当前 Node 运行时缺少 WebSocket 支持')
    this._stopped = false
    await this.getAccessToken()
    await this._connectGateway()
  }

  stop() {
    this._stopped = true
    if (this._hb) { clearInterval(this._hb); this._hb = null }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    const ws = this._ws
    this._ws = null
    if (ws) {
      try { ws.close() } catch {}
    }
  }

  async _connectGateway() {
    if (this._stopped) return
    try {
      const token = await this.getAccessToken()
      const gw = await this._request('GET', '/gateway')
      if (this._stopped || !gw?.url) return
      const ws = new this.WsImpl(gw.url)
      this._ws = ws

      const onMsg = (ev) => {
        if (ws !== this._ws) return
        try {
          const raw = typeof ev?.data === 'string'
            ? ev.data
            : Buffer.isBuffer(ev)
              ? ev.toString('utf8')
              : ev?.data
                ? Buffer.from(ev.data).toString('utf8')
                : String(ev)
          const payload = JSON.parse(raw)
          this._handleWsPayload(ws, payload, token)
        } catch (err) {
          this.logger.warn?.('QQBot WS 消息解析失败：', err.message)
        }
      }

      const onClose = (closeEv) => {
        if (ws !== this._ws) return
        const code = typeof closeEv === 'number' ? closeEv : Number(closeEv?.code || 1000)
        const reason = typeof closeEv === 'object' ? String(closeEv?.reason || '') : ''
        if (this._hb) { clearInterval(this._hb); this._hb = null }
        this._ws = null
        if (this._stopped) return

        // Intents 权限不足自动降级重试
        if ((code === 4914 || code === 4915) && this._intentIdx + 1 < this._intentCandidates.length) {
          this._intentIdx++
          this._sessionId = ''
          this._lastSeq = null
          this.logger.warn?.(`QQBot Gateway Intents 受限（${code}），自动降级权限掩码重连…`)
          this._scheduleReconnect(1000)
          return
        }
        if (code === 4004) {
          this._token = ''
          this._sessionId = ''
          this._lastSeq = null
        } else if (code === 4006 || code === 4007 || code === 4009) {
          this._sessionId = ''
          this._lastSeq = null
        }
        this._emit('disconnected', { code, reason, willReconnect: true })
        this._scheduleReconnect(3000)
      }

      const onErr = (err) => {
        if (ws !== this._ws) return
        this._emit('error', err instanceof Error ? err : new Error(String(err?.message || 'WebSocket error')))
      }

      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('message', onMsg)
        ws.addEventListener('close', onClose)
        ws.addEventListener('error', onErr)
      } else if (typeof ws.on === 'function') {
        ws.on('message', onMsg)
        ws.on('close', (code, reason) => onClose({ code, reason: reason?.toString?.() || '' }))
        ws.on('error', onErr)
      }
    } catch (err) {
      if (this._stopped) return
      this._emit('error', err)
      this._scheduleReconnect(5000)
    }
  }

  _scheduleReconnect(delayMs) {
    if (this._stopped || this._reconnectTimer) return
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this._stopped) void this._connectGateway()
    }, delayMs)
    this._reconnectTimer?.unref?.()
  }

  _handleWsPayload(ws, payload, token) {
    const { op, d, s, t } = payload || {}
    if (s !== undefined && s !== null) this._lastSeq = s

    if (op === GatewayOp.HELLO) {
      const intents = this._intentCandidates[this._intentIdx] ?? SAFE_INTENTS
      if (this._sessionId && this._lastSeq !== null) {
        ws.send(JSON.stringify({
          op: GatewayOp.RESUME,
          d: { token: `QQBot ${token}`, session_id: this._sessionId, seq: this._lastSeq },
        }))
      } else {
        ws.send(JSON.stringify({
          op: GatewayOp.IDENTIFY,
          d: { token: `QQBot ${token}`, intents, shard: [0, 1] },
        }))
      }
      if (this._hb) clearInterval(this._hb)
      const interval = Math.max(5000, Number(d?.heartbeat_interval) || 30000)
      this._hb = setInterval(() => {
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this._lastSeq }))
        } catch {}
      }, interval)
      this._hb?.unref?.()
      return
    }

    if (op === GatewayOp.RECONNECT) {
      try { ws.close() } catch {}
      return
    }

    if (op === GatewayOp.INVALID_SESSION) {
      if (!d) { this._sessionId = ''; this._lastSeq = null }
      try { ws.close() } catch {}
      return
    }

    if (op === GatewayOp.DISPATCH) {
      const res = normalizeGatewayEvent(String(t || ''), d)
      if (res.action === 'ready') {
        this._sessionId = res.sessionId || ''
        this._emit('ready', res.data)
      } else if (res.action === 'resumed') {
        this._emit('resumed', res.data)
      } else if (res.action === 'message') {
        const mCtx = {
          bot: this,
          message: res.msg,
          replyTarget: res.msg.replyTarget,
          state: {},
          stop() {},
        }
        this._emit('message', mCtx, res.msg)
      } else if (res.action === 'interaction') {
        this._emit('interaction', { bot: this, event: res.event, state: {}, receivedAt: Date.now() }, res.event)
      } else if (res.action === 'raw') {
        this._emit('rawEvent', { bot: this, eventType: res.type, data: res.data, state: {}, receivedAt: Date.now() })
      }
    }
  }

  _msgPath(scope, targetId) {
    return scope === 'c2c' ? `/v2/users/${targetId}/messages` : `/v2/groups/${targetId}/messages`
  }

  _mediaPath(scope, targetId) {
    return scope === 'c2c' ? `/v2/users/${targetId}/files` : `/v2/groups/${targetId}/files`
  }

  async send(opts = {}) {
    const target = opts.target || {}
    const body = {
      msg_seq: target.msgId ? nextMsgSeq() : 1,
      ...(target.msgId ? { msg_id: target.msgId } : {}),
      ...(opts.msgType !== undefined ? { msg_type: opts.msgType } : {}),
      ...(opts.content !== undefined ? { content: opts.content } : {}),
      ...(opts.markdown ? { markdown: opts.markdown } : {}),
      ...(opts.ark ? { ark: opts.ark } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
      ...(opts.media ? { media: opts.media } : {}),
      ...(opts.keyboard ? { keyboard: opts.keyboard } : {}),
      ...(opts.messageReference ? { message_reference: opts.messageReference } : {}),
      ...(opts.extra || {}),
    }
    if (body.msg_type === undefined) {
      body.msg_type = body.markdown ? 2 : body.ark ? 3 : body.embed ? 4 : body.media ? 7 : 0
    }
    return this._request('POST', this._msgPath(target.scope, target.targetId), body)
  }

  async sendText(target, content, extraOpts = {}) {
    if (this.markdownSupport) {
      try {
        return await this.sendMarkdown(target, content, extraOpts)
      } catch {
        // 无 Markdown 权限时自动降级纯文本，保证消息必达
      }
    }
    return this.send({
      target,
      msgType: 0,
      content: String(content || ''),
      ...(extraOpts.messageReference ? { messageReference: { message_id: extraOpts.messageReference } } : {}),
      ...(extraOpts.eventId ? { extra: { event_id: extraOpts.eventId } } : {}),
    })
  }

  async sendMarkdown(target, content, opts = {}) {
    return this.send({
      target: opts.eventId ? { scope: target.scope, targetId: target.targetId } : target,
      msgType: 2,
      markdown: { content: String(content || '') },
      ...(opts.keyboard ? { keyboard: opts.keyboard } : {}),
      ...(opts.eventId ? { extra: { event_id: opts.eventId } } : {}),
    })
  }

  async sendChannelMessage(channelId, content, opts = {}) {
    return this._request('POST', `/channels/${channelId}/messages`, {
      content: String(content || ''),
      ...(opts.msgId ? { msg_id: opts.msgId } : {}),
      ...(opts.messageReference ? { message_reference: { message_id: opts.messageReference } } : {}),
    })
  }

  async sendDmMessage(guildId, content, opts = {}) {
    return this._request('POST', `/dms/${guildId}/messages`, {
      content: String(content || ''),
      ...(opts.msgId ? { msg_id: opts.msgId } : {}),
    })
  }

  async recallMessage(target, messageId) {
    return this._request('DELETE', `${this._msgPath(target.scope, target.targetId)}/${messageId}`)
  }

  async sendTyping(target, durationSec = 60) {
    if (target.scope !== 'c2c') return {}
    return this._request('POST', this._msgPath('c2c', target.targetId), {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: durationSec },
      msg_seq: target.msgId ? nextMsgSeq() : 1,
      ...(target.msgId ? { msg_id: target.msgId } : {}),
    })
  }

  async acknowledgeInteraction(interactionId, code = 0, data) {
    return this._request('PUT', `/interactions/${interactionId}`, { code, ...(data ? { data } : {}) })
  }

  async uploadMedia({ target, fileType, url, fileData, buffer, localPath, fileName, srvSendMsg = false }) {
    let b64 = fileData
    if (!b64 && buffer) b64 = Buffer.from(buffer).toString('base64')
    if (!b64 && localPath) b64 = readFileSync(localPath).toString('base64')
    const body = {
      file_type: fileType,
      srv_send_msg: Boolean(srvSendMsg),
      ...(url ? { url } : {}),
      ...(b64 ? { file_data: b64 } : {}),
      ...(fileType === MediaFileType.FILE && fileName ? { file_name: String(fileName) } : {}),
    }
    return this._request('POST', this._mediaPath(target.scope, target.targetId), body, { timeoutMs: 90_000 })
  }

  async sendMedia({ target, fileType, url, fileData, buffer, localPath, fileName, content }) {
    const upload = await this.uploadMedia({ target, fileType, url, fileData, buffer, localPath, fileName, srvSendMsg: false })
    const message = await this._request('POST', this._msgPath(target.scope, target.targetId), {
      msg_type: 7,
      media: { file_info: upload.file_info },
      msg_seq: target.msgId ? nextMsgSeq() : 1,
      ...(target.msgId ? { msg_id: target.msgId } : {}),
      ...(content ? { content: String(content) } : {}),
    }, { timeoutMs: 60_000 })
    return { upload, message }
  }

  sendImage(target, source, opts = {}) {
    return this.sendMedia({ target, fileType: MediaFileType.IMAGE, ...source, content: opts.content })
  }

  sendVideo(target, source, opts = {}) {
    return this.sendMedia({ target, fileType: MediaFileType.VIDEO, ...source, content: opts.content })
  }

  sendVoice(target, source) {
    return this.sendMedia({ target, fileType: MediaFileType.VOICE, ...source })
  }

  sendFile(target, source, opts = {}) {
    return this.sendMedia({ target, fileType: MediaFileType.FILE, ...source, fileName: opts.fileName, content: opts.content })
  }
}

/**
 * 被动回复窗口与额度管控器（对齐 @tencent-connect/dsh-qqbot 的 ReplyLimiter + msgid-cache + resolveReplyTarget）
 * - 群被动窗口 5 分钟，单聊被动窗口 30 分钟；
 * - 单条入站 msg_id 最多被动回复 4 条（Aurabot 拆条气泡/语音/表情包都能吃满被动回复免额度）；
 * - 超出窗口或额度时自动降级为主动推送（不带过期 msg_id，避免 QQ 平台报错 40034005）。
 */
export function createPassiveReplyTracker({ limitPerMsg = 4 } = {}) {
  const C2C_TTL_MS = 58 * 60_000
  const GROUP_TTL_MS = 58 * 60_000
  const buckets = new Map() // `${scope}:${targetId}` → Array<{ kind: 'msg'|'event', id: string, expiresAt: number }>
  const counts = new Map() // id → { used: number, expiresAt: number }

  const clean = (key) => {
    const now = Date.now()
    const list = (buckets.get(key) || []).filter((x) => x.expiresAt > now)
    if (list.length) buckets.set(key, list)
    else buckets.delete(key)
    return list
  }

  const canUse = (id) => {
    const rec = counts.get(id)
    if (!rec) return true
    if (rec.expiresAt <= Date.now()) { counts.delete(id); return false }
    return rec.used < limitPerMsg
  }

  const markUsed = (id, expiresAt) => {
    const rec = counts.get(id) || { used: 0, expiresAt }
    rec.used++
    counts.set(id, rec)
    if (counts.size > 2000) counts.delete(counts.keys().next().value)
  }

  return {
    recordInboundMsg(scope, targetId, msgId) {
      if (!targetId || !msgId) return
      const key = `${scope}:${targetId}`
      const ttl = scope === 'c2c' ? C2C_TTL_MS : GROUP_TTL_MS
      const expiresAt = Date.now() + ttl
      const list = clean(key).filter((x) => x.id !== msgId)
      list.unshift({ kind: 'msg', id: String(msgId), expiresAt })
      if (list.length > 12) list.length = 12
      buckets.set(key, list)
      if (!counts.has(String(msgId))) counts.set(String(msgId), { used: 0, expiresAt })
    },

    recordInteractionEvent(scope, targetId, eventId) {
      if (!targetId || !eventId) return
      const key = `${scope}:${targetId}`
      const expiresAt = Date.now() + GROUP_TTL_MS
      const list = clean(key).filter((x) => x.id !== eventId)
      list.unshift({ kind: 'event', id: String(eventId), expiresAt })
      if (list.length > 12) list.length = 12
      buckets.set(key, list)
      if (!counts.has(String(eventId))) counts.set(String(eventId), { used: 0, expiresAt })
    },

    resolve(scope, targetId, explicitMsgId = '', { allowEvent = false } = {}) {
      const key = `${scope}:${targetId}`
      const list = clean(key)
      const candidates = []
      if (explicitMsgId) {
        const hit = list.find((c) => c.id === String(explicitMsgId))
        if (hit) candidates.push(hit)
      }
      for (const c of list) {
        if (c.id !== String(explicitMsgId)) candidates.push(c)
      }
      for (const c of candidates) {
        if (c.kind === 'event' && !allowEvent) continue
        if (canUse(c.id)) {
          markUsed(c.id, c.expiresAt)
          return c.kind === 'event'
            ? { scope, targetId, eventId: c.id }
            : { scope, targetId, msgId: c.id }
        }
      }
      // 无可用被动 msgId → 降级为主动推送
      return { scope, targetId }
    },
  }
}
