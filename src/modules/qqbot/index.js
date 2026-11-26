// 内置模块「官方 QQBot」—— 对接 @tencent-connect/dsh-qqbot@latest（QQ 开放平台），配置入口在面板「连接」标签。
// 支持：
// 1. 手机 QQ 扫码一键绑定（复用 @tencent-connect/qqbot-connector）或自动同步 dsh-qqbot 的 cordis.patch.yml 凭据；
// 2. 双引擎协议栈：优先使用 @tencent-connect/qqbot-nodejs 官方 SDK，未安装依赖时自动回退内置 Node 22 原生协议引擎；
// 3. 被动回复窗口（群 / 单聊 58 分钟、单 msg_id 4 条额度管控 + 自动降级主动推送），完美适配大肥鱼多气泡/表情/语音回复；
// 4. 全模态支持：单聊/群聊/频道、图片/表情包下载看图、QQ 原生语音 ASR (asr_refer_text + voice_wav_url) 与 TTS 发语音条、发文件/视频、撤回、输入状态与按钮交互。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquirePlatformRouter, createVirtualIdMapper, createRuntimeAllowSync } from './router.js'
import {
  loadOfficialQqbotSdk,
  loadOfficialQrConnector,
  renderQrSvgDataUrl,
  discoverDshQqbotCredentials,
} from './sdk-loader.js'
import { LiteQQBot, createPassiveReplyTracker } from './lite.js'

const QQ_FACE_ID_TO_EMOJI = Object.freeze({
  0: '😱', 1: '😒', 2: '😍', 3: '😐', 4: '😎', 6: '🥰', 7: '🤐', 8: '😴', 9: '😭', 10: '😅',
  11: '😡', 12: '🤪', 13: '😁', 14: '🙂', 15: '☹️', 16: '😎', 18: '😫', 19: '🤮', 20: '🤭', 21: '😊',
  22: '🙄', 23: '🤨', 25: '😪', 26: '😨', 27: '😓', 28: '😄', 30: '💪', 32: '🤔', 33: '🤫', 34: '🥴',
  39: '👋', 63: '🌹', 66: '❤️', 67: '💔', 76: '👍', 97: '😅', 98: '🤏', 99: '👏', 101: '😏', 104: '🥱',
  105: '😒', 106: '🥺', 107: '😢', 108: '😈', 111: '🥺', 118: '🙏', 124: '👌', 174: '🤷', 178: '😏', 182: '🤣',
  201: '👍', 212: '🤔', 264: '🙈', 266: '😮', 267: '👨‍🦲', 269: '👀', 270: '😐', 271: '🍉', 273: '🍋', 277: '🐶',
  282: '🫡', 285: '🐟', 289: '😳', 353: '🙏', 357: '🫠',
})

const FACE_NAME_TO_EMOJI = Object.freeze({
  呲牙: '😁', 偷笑: '🤭', 调皮: '🤪', 赞: '👍', 点赞: '👍', 爱心: '❤️', 笑哭: '🤣', 捂脸: '🙈', 玫瑰: '🌹',
  流泪: '😢', 委屈: '🥺', 害羞: '🥰', 得意: '😎', 发呆: '😐', 惊讶: '😱', 发怒: '😡', 傲慢: '🤨',
  憨笑: '😄', 可怜: '🥺', 擦汗: '😅', 疑问: '🤔', 晕: '🥴', 困: '😪', 鼓掌: '👏', 心碎: '💔',
  大哭: '😭', 色: '😍', 白眼: '🙄', 哈欠: '🥱', OK: '👌', 微笑: '🙂', 撇嘴: '😒', 惊恐: '😨',
  吃瓜: '🍉', 摸鱼: '🐟', 敬礼: '🫡', 抱拳: '🙏', 拜托: '🙏', 裂开: '🫠', 斜眼笑: '😏', 暗中观察: '👀',
})

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])
const VOICE_EXTS = new Set(['.mp3', '.wav', '.silk', '.amr', '.ogg', '.aac', '.m4a'])

const parseList = (raw) => [...new Set(
  (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，;；\n]+/))
    .map((s) => String(s).trim())
    .filter(Boolean),
)]

function normalizeUrl(url) {
  const s = String(url || '').trim()
  return s.startsWith('//') ? `https:${s}` : s
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
}

function readImageSize(buf) {
  try {
    if (!buf || buf.length < 24) return { width: 0, height: 0 }
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf[0] === 0x47 && buf[1] === 0x49) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
  } catch {}
  return { width: 0, height: 0 }
}

function isVoiceContentType(ct = '', filename = '') {
  const lower = String(ct).toLowerCase()
  if (lower === 'voice' || lower.startsWith('audio/')) return true
  const ext = extname(String(filename || '')).toLowerCase()
  return ['.amr', '.silk', '.slk', '.wav', '.mp3', '.ogg'].includes(ext)
}

function isImageContentType(ct = '') {
  const lower = String(ct).toLowerCase()
  return lower === 'image' || lower.startsWith('image/')
}

function isVideoContentType(ct = '') {
  const lower = String(ct).toLowerCase()
  return lower === 'video' || lower.startsWith('video/')
}

function resolveMediaSource(src) {
  const s = String(src || '').trim()
  if (!s) return null
  if (s.startsWith('base64://')) return { buffer: Buffer.from(s.slice(9), 'base64') }
  if (/^data:[^;]+;base64,/i.test(s)) return { buffer: Buffer.from(s.replace(/^data:[^;]+;base64,/i, ''), 'base64') }
  if (s.startsWith('file://')) {
    try {
      const p = fileURLToPath(s)
      return { localPath: p, buffer: readFileSync(p) }
    } catch { return null }
  }
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) {
    try {
      if (existsSync(s)) return { localPath: s, buffer: readFileSync(s) }
    } catch { return null }
  }
  if (/^https?:\/\//i.test(s)) return { url: s }
  return null
}

function detectFfmpeg(explicit = '') {
  const candidates = [
    explicit,
    process.env.FFMPEG_PATH || '',
    'ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].map((s) => String(s || '').trim()).filter(Boolean)
  for (const bin of candidates) {
    try {
      if (isAbsolute(bin) && !existsSync(bin)) continue
      const r = spawnSync(bin, ['-version'], { timeout: 3000, stdio: 'ignore' })
      if (r.status === 0) return bin
    } catch {}
  }
  return ''
}

function ensureQqNativeVoiceBuffer(buf, localPath = '', ffmpegHint = '') {
  if (!buf || !buf.length) return buf
  // WAV / MP3 / SILK / AMR 均可直接上传给 QQ 开放平台 file_type=3
  const head4 = buf.length >= 4 ? buf.toString('ascii', 0, 4) : ''
  const head6 = buf.length >= 6 ? buf.toString('ascii', 0, 6) : ''
  const ext = extname(localPath).toLowerCase()
  if (
    head4 === 'RIFF' ||
    head4 === 'ID3\x03' || head4.startsWith('ID3') ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) ||
    head6 === '#!AMR\n' ||
    buf.subarray(0, 10).toString('latin1').includes('#!SILK') ||
    ['.wav', '.mp3', '.silk', '.amr'].includes(ext)
  ) {
    return buf
  }
  const ffmpeg = detectFfmpeg(ffmpegHint)
  if (!ffmpeg) return buf
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-tts-'))
  try {
    const input = join(dir, 'in' + (ext || '.audio'))
    const output = join(dir, 'out.wav')
    writeFileSync(input, buf)
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '24000', '-ac', '1', '-f', 'wav', output], { timeout: 20_000 })
    if (r.status === 0 && existsSync(output)) return readFileSync(output)
  } catch {} finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return buf
}

function chunkText(text, limit = 4500) {
  const s = String(text || '')
  if (s.length <= limit) return s ? [s] : []
  const chunks = []
  for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit))
  return chunks
}

/** @type {import('../aurabot.d.ts').AurabotModule} */
export default {
  id: 'qqbot',
  name: '官方 QQBot',
  version: '1.0.0',
  api: 1,
  tab: 'connect',
  description: '对接 @tencent-connect/dsh-qqbot@latest（腾讯官方 QQ 开放平台机器人）：免 SnowLuma / 免公网 IP，支持手机 QQ 扫码绑定或 AppID/AppSecret 直连。',

  defaults: {
    enabled: false,
    appId: '',
    appSecret: '',
    autoSyncFromDshPlugin: true,
    ownerOpenid: '',
    ownerSessionMode: 'shared',
    markdownSupport: false,
    c2cMode: 'open',
    c2cAllow: '',
    groupMode: 'open',
    groupAllow: '',
    requireMentionInGroup: true,
    nonMentionReplyMode: 'always',
    textChunkLimit: 4500,
    ffmpegPath: '',
  },

  settings: [
    { key: 'enabled', label: '启用官方 QQBot 接入', type: 'switch', hint: '开启后通过腾讯官方 WebSocket 网关收发 QQ 私聊与群聊（同时需打开右上角 Aurabot 总开关）' },
    { key: 'appId', label: 'QQBot AppID', type: 'text', placeholder: '留空可在下方点「手机 QQ 扫码绑定」或从环境变量 QQBOT_APPID 读取' },
    { key: 'appSecret', label: 'QQBot AppSecret', type: 'password', placeholder: '留空可扫码绑定或从环境变量 QQBOT_SECRET 读取' },
    { key: 'autoSyncFromDshPlugin', label: '自动复用 dsh-qqbot 凭据', type: 'switch', hint: '未手动填 AppID 时，自动读取 DSH 中 @tencent-connect/dsh-qqbot 扫码保存的凭据' },
    { key: 'ownerOpenid', label: '主人 User OpenID', type: 'text', placeholder: '扫码绑定后自动填入（也可发消息后从下方映射表复制）', hint: '匹配此 OpenID 的用户在官方 QQBot 中拥有完整主人权限' },
    {
      key: 'ownerSessionMode',
      label: '主人私聊会话模式',
      type: 'select',
      options: [
        { value: 'shared', label: '与原版 QQ / TG 主人共享同一记忆与私聊会话（推荐）' },
        { value: 'isolated', label: '独立虚拟会话' },
      ],
    },
    { key: 'markdownSupport', label: '启用 Markdown 消息格式', type: 'switch', hint: '仅在机器人具备官方 Markdown 权限时开启；若无权限会自动降级为纯文本保证送达' },
    {
      key: 'c2cMode',
      label: '私聊访问策略 (c2cMode)',
      type: 'select',
      options: [
        { value: 'open', label: '开放（所有人可私聊）' },
        { value: 'allowlist', label: '白名单（仅下方 OpenID 与主人可私聊）' },
        { value: 'disabled', label: '仅主人可私聊' },
      ],
    },
    { key: 'c2cAllow', label: '私聊白名单（User OpenID）', type: 'textarea', placeholder: '一行一个 QQ User OpenID' },
    {
      key: 'groupMode',
      label: '群聊访问策略 (groupMode)',
      type: 'select',
      options: [
        { value: 'open', label: '开放（机器人所在群均可触发）' },
        { value: 'allowlist', label: '白名单（仅下方 Group OpenID 可触发）' },
        { value: 'disabled', label: '关闭群聊响应' },
      ],
    },
    { key: 'groupAllow', label: '群聊白名单（Group OpenID）', type: 'textarea', placeholder: '一行一个 Group OpenID' },
    { key: 'requireMentionInGroup', label: '群聊需 @机器人 才触发', type: 'switch', hint: '注：腾讯官方平台默认只向机器人推送被 @ 的群消息（GROUP_AT_MESSAGE_CREATE）；仅当机器人开通了全量群消息权限或处于私域频道时，腾讯服务端才会推送不带 @ 的消息' },
    {
      key: 'nonMentionReplyMode',
      label: '免 @ 时的群聊回复策略',
      type: 'select',
      options: [
        { value: 'always', label: '每条普通消息都直接回（不用 @ 也不用叫名字）' },
        { value: 'aurabot', label: '按大肥鱼群聊策略（叫「大肥鱼」必回，其余按概率插话）' },
      ],
    },
    { key: 'textChunkLimit', label: '单条消息最大字数', type: 'number', min: 500, max: 5000, step: 100 },
  ],

  setup(api) {
    const router = acquirePlatformRouter(api)
    const idMap = createVirtualIdMapper({
      file: api.dataDir('id-map.json'),
      prefixUser: '81',
      prefixGroup: '82',
      prefixChannel: '83',
      prefixMsg: '89',
    })
    const allowSync = createRuntimeAllowSync(api)
    const passiveTracker = createPassiveReplyTracker({ limitPerMsg: 4 })

    // 本地缓存：消息历史、引用缓存、群成员缓存、语音附件缓存
    const msgCache = new Map() // `${chatKey}|${realMsgId}` → record
    const historyCache = new Map() // chatKey → Array<record>
    const memberCache = new Map() // groupOpenid → Map<memberOpenid, info>
    const voiceStore = new Map() // voiceKey → { url, wavUrl, asrText }
    const voiceTextByVirtMsg = new Map() // virtMsgId → asrText
    const fileUrlStore = new Map() // fileKey → url

    let botInstance = null
    let activeCredKey = ''
    let connState = 'stopped' // 'stopped' | 'connecting' | 'connected'
    let engineKind = 'lite' // 'official-sdk' | 'lite'
    let lastError = ''
    let qrBindState = { phase: 'idle', url: '', qrSvg: '', error: '', issuedAt: 0 }
    let qrDispose = null
    const counters = { inbound: 0, outbound: 0, errors: 0 }

    const effectiveSettings = () => {
      const s = api.settings()
      let appId = String(s.appId || process.env.QQBOT_APPID || '').trim()
      let appSecret = String(s.appSecret || process.env.QQBOT_SECRET || '').trim()
      let ownerOpenid = String(s.ownerOpenid || process.env.QQBOT_OWNER_OPENID || '').trim()
      let dshSynced = null

      if ((!appId || !appSecret) && s.autoSyncFromDshPlugin !== false) {
        dshSynced = discoverDshQqbotCredentials()
        if (dshSynced) {
          appId = appId || dshSynced.appId
          appSecret = appSecret || dshSynced.appSecret
          if (!ownerOpenid && dshSynced.c2cAllow?.length === 1) {
            ownerOpenid = dshSynced.c2cAllow[0]
          }
        }
      }

      return {
        ...s,
        enabled: Boolean(s.enabled),
        appId,
        appSecret,
        ownerOpenid,
        markdownSupport: Boolean(s.markdownSupport),
        textChunkLimit: Math.max(500, Math.min(5000, Number(s.textChunkLimit) || 4500)),
        ffmpegPath: String(s.ffmpegPath || api.config()?.bili?.ffmpegPath || '').trim(),
        dshDetected: dshSynced || discoverDshQqbotCredentials(),
      }
    }

    const resolveOwnerVirtId = () => {
      const s = effectiveSettings()
      if (!s.ownerOpenid) return ''
      const cfg = api.config()
      if (s.ownerSessionMode !== 'isolated' && cfg?.ownerQQ) {
        return String(cfg.ownerQQ)
      }
      const virt = idMap.toVirtualUser(s.ownerOpenid, cfg?.ownerName || '主人')
      if (cfg && !cfg.ownerQQ) cfg.ownerQQ = virt
      return virt
    }

    const toVirtUser = (openid, name = '') => {
      const s = effectiveSettings()
      if (s.ownerOpenid && String(openid) === String(s.ownerOpenid)) {
        return resolveOwnerVirtId() || idMap.toVirtualUser(openid, name)
      }
      return idMap.toVirtualUser(openid, name)
    }

    const toRealUser = (virtId) => {
      const v = String(virtId ?? '').trim()
      const s = effectiveSettings()
      if (s.ownerOpenid && v === String(api.config()?.ownerQQ || '')) return String(s.ownerOpenid)
      return idMap.toRealUser(v)
    }

    const toRealGroup = (virtGroupId) => {
      const v = String(virtGroupId ?? '').trim()
      const ch = idMap.toRealChannel(v)
      if (ch) return { kind: 'channel', id: ch }
      const g = idMap.toRealGroup(v)
      if (g) return { kind: 'group', id: g }
      return null
    }

    const isAllowedInbound = (kind, senderId, groupId) => {
      const s = effectiveSettings()
      const isOwnerMsg = Boolean(s.ownerOpenid && String(senderId) === String(s.ownerOpenid))
      if (kind === 'c2c' || kind === 'dm') {
        if (isOwnerMsg) return true
        if (s.c2cMode === 'disabled') return false
        if (s.c2cMode === 'open') return true
        const list = [...parseList(s.c2cAllow), ...(s.dshDetected?.c2cAllow || [])]
        return list.includes(String(senderId))
      }
      if (s.groupMode === 'disabled') return false
      if (s.groupMode === 'open') return true
      const gList = [...parseList(s.groupAllow), ...(s.dshDetected?.groupAllow || [])]
      return gList.includes(String(groupId))
    }

    const rememberChatMessage = (chatKey, record) => {
      if (!chatKey || !record?.realMsgId) return
      msgCache.set(`${chatKey}|${record.realMsgId}`, record)
      if (msgCache.size > 800) msgCache.delete(msgCache.keys().next().value)
      const list = historyCache.get(chatKey) || []
      if (!list.some((x) => x.realMsgId === record.realMsgId)) {
        list.push(record)
        while (list.length > 100) list.shift()
        historyCache.set(chatKey, list)
      }
    }

    async function downloadAttachmentBytes(url, maxBytes = 25 * 1024 * 1024) {
      const fullUrl = normalizeUrl(url)
      if (!/^https?:\/\//i.test(fullUrl)) return null
      try {
        const res = await fetch(fullUrl, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) return null
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf.length || buf.length > maxBytes) return null
        return buf
      } catch {
        return null
      }
    }

    // 处理 QQBot 入站消息（兼容官方 SDK 的 mCtx.message 与 LiteQQBot 的 msg）
    async function handleInboundMessage(mCtx, rawMsg) {
      const msg = rawMsg || mCtx?.message
      if (!msg || msg.senderIsBot) return

      const kind = msg.kind === 'group' || msg.kind === 'guild' ? 'group' : 'private'
      const scope = kind === 'group' ? 'group' : 'c2c'
      const senderOpenid = String(msg.senderId || '')
      const peerOpenid = msg.kind === 'group'
        ? String(msg.groupOpenid || '')
        : msg.kind === 'guild'
          ? `guild:${msg.channelId}`
          : msg.kind === 'dm'
            ? `dm:${msg.guildId}`
            : senderOpenid

      if (!senderOpenid || !peerOpenid) return

      // 始终记录被动回复 msgId 窗口
      if (msg.kind === 'c2c' || msg.kind === 'group') {
        passiveTracker.recordInboundMsg(scope, peerOpenid, msg.messageId)
      }

      if (!isAllowedInbound(msg.kind, senderOpenid, peerOpenid)) return

      const s = effectiveSettings()
      const appId = s.appId
      const rawContent = String(msg.content || '')
      const wasMentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
        || msg.rawEventType === 'AT_MESSAGE_CREATE'
        || (appId && (rawContent.includes(`<@!${appId}>`) || rawContent.includes(`<@${appId}>`)))
        || (Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.bot || String(m?.id || '') === appId))

      const quotedReply = Boolean(Array.isArray(msg.msgElements) && msg.msgElements.length > 0 && (msg.msgType === 103 || msg.refMsgIdx))
      if (kind === 'group' && s.requireMentionInGroup && !wasMentioned && !quotedReply) return

      counters.inbound++
      const cleanContent = rawContent
        .replace(/<@![^>]+>/g, '')
        .replace(/<@[^>]+>/g, '')
        .trim()

      const displayName = String(msg.senderName || `QQ用户_${senderOpenid.slice(0, 6)}`)
      if (msg.kind === 'group' && peerOpenid) {
        let gmap = memberCache.get(peerOpenid)
        if (!gmap) { gmap = new Map(); memberCache.set(peerOpenid, gmap) }
        gmap.set(senderOpenid, {
          openid: senderOpenid,
          nickname: displayName,
          join_time: Math.floor(Date.now() / 1000),
        })
      }

      const isOwnerMsg = Boolean(s.ownerOpenid && senderOpenid === String(s.ownerOpenid))
      const virtUserId = toVirtUser(senderOpenid, isOwnerMsg ? (api.config()?.ownerName || '主人') : displayName)
      const virtGroupId = kind === 'group'
        ? (peerOpenid.startsWith('guild:')
            ? idMap.toVirtualChannel(peerOpenid, `频道_${msg.channelId}`)
            : idMap.toVirtualGroup(peerOpenid, `QQ群_${peerOpenid.slice(0, 6)}`))
        : ''

      if (kind === 'private') {
        if (isOwnerMsg) router.markOwnerActive('qqbot')
        if (virtUserId !== String(api.config()?.ownerQQ || '')) allowSync.allowPrivate(virtUserId)
      } else if (virtGroupId) {
        allowSync.allowGroup(virtGroupId)
      }

      const chatKey = `${scope}:${peerOpenid}`
      const virtMsgId = idMap.rememberMessage(`${chatKey}|${msg.messageId}`, {
        chatKey,
        scope,
        rawKind: msg.kind,
        peerOpenid,
        channelId: msg.channelId || '',
        guildId: msg.guildId || '',
        realMsgId: msg.messageId,
        senderOpenid,
        virtUserId,
        virtGroupId,
      })

      // 解析附件：图片 / 表情包 / 语音 / 文件
      const images = []
      const stickers = []
      const records = []
      const files = []
      let extraText = cleanContent

      for (const att of Array.isArray(msg.attachments) ? msg.attachments : []) {
        if (!att) continue
        if (isVoiceContentType(att.content_type, att.filename)) {
          const vKey = `qqvoice:${virtMsgId}:${records.length}`
          voiceStore.set(vKey, {
            url: normalizeUrl(att.url || ''),
            wavUrl: normalizeUrl(att.voice_wav_url || ''),
            asrText: String(att.asr_refer_text || '').trim(),
          })
          if (voiceStore.size > 500) voiceStore.delete(voiceStore.keys().next().value)
          if (att.asr_refer_text) voiceTextByVirtMsg.set(String(virtMsgId), String(att.asr_refer_text).trim())
          records.push({
            type: 'record',
            data: { file: vKey, url: normalizeUrl(att.voice_wav_url || att.url || '') },
          })
          continue
        }

        if (isImageContentType(att.content_type)) {
          const buf = att.url ? await downloadAttachmentBytes(att.url) : null
          if (buf) {
            const mime = detectMime(buf)
            const dim = readImageSize(buf)
            const w = dim.width || Number(att.width) || 0
            const h = dim.height || Number(att.height) || 0
            const ratio = w > 0 && h > 0 ? w / h : 1
            const fitsStickerBox = w > 0 && h > 0
              ? (w <= 520 && h <= 520 && ratio >= 0.5 && ratio <= 2.0)
              : buf.length <= 512 * 1024
            const isStickerLike = mime === 'image/gif'
              ? (w === 0 || (w <= 600 && h <= 600))
              : ((mime === 'image/webp' && fitsStickerBox) || (w > 0 && w <= 360 && h > 0 && h <= 360 && ratio >= 0.65 && ratio <= 1.55))
            const seg = {
              type: 'image',
              data: {
                file: 'base64://' + buf.toString('base64'),
                ...(isStickerLike ? { sub_type: 1 } : {}),
              },
              mediaType: mime.startsWith('image/') ? mime : 'image/png',
            }
            if (isStickerLike) stickers.push(seg)
            else images.push(seg)
          }
          continue
        }

        if (isVideoContentType(att.content_type)) {
          if (!extraText) extraText = `[视频 ${att.filename || ''}]`.trim()
          continue
        }

        // 普通文件附件
        const fname = String(att.filename || 'file')
        const fKey = `qqfile:${virtMsgId}:${files.length}`
        if (att.url) fileUrlStore.set(fKey, normalizeUrl(att.url))
        files.push({
          name: fname,
          size: Number(att.size) || 0,
          id: fKey,
          file_id: fKey,
          url: normalizeUrl(att.url || ''),
        })
        if (!extraText) extraText = `[文件 ${fname}]`
      }

      // 解析引用消息（来自 msgElements[0]）
      let virtReplyId = ''
      if (Array.isArray(msg.msgElements) && msg.msgElements.length > 0 && (msg.msgType === 103 || msg.refMsgIdx)) {
        const quotedEl = msg.msgElements[0]
        if (quotedEl && (quotedEl.content || quotedEl.attachments?.length)) {
          const qId = String(quotedEl.msg_idx || msg.refMsgIdx || `ref_${msg.messageId}`)
          virtReplyId = idMap.rememberMessage(`${chatKey}|${qId}`, {
            chatKey,
            scope,
            peerOpenid,
            realMsgId: qId,
          })
          if (!msgCache.has(`${chatKey}|${qId}`)) {
            rememberChatMessage(chatKey, {
              realMsgId: qId,
              kind,
              senderOpenid: '',
              nickname: '引用消息',
              time: Math.floor(Date.now() / 1000),
              text: String(quotedEl.content || '').trim(),
              segments: [{ type: 'text', data: { text: String(quotedEl.content || '').trim() } }],
            })
          }
        }
      }

      const botSelfId = String(api.config()?.botQQ || '800000000001')
      const onebotSegs = []
      if (virtReplyId) onebotSegs.push({ type: 'reply', data: { id: virtReplyId } })
      if (wasMentioned) onebotSegs.push({ type: 'at', data: { qq: botSelfId } })
      if (extraText) onebotSegs.push({ type: 'text', data: { text: extraText } })
      for (const img of images) onebotSegs.push(img)
      for (const st of stickers) onebotSegs.push(st)
      for (const rec of records) onebotSegs.push(rec)
      for (const f of files) onebotSegs.push({ type: 'file', data: f })

      if (!onebotSegs.length && !wasMentioned) return

      const timeSec = msg.timestamp ? Math.floor(new Date(msg.timestamp).getTime() / 1000) || Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000)
      rememberChatMessage(chatKey, {
        realMsgId: msg.messageId,
        kind,
        senderOpenid,
        nickname: displayName,
        time: timeSec,
        text: extraText,
        segments: onebotSegs,
      })

      const onebotEv = {
        _fromPlatformModule: 'qqbot',
        post_type: 'message',
        message_type: kind,
        sub_type: kind === 'group' ? 'normal' : 'friend',
        self_id: Number(botSelfId) || botSelfId,
        user_id: Number(virtUserId),
        ...(virtGroupId ? { group_id: Number(virtGroupId) } : {}),
        message_id: Number(virtMsgId),
        time: timeSec,
        sender: {
          user_id: Number(virtUserId),
          nickname: displayName,
          card: displayName,
          role: isOwnerMsg ? 'owner' : 'member',
        },
        message: onebotSegs,
        raw_message: extraText || '',
      }

      api.emit('onebot', onebotEv)
      if (kind === 'private' && extraText) {
        if (api.core.dangerGuard?.handleReply?.(`private:${virtUserId}`, virtUserId, extraText)) return
        if (api.core.approvalRelay?.handleReply?.(`private:${virtUserId}`, virtUserId, extraText)) return
      }
      await api.core.hub.onMessage(onebotEv)
    }

    // 处理按钮交互回调（INTERACTION_CREATE）
    async function handleInteraction(_iCtx, event) {
      if (!event?.id || !botInstance) return
      const scope = event.scene === 'group' ? 'group' : 'c2c'
      const targetOpenid = scope === 'group' ? String(event.group_openid || event.user_openid || '') : String(event.user_openid || '')
      if (targetOpenid) passiveTracker.recordInteractionEvent(scope, targetOpenid, event.id)
      const btnData = String(event.data?.resolved?.button_data || '').trim()
      if (btnData && scope === 'c2c' && event.user_openid) {
        const virtUid = toVirtUser(event.user_openid)
        api.core.dangerGuard?.handleReply?.(`private:${virtUid}`, virtUid, btnData)
        api.core.approvalRelay?.handleReply?.(`private:${virtUid}`, virtUid, btnData)
      }
      try { await botInstance.acknowledgeInteraction(event.id, 0) } catch {}
    }

    // 发送 OneBot 消息段到腾讯官方 QQBot
    async function sendSegmentsToQqbot(scope, targetInfo, segments) {
      if (!botInstance) throw new Error('官方 QQBot 尚未连接')
      const s = effectiveSettings()
      const segList = Array.isArray(segments) ? segments : [{ type: 'text', data: { text: String(segments ?? '') } }]

      let explicitRealReplyId = ''
      const replySeg = segList.find((x) => x?.type === 'reply' && x.data?.id)
      if (replySeg) {
        const hit = idMap.resolveMessage(replySeg.data.id)
        if (hit?.realMsgId) explicitRealReplyId = String(hit.realMsgId)
      }

      const textParts = []
      for (const seg of segList) {
        if (!seg) continue
        if (seg.type === 'text') {
          const replaced = String(seg.data?.text || '').replace(
            /<\s*face\s*[:：]\s*([^>\s]{1,20})\s*>/gi,
            (_m, name) => FACE_NAME_TO_EMOJI[String(name).trim()] || '',
          )
          textParts.push(replaced)
        } else if (seg.type === 'face') {
          const emoji = QQ_FACE_ID_TO_EMOJI[String(seg.data?.id ?? '')] || FACE_NAME_TO_EMOJI[String(seg.data?.id ?? '')] || ''
          if (emoji) textParts.push(emoji)
        } else if (seg.type === 'at' && seg.data?.qq) {
          if (String(seg.data.qq) === 'all') textParts.push('@全体成员 ')
          else if (seg.data.name) textParts.push(`@${seg.data.name} `)
        }
      }
      const fullText = textParts.join('')

      // 频道子频道 / 频道私信分支
      if (targetInfo.kind === 'channel') {
        const rawId = String(targetInfo.id)
        if (rawId.startsWith('guild:')) {
          const res = await botInstance.sendChannelMessage(rawId.slice(6), fullText || '[消息]', { msgId: explicitRealReplyId || undefined })
          counters.outbound++
          return res
        }
        if (rawId.startsWith('dm:')) {
          const res = await botInstance.sendDmMessage(rawId.slice(3), fullText || '[消息]', { msgId: explicitRealReplyId || undefined })
          counters.outbound++
          return res
        }
      }

      const targetOpenid = String(targetInfo.id)
      const imageSeg = segList.find((x) => x?.type === 'image' || x?.type === 'mface')
      const recordSeg = segList.find((x) => x?.type === 'record')
      const videoSeg = segList.find((x) => x?.type === 'video')
      const fileSeg = segList.find((x) => x?.type === 'file')
      const cardSeg = segList.find((x) => ['share', 'music', 'location', 'contact', 'dice', 'rps'].includes(x?.type))

      let lastRes = null

      if (recordSeg) {
        const src = resolveMediaSource(recordSeg.data?.file || recordSeg.data?.url)
        if (src) {
          const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: false })
          const voiceBuf = src.buffer ? ensureQqNativeVoiceBuffer(src.buffer, src.localPath || '', s.ffmpegPath) : undefined
          const sent = await botInstance.sendVoice(resolvedTarget, voiceBuf ? { buffer: voiceBuf } : { url: src.url })
          lastRes = sent?.message || sent
          counters.outbound++
        }
        if (fullText.trim()) {
          const textTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: true })
          lastRes = await sendTextOrMarkdownSafe(textTarget, fullText)
        }
        return lastRes
      }

      if (imageSeg) {
        const src = resolveMediaSource(imageSeg.data?.file || imageSeg.data?.url)
        if (src) {
          const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: false })
          const sent = await botInstance.sendImage(
            resolvedTarget,
            src.buffer ? { buffer: src.buffer } : { url: src.url },
            fullText.length <= 200 && fullText.trim() ? { content: fullText } : undefined,
          )
          lastRes = sent?.message || sent
          counters.outbound++
          if (fullText.length > 200) {
            const textTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: true })
            lastRes = await sendTextOrMarkdownSafe(textTarget, fullText)
          }
          return lastRes
        }
      }

      if (videoSeg) {
        const src = resolveMediaSource(videoSeg.data?.file || videoSeg.data?.url)
        if (src) {
          const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: false })
          const sent = await botInstance.sendVideo(resolvedTarget, src.buffer ? { buffer: src.buffer } : { url: src.url })
          lastRes = sent?.message || sent
          counters.outbound++
          return lastRes
        }
      }

      if (fileSeg) {
        return sendMediaFileToQqbot(scope, targetOpenid, fileSeg.data?.file || fileSeg.data?.url, fileSeg.data?.name, explicitRealReplyId)
      }

      if (cardSeg) {
        const d = cardSeg.data || {}
        const cardText = [d.title ? `【${d.title}】` : '', d.content || '', d.url || ''].filter(Boolean).join('\n') || `[${cardSeg.type}]`
        const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: true })
        return sendTextOrMarkdownSafe(resolvedTarget, cardText)
      }

      if (fullText.trim()) {
        for (const chunk of chunkText(fullText, s.textChunkLimit)) {
          const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: true })
          lastRes = await sendTextOrMarkdownSafe(resolvedTarget, chunk)
        }
      }
      return lastRes
    }

    async function sendTextOrMarkdownSafe(resolvedTarget, content) {
      const s = effectiveSettings()
      counters.outbound++
      if (s.markdownSupport) {
        try {
          if (resolvedTarget.eventId && typeof botInstance.send === 'function') {
            return await botInstance.send({
              target: { scope: resolvedTarget.scope, targetId: resolvedTarget.targetId },
              msgType: 2,
              markdown: { content },
              extra: { event_id: resolvedTarget.eventId },
            })
          }
          return await botInstance.sendMarkdown(resolvedTarget, content)
        } catch {
          // 降级纯文本
        }
      }
      if (resolvedTarget.eventId && typeof botInstance.send === 'function') {
        return botInstance.send({
          target: { scope: resolvedTarget.scope, targetId: resolvedTarget.targetId },
          msgType: 0,
          content,
          extra: { event_id: resolvedTarget.eventId },
        })
      }
      return botInstance.sendText(resolvedTarget, content)
    }

    // 对齐 @tencent-connect/dsh-qqbot 的 sendMediaFile 按扩展名四路投递
    async function sendMediaFileToQqbot(scope, targetOpenid, fileOrUrl, fileName, explicitRealReplyId = '') {
      if (!botInstance) throw new Error('官方 QQBot 尚未连接')
      const src = resolveMediaSource(fileOrUrl)
      if (!src) throw new Error('无法读取要发送的文件：' + fileOrUrl)
      const name = String(fileName || (src.localPath ? basename(src.localPath) : 'file')).trim() || 'file'
      const ext = extname(name || src.localPath || '').toLowerCase()
      const resolvedTarget = passiveTracker.resolve(scope, targetOpenid, explicitRealReplyId, { allowEvent: false })
      const payload = src.buffer ? { buffer: src.buffer } : { url: src.url }

      let res
      if (IMAGE_EXTS.has(ext)) {
        res = await botInstance.sendImage(resolvedTarget, payload)
      } else if (VIDEO_EXTS.has(ext)) {
        res = await botInstance.sendVideo(resolvedTarget, payload)
      } else if (VOICE_EXTS.has(ext)) {
        const vBuf = src.buffer ? ensureQqNativeVoiceBuffer(src.buffer, src.localPath || name, effectiveSettings().ffmpegPath) : undefined
        res = await botInstance.sendVoice(resolvedTarget, vBuf ? { buffer: vBuf } : payload)
      } else {
        res = await botInstance.sendFile(resolvedTarget, payload, { fileName: name })
      }
      counters.outbound++
      return res?.message || res
    }

    // 启动 / 停止 / 重连 QQBot 网关
    async function stopBot() {
      const b = botInstance
      botInstance = null
      activeCredKey = ''
      connState = 'stopped'
      if (b) {
        try { b.stop() } catch {}
      }
    }

    async function startBot(forceRestart = false) {
      const s = effectiveSettings()
      if (!s.enabled || !s.appId || !s.appSecret) {
        await stopBot()
        return
      }
      const credKey = `${s.appId}:${s.appSecret}:${s.markdownSupport}`
      if (!forceRestart && botInstance && activeCredKey === credKey && connState !== 'stopped') {
        return
      }
      await stopBot()
      connState = 'connecting'
      lastError = ''
      activeCredKey = credKey

      const officialSdk = await loadOfficialQqbotSdk()
      let bot
      if (officialSdk?.QQBot) {
        engineKind = 'official-sdk'
        bot = new officialSdk.QQBot({
          appId: s.appId,
          appSecret: s.appSecret,
          markdownSupport: s.markdownSupport,
          transport: 'websocket',
          baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
          tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://bots.qq.com',
          logger: api.log,
        })
      } else {
        engineKind = 'lite'
        bot = new LiteQQBot({
          appId: s.appId,
          appSecret: s.appSecret,
          markdownSupport: s.markdownSupport,
          logger: api.log,
        })
      }

      botInstance = bot
      bot.on('ready', () => {
        if (botInstance !== bot) return
        connState = 'connected'
        lastError = ''
        api.log.info(`官方 QQBot 已连接（AppID=${s.appId}，引擎=${engineKind}）`)
      })
      try {
        bot.on('resumed', () => {
          if (botInstance === bot) connState = 'connected'
        })
      } catch {}
      try {
        bot.on('disconnected', (ev) => {
          if (botInstance !== bot) return
          if (!ev?.willReconnect) connState = 'stopped'
        })
      } catch {}
      bot.on('error', (err) => {
        if (botInstance !== bot) return
        counters.errors++
        lastError = String(err?.message || err)
        api.log.warn('官方 QQBot 错误：', lastError)
      })
      bot.on('message', (mCtx, rawMsg) => {
        if (botInstance !== bot) return
        handleInboundMessage(mCtx, rawMsg).catch((err) => {
          counters.errors++
          api.log.warn('处理官方 QQBot 入站消息失败：', err.message)
        })
      })
      bot.on('interaction', (iCtx, event) => {
        if (botInstance !== bot) return
        handleInteraction(iCtx, event).catch(() => {})
      })

      try {
        // 官方 SDK 的 start() 在 WS 关闭前一直挂起，不阻塞当前调用链
        const p = bot.start()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (botInstance !== bot) return
            connState = 'stopped'
            lastError = String(err?.message || err)
            api.log.warn('官方 QQBot 连接断开：', lastError)
          })
        }
      } catch (err) {
        connState = 'stopped'
        lastError = String(err?.message || err)
        throw err
      }
    }

    // 扫码绑定流程（对接 @tencent-connect/qqbot-connector）
    async function startQrBindFlow() {
      const connector = await loadOfficialQrConnector()
      if (!connector || typeof connector.startQrConnect !== 'function') {
        qrBindState = {
          phase: 'failed',
          url: '',
          qrSvg: '',
          error: '未检测到 @tencent-connect/qqbot-connector。请在 modules/qqbot 目录执行 npm install，或在 DSH 中安装 @tencent-connect/dsh-qqbot@latest。',
          issuedAt: Date.now(),
        }
        return { ok: false, message: qrBindState.error }
      }

      if (qrDispose) {
        try { qrDispose() } catch {}
        qrDispose = null
      }

      qrBindState = { phase: 'starting', url: '', qrSvg: '', error: '', issuedAt: Date.now() }
      const ctl = new AbortController()

      const stopFn = connector.startQrConnect(
        {
          onQrDisplayed: async (url) => {
            const qrSvg = await renderQrSvgDataUrl(url)
            qrBindState = { phase: 'waiting', url, qrSvg, error: '', issuedAt: Date.now() }
            api.log.info(`官方 QQBot 扫码绑定链接已生成：${url}`)
          },
          onQrExpired: () => {
            qrBindState = { ...qrBindState, phase: 'expired', error: '二维码已过期，请点击刷新二维码' }
          },
          onSuccess: (creds) => {
            const cred = Array.isArray(creds) ? creds[0] : creds
            qrDispose = null
            if (!cred?.appId || !cred?.appSecret) {
              qrBindState = { phase: 'failed', url: '', qrSvg: '', error: '扫码未返回有效凭据', issuedAt: Date.now() }
              return
            }
            qrBindState = { phase: 'bound', url: '', qrSvg: '', error: '', issuedAt: Date.now() }
            const cur = api.settings()
            api.saveSettings({
              ...cur,
              enabled: true,
              appId: cred.appId,
              appSecret: cred.appSecret,
              ...(cred.userOpenid ? { ownerOpenid: cred.userOpenid } : {}),
            })
            api.log.info(`✔ 官方 QQBot 扫码绑定成功！AppID=${cred.appId}`)
            startBot(true).catch(() => {})
          },
          onFailure: (err) => {
            qrDispose = null
            if (ctl.signal.aborted) return
            qrBindState = { phase: 'failed', url: '', qrSvg: '', error: String(err?.message || err), issuedAt: Date.now() }
          },
        },
        {
          displayQrCodeToConsole: false,
          signal: ctl.signal,
          source: 'dsh-qqbot',
        },
      )

      qrDispose = () => {
        ctl.abort()
        try { stopFn?.() } catch {}
      }

      return { ok: true, message: '正在生成手机 QQ 绑定二维码…' }
    }

    // OneBot 动作桥接适配器
    const adapter = {
      isReady: () => connState === 'connected' && Boolean(botInstance),
      hasOwner: () => Boolean(effectiveSettings().ownerOpenid),
      ownsTarget(action, params = {}) {
        if (params.group_id != null && idMap.isVirtualGroup(params.group_id)) return true
        if (params.user_id != null && idMap.isVirtualUser(params.user_id)) return true
        if (params.message_id != null && idMap.isVirtualMsg(params.message_id)) return true
        if (typeof params.file === 'string' && (params.file.startsWith('qqvoice:') || params.file.startsWith('qqfile:'))) return true
        if (typeof params.file_id === 'string' && params.file_id.startsWith('qqfile:')) return true
        return false
      },
      async handleCall(action, params = {}, opts = {}) {
        switch (action) {
          case 'get_login_info': {
            const s = effectiveSettings()
            return { user_id: Number(api.config()?.botQQ || '800000000001'), nickname: `QQBot(${s.appId || '未配置'})` }
          }
          case 'send_private_msg': {
            const realOpenid = toRealUser(params.user_id)
            if (!realOpenid) throw new Error(`找不到对应的 QQBot 用户 OpenID：${params.user_id}`)
            const isGuildDm = realOpenid.startsWith('dm:')
            const res = await sendSegmentsToQqbot('c2c', { kind: isGuildDm ? 'channel' : 'c2c', id: realOpenid }, params.message)
            const realMid = String(res?.id || res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`c2c:${realOpenid}|${realMid}`, { chatKey: `c2c:${realOpenid}`, scope: 'c2c', peerOpenid: realOpenid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : undefined }
          }
          case 'send_group_msg': {
            const tgt = toRealGroup(params.group_id)
            if (!tgt) throw new Error(`找不到对应的 QQBot 群 OpenID：${params.group_id}`)
            const res = await sendSegmentsToQqbot('group', tgt, params.message)
            const realMid = String(res?.id || res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`group:${tgt.id}|${realMid}`, { chatKey: `group:${tgt.id}`, scope: 'group', peerOpenid: tgt.id, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : undefined }
          }
          case 'send_msg': {
            const isGroup = params.message_type === 'group' || params.group_id != null
            return isGroup
              ? this.handleCall('send_group_msg', params, opts)
              : this.handleCall('send_private_msg', params, opts)
          }
          case 'upload_private_file': {
            const realOpenid = toRealUser(params.user_id)
            if (!realOpenid) throw new Error(`找不到对应的 QQBot 用户 OpenID：${params.user_id}`)
            const res = await sendMediaFileToQqbot('c2c', realOpenid, params.file, params.name)
            const realMid = String(res?.id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`c2c:${realOpenid}|${realMid}`, { chatKey: `c2c:${realOpenid}`, scope: 'c2c', peerOpenid: realOpenid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : undefined }
          }
          case 'upload_group_file': {
            const tgt = toRealGroup(params.group_id)
            if (!tgt) throw new Error(`找不到对应的 QQBot 群 OpenID：${params.group_id}`)
            const res = await sendMediaFileToQqbot('group', tgt.id, params.file, params.name)
            const realMid = String(res?.id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`group:${tgt.id}|${realMid}`, { chatKey: `group:${tgt.id}`, scope: 'group', peerOpenid: tgt.id, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : undefined }
          }
          case 'fetch_ptt_text': {
            const text = voiceTextByVirtMsg.get(String(params.message_id || '')) || ''
            return { text }
          }
          case 'get_record': {
            const vInfo = voiceStore.get(String(params.file || ''))
            const wavUrl = vInfo?.wavUrl || vInfo?.url || (typeof params.file === 'string' && /^https?:\/\//i.test(params.file) ? params.file : '')
            if (!wavUrl) throw new Error('找不到 QQBot 语音音频地址')
            const buf = await downloadAttachmentBytes(wavUrl, 30 * 1024 * 1024)
            if (!buf) throw new Error('下载 QQBot 语音失败')
            if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
              return { base64: buf.toString('base64') }
            }
            const ffmpeg = detectFfmpeg(effectiveSettings().ffmpegPath)
            if (!ffmpeg) throw new Error('当前语音不是 WAV，且未检测到 ffmpeg')
            const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-asr-'))
            try {
              const input = join(dir, 'in.audio')
              const output = join(dir, 'out.wav')
              writeFileSync(input, buf)
              const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', output], { timeout: 20_000 })
              if (r.status !== 0) throw new Error('ffmpeg 解码 QQBot 语音失败')
              return { base64: readFileSync(output).toString('base64') }
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
          }
          case 'get_group_file_url':
          case 'get_private_file_url': {
            const key = String(params.file_id || params.file || '')
            return { url: fileUrlStore.get(key) || '' }
          }
          case 'get_msg': {
            const ref = idMap.resolveMessage(params.message_id)
            if (!ref) throw new Error('找不到引用的 QQBot 消息')
            const hit = msgCache.get(`${ref.chatKey}|${ref.realMsgId}`)
            if (!hit) throw new Error('引用的 QQBot 消息不在缓存中')
            const senderVirt = hit.senderOpenid ? toVirtUser(hit.senderOpenid, hit.nickname) : String(api.config()?.botQQ || '800000000001')
            return {
              message_id: Number(params.message_id),
              message_type: hit.kind,
              group_id: ref.virtGroupId ? Number(ref.virtGroupId) : undefined,
              user_id: Number(senderVirt),
              time: hit.time,
              sender: { user_id: Number(senderVirt), nickname: hit.nickname, card: hit.nickname },
              message: hit.segments,
              raw_message: hit.text,
            }
          }
          case 'delete_msg': {
            const ref = idMap.resolveMessage(params.message_id)
            if (ref?.peerOpenid && ref?.realMsgId && botInstance?.recallMessage) {
              await botInstance.recallMessage({ scope: ref.scope || 'c2c', targetId: ref.peerOpenid }, ref.realMsgId)
            }
            return {}
          }
          case 'set_input_status': {
            const realOpenid = toRealUser(params.user_id)
            if (realOpenid && botInstance?.sendTyping) {
              const tgt = passiveTracker.resolve('c2c', realOpenid, '', { allowEvent: false })
              await botInstance.sendTyping(tgt, 60).catch(() => {})
            }
            return {}
          }
          case 'get_group_member_info': {
            const tgt = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            if (!tgt || !realUid) return null
            const hit = memberCache.get(tgt.id)?.get(realUid)
            return {
              user_id: Number(params.user_id),
              group_id: Number(params.group_id),
              nickname: hit?.nickname || `QQ用户_${realUid.slice(0, 6)}`,
              card: hit?.nickname || `QQ用户_${realUid.slice(0, 6)}`,
              role: 'member',
              join_time: hit?.join_time || 1,
            }
          }
          case 'get_group_member_list': {
            const tgt = toRealGroup(params.group_id)
            if (!tgt) return []
            const map = memberCache.get(tgt.id)
            if (!map) return []
            return [...map.values()].map((m) => ({
              user_id: Number(toVirtUser(m.openid, m.nickname)),
              group_id: Number(params.group_id),
              nickname: m.nickname,
              card: m.nickname,
              role: 'member',
              join_time: m.join_time || 1,
            }))
          }
          case 'get_group_list': {
            const items = idMap.snapshot(100).filter((x) => x.kind === 'group' || x.kind === 'channel')
            return items.map((g) => ({ group_id: Number(g.virtId), group_name: g.name || `QQBot群_${g.rawId.slice(0, 6)}` }))
          }
          case 'get_friend_list': {
            const items = idMap.snapshot(100).filter((x) => x.kind === 'private')
            return items.map((u) => ({ user_id: Number(u.virtId), nickname: u.name || `QQBot用户_${u.rawId.slice(0, 6)}`, remark: '' }))
          }
          case 'get_group_msg_history':
          case 'get_friend_msg_history': {
            const isGroup = action === 'get_group_msg_history'
            const peer = isGroup ? toRealGroup(params.group_id)?.id : toRealUser(params.user_id)
            if (!peer) return { messages: [] }
            const chatKey = `${isGroup ? 'group' : 'c2c'}:${peer}`
            const list = (historyCache.get(chatKey) || []).slice()
            const n = Math.max(1, Math.min(50, Number(params.count) || 20))
            const anchorRef = params.message_id ? idMap.resolveMessage(params.message_id) : null
            let sliced = list
            if (anchorRef?.realMsgId) {
              const idx = list.findIndex((x) => x.realMsgId === anchorRef.realMsgId)
              if (idx >= 0) sliced = list.slice(Math.max(0, idx - n), idx)
            } else {
              sliced = list.slice(-n)
            }
            return {
              messages: sliced.map((item) => {
                const vMid = idMap.rememberMessage(`${chatKey}|${item.realMsgId}`, { chatKey, scope: isGroup ? 'group' : 'c2c', peerOpenid: peer, realMsgId: item.realMsgId })
                const vUid = item.senderOpenid ? toVirtUser(item.senderOpenid, item.nickname) : String(api.config()?.botQQ || '800000000001')
                return {
                  message_id: Number(vMid),
                  message_type: item.kind,
                  group_id: isGroup ? Number(params.group_id) : undefined,
                  user_id: Number(vUid),
                  time: item.time,
                  sender: { user_id: Number(vUid), nickname: item.nickname, card: item.nickname },
                  message: item.segments,
                  raw_message: item.text,
                }
              }),
            }
          }
          default:
            return {}
        }
      },
    }

    const unregisterRouter = router.register('qqbot', adapter)

    // 关掉「群聊需 @机器人 才触发」且策略为 always 时，覆盖大肥鱼默认的插话概率限制，让不带 @ 的群消息直接必回
    api.on('group/decide', (decision, info) => {
      const m = info?.msg
      if (!m || !idMap.isVirtualGroup(m.groupId)) return undefined
      const s = effectiveSettings()
      if (!s.requireMentionInGroup && s.nonMentionReplyMode !== 'aurabot') {
        if (!decision?.reply && !m.atOthers) {
          return { ...decision, reply: true, mode: 'must', reason: '官方 QQBot 群聊免 @ 直回' }
        }
      }
      return undefined
    })

    const syncAll = () => {
      const s = effectiveSettings()
      resolveOwnerVirtId()
      for (const uid of parseList(s.c2cAllow)) allowSync.allowPrivate(toVirtUser(uid))
      for (const gid of parseList(s.groupAllow)) allowSync.allowGroup(idMap.toVirtualGroup(gid))
      if (s.enabled && s.appId && s.appSecret) {
        startBot(false).catch(() => {})
      } else if (connState !== 'stopped') {
        stopBot().catch(() => {})
      }
    }

    api.on('config', () => syncAll())
    api.every(25_000, () => {
      const s = effectiveSettings()
      if (s.enabled && s.appId && s.appSecret && connState === 'stopped') {
        startBot(true).catch(() => {})
      }
    }, '官方 QQBot 守护')
    api.later(250, () => syncAll())

    // 面板 HTTP 路由（内置模块无 /ext/qqbot 前缀，必须自带 /qqbot/ 前缀）
    api.route('/qqbot/status', async () => {
      const s = effectiveSettings()
      const officialSdk = await loadOfficialQqbotSdk()
      const connector = await loadOfficialQrConnector()
      return {
        ok: true,
        state: connState,
        enabled: s.enabled,
        appId: s.appId ? `${s.appId.slice(0, 4)}****${s.appId.slice(-2)}` : '',
        rawAppId: s.appId || '',
        hasCredentials: Boolean(s.appId && s.appSecret),
        ownerOpenid: s.ownerOpenid || '',
        settings: {
          enabled: Boolean(s.enabled),
          appId: s.appId || '',
          appSecretSet: Boolean(s.appSecret),
          ownerOpenid: s.ownerOpenid || '',
          requireMentionInGroup: Boolean(s.requireMentionInGroup),
          nonMentionReplyMode: s.nonMentionReplyMode === 'aurabot' ? 'aurabot' : 'always',
          markdownSupport: Boolean(s.markdownSupport),
        },
        engine: officialSdk?.QQBot ? 'official-sdk (@tencent-connect/qqbot-nodejs)' : 'lite (内置 Node 原生引擎)',
        qrSupported: Boolean(connector?.startQrConnect),
        dshPlugin: s.dshDetected
          ? {
              found: true,
              profileName: s.dshDetected.profileName,
              appId: s.dshDetected.appId,
              coexistingActivePlugin: Boolean(s.dshDetected.coexistingActivePlugin && s.dshDetected.appId === s.appId && s.enabled),
            }
          : { found: false },
        qrBind: qrBindState,
        lastError,
        counters: { ...counters },
        mappings: idMap.snapshot(25),
      }
    })

    api.route('/qqbot/save', async (req) => {
      const body = (await api.core.http.body(req)) || {}
      const cur = api.settings()
      const patch = {}
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
      if (body.appId !== undefined) patch.appId = String(body.appId || '').trim()
      if (typeof body.appSecret === 'string' && body.appSecret.trim() !== '') {
        patch.appSecret = body.appSecret.trim()
      }
      if (body.ownerOpenid !== undefined) patch.ownerOpenid = String(body.ownerOpenid || '').trim()
      if (body.requireMentionInGroup !== undefined) patch.requireMentionInGroup = Boolean(body.requireMentionInGroup)
      if (body.nonMentionReplyMode === 'always' || body.nonMentionReplyMode === 'aurabot') {
        patch.nonMentionReplyMode = body.nonMentionReplyMode
      }
      if (body.markdownSupport !== undefined) patch.markdownSupport = Boolean(body.markdownSupport)

      api.saveSettings({ ...cur, ...patch })
      const next = effectiveSettings()
      if (next.enabled && next.appId && next.appSecret) {
        await startBot(true)
      } else {
        await stopBot()
      }
      return { ok: true, message: '官方 QQBot 设置已保存' }
    })

    api.route('/qqbot/qr/start', async () => startQrBindFlow())
    api.route('/qqbot/qr/refresh', async () => startQrBindFlow())
    api.route('/qqbot/qr/cancel', async () => {
      if (qrDispose) { try { qrDispose() } catch {}; qrDispose = null }
      qrBindState = { phase: 'idle', url: '', qrSvg: '', error: '', issuedAt: 0 }
      return { ok: true, message: '已取消扫码绑定' }
    })

    api.route('/qqbot/import-dsh-qqbot', async () => {
      const found = discoverDshQqbotCredentials()
      if (!found) {
        return { ok: false, message: '未在 ~/.dsh/profiles/*/cordis.patch.yml 中找到 im-qqbot 已绑定的凭据' }
      }
      const cur = api.settings()
      const nextPatch = {
        ...cur,
        enabled: true,
        appId: found.appId,
        appSecret: found.appSecret,
        ...(found.c2cAllow?.length && !cur.ownerOpenid ? { ownerOpenid: found.c2cAllow[0] } : {}),
        ...(found.c2cAllow?.length ? { c2cAllow: found.c2cAllow.join('\n') } : {}),
        ...(found.groupAllow?.length ? { groupAllow: found.groupAllow.join('\n') } : {}),
      }
      api.saveSettings(nextPatch)
      await startBot(true)
      return { ok: true, message: `已从 DSH (${found.profileName}) 导入 AppID ${found.appId} 并启动连接` }
    })

    api.route('/qqbot/reconnect', async () => {
      const s = effectiveSettings()
      if (!s.appId || !s.appSecret) return { ok: false, message: '请先扫码绑定或填写 AppID 与 AppSecret' }
      if (!s.enabled) api.saveSettings({ ...api.settings(), enabled: true })
      await startBot(true)
      return { ok: true, message: '已重新发起官方 QQBot WebSocket 连接' }
    })

    api.route('/qqbot/unbind', async () => {
      await stopBot()
      api.saveSettings({ ...api.settings(), enabled: false, appId: '', appSecret: '' })
      return { ok: true, message: '已解绑官方 QQBot 凭据并断开连接' }
    })

    api.route('/qqbot/test-send', async (req) => {
      const body = await api.core.http.body(req)
      const s = effectiveSettings()
      const targetOpenid = String(body?.openid || s.ownerOpenid || '').trim()
      if (!targetOpenid) return { ok: false, message: '请先配置「主人 User OpenID」或输入目标 OpenID' }
      if (!botInstance) await startBot(true)
      const text = String(body?.text || '🐟 大肥鱼 × @tencent-connect/dsh-qqbot 官方机器人连通测试成功！').trim()
      const resolvedTarget = passiveTracker.resolve('c2c', targetOpenid, '', { allowEvent: true })
      await sendTextOrMarkdownSafe(resolvedTarget, text)
      return { ok: true, message: `已向 ${targetOpenid.slice(0, 8)}… 发送测试消息` }
    })

    api.command({
      name: 'qqbot',
      desc: '查看腾讯官方 QQBot 模块连接状态',
      run: () => `官方 QQBot 状态：${connState}（引擎：${engineKind} · 收 ${counters.inbound} / 发 ${counters.outbound}）`,
    })

    api.onDispose(() => {
      unregisterRouter()
      if (qrDispose) { try { qrDispose() } catch {}; qrDispose = null }
      stopBot().catch(() => {})
      allowSync.cleanup()
      idMap.flush()
    })

    return {
      active: () => connState === 'connected',
      state: () => connState,
      summary: () => ({
        state: connState,
        enabled: Boolean(effectiveSettings().enabled),
        appId: effectiveSettings().appId || '',
      }),
      appId: () => effectiveSettings().appId,
      toVirtualUser: toVirtUser,
      toVirtualGroup: (gid, name) => idMap.toVirtualGroup(gid, name),
    }
  },
}
