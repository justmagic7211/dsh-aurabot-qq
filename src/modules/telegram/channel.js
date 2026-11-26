// 自包含 Telegram Bot API 适配器（不依赖宿主内部私有路径，可直接放进原版 dsh-aurabot-qq 的 modules/ 目录运行）
// 支持长轮询、文本、引用回复、图片、GIF/贴纸表情包、语音收发（含 ffmpeg OGG→WAV 供 ASR 识别）、文件、视频、表情回应、正在输入、群成员、历史记录、撤回、群管、加群审批与资料设置。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLATFORM = 'telegram'

// QQ COMMON_FACES 编号 → Emoji（兼容 hub.js 把 <face:名字> 转成的 { type: 'face', data: { id } }）
export const QQ_FACE_ID_TO_EMOJI = Object.freeze({
  0: '😱', 1: '😒', 2: '😍', 3: '😐', 4: '😎', 6: '🥰', 7: '🤐', 8: '😴', 9: '😭', 10: '😅',
  11: '😡', 12: '🤪', 13: '😁', 14: '🙂', 15: '☹️', 16: '😎', 18: '😫', 19: '🤮', 20: '🤭', 21: '😊',
  22: '🙄', 23: '🤨', 25: '😪', 26: '😨', 27: '😓', 28: '😄', 30: '💪', 32: '🤔', 33: '🤫', 34: '🥴',
  39: '👋', 63: '🌹', 66: '❤️', 67: '💔', 76: '👍', 97: '😅', 98: '🤏', 99: '👏', 101: '😏', 104: '🥱',
  105: '😒', 106: '🥺', 107: '😢', 108: '😈', 111: '🥺', 118: '🙏', 124: '👌', 174: '🤷', 178: '😏', 182: '🤣',
  201: '👍', 212: '🤔', 264: '🙈', 266: '😮', 267: '👨‍🦲', 269: '👀', 270: '😐', 271: '🍉', 273: '🍋', 277: '🐶',
  282: '🫡', 285: '🐟', 289: '😳', 353: '🙏', 357: '🫠',
})

export const TELEGRAM_FACE_MAP = Object.freeze({
  呲牙: '😁', 偷笑: '😁', 调皮: '🤪', 赞: '👍', 点赞: '👍', 爱心: '❤', 笑哭: '🤣', 捂脸: '🙈', 玫瑰: '🎉',
  流泪: '😢', 委屈: '😢', 害羞: '🥰', 得意: '😎', 发呆: '😐', 惊讶: '😱', 发怒: '😡', 傲慢: '🤨',
  抱抱: '🤗', 拥抱: '🤗', 憨笑: '😁', 可怜: '😢', 擦汗: '😅', 疑问: '🤔', 晕: '🥴', 困: '😴',
  鼓掌: '👏', 握手: '🤝', 心碎: '💔', 火: '🔥', 庆祝: '🎉', 大哭: '😭', 亲亲: '😘', 色: '😍',
  白眼: '🙄', 叹气: '🥱', 哈欠: '🥱', doge: '🐳', OK: '👌', 微笑: '😇', 撇嘴: '😐', 发火: '🤬', 惊恐: '😨',
  吃瓜: '🍉', 摸鱼: '🐟', 敬礼: '🫡', 抱拳: '🙏', 拜托: '🙏', 裂开: '🫠', 斜眼笑: '😏', 暗中观察: '👀',
})

const TG_REACTION_ALLOW = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔',
  '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊',
  '🙊', '😎', '👾', '😡',
])

function faceIdOrNameToEmoji(idOrName) {
  const key = String(idOrName ?? '').trim()
  if (!key) return ''
  if (QQ_FACE_ID_TO_EMOJI[key]) return QQ_FACE_ID_TO_EMOJI[key]
  if (TELEGRAM_FACE_MAP[key]) return TELEGRAM_FACE_MAP[key]
  if (TG_REACTION_ALLOW.has(key)) return key
  return ''
}

function mimeOf(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
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

function resolveMediaBytes(src) {
  const s = String(src || '').trim()
  if (!s) return null
  if (s.startsWith('base64://')) return Buffer.from(s.slice(9), 'base64')
  if (/^data:[^;]+;base64,/i.test(s)) return Buffer.from(s.replace(/^data:[^;]+;base64,/i, ''), 'base64')
  if (s.startsWith('file://')) {
    try { return readFileSync(fileURLToPath(s)) } catch { return null }
  }
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) {
    try { return readFileSync(s) } catch { return null }
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class TelegramApiError extends Error {
  constructor(method, status, description, { definite = false } = {}) {
    super(description || `Telegram ${method} 失败：HTTP ${status}`)
    this.method = method
    this.status = status
    this.definite = definite
    this.transport = !definite
  }
}

export function createTelegramClient({ getSettings, log = {}, fetchImpl = globalThis.fetch } = {}) {
  const listeners = new Set()
  const msgCache = new Map() // `${kind}:${chatId}|${msgId}` → { time, userId, nickname, msg }
  const msgToChat = new Map() // `${msgId}` → `${kind}:${chatId}`
  const historyCache = new Map() // `${kind}:${chatId}` → Array<OneBotLikeMsg>
  const groupMemberCache = new Map() // groupId → Map<userId, memberInfo>
  const groupTitleCache = new Map() // groupId → title
  const joinRequests = new Map() // flag → { flag, userId, groupId, comment, at }

  let state = 'stopped'
  let me = null
  let offset = 0
  let offsetIdentity = ''
  let startedAt = 0
  let running = false
  let controller = null
  let generation = 0
  let lastError = ''
  let manualStop = false
  const counters = { inbound: 0, outbound: 0, errors: 0 }

  const cfg = () => getSettings() || {}
  const token = () => String(cfg().token || '').trim()
  const apiRoot = () => String(cfg().apiBase || 'https://api.telegram.org').trim().replace(/\/+$/, '')
  const base = () => `${apiRoot()}/bot${token()}`

  const emit = (e) => {
    for (const fn of [...listeners]) {
      try { fn(e) } catch (err) { log.warn?.('Telegram 事件回调出错：', err.message) }
    }
  }
  const setState = (next) => {
    if (state === next) return
    state = next
    emit({ type: 'state', state: next })
  }

  async function callApi(method, params = {}, { signal, timeoutMs = 30000 } = {}) {
    if (!token()) throw new Error('Telegram Bot Token 未配置')
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error('Telegram 请求超时')), timeoutMs)
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetchImpl(`${base()}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctl.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) {
        const definite = res.status >= 400 && res.status < 500 && res.status !== 429
        counters.errors++
        throw new TelegramApiError(method, res.status, data?.description || `Telegram ${method} 失败：HTTP ${res.status}`, { definite })
      }
      return data.result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  async function callForm(method, form, { signal, timeoutMs = 60000 } = {}) {
    if (!token()) throw new Error('Telegram Bot Token 未配置')
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error('Telegram 请求超时')), timeoutMs)
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetchImpl(`${base()}/${method}`, { method: 'POST', body: form, signal: ctl.signal })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) {
        const definite = res.status >= 400 && res.status < 500 && res.status !== 429
        counters.errors++
        throw new TelegramApiError(method, res.status, data?.description || `Telegram ${method} 失败：HTTP ${res.status}`, { definite })
      }
      return data.result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  async function downloadFileById(fileId, { signal, maxBytes = 25 * 1024 * 1024, label = '文件' } = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const info = await callApi('getFile', { file_id: fileId }, { signal, timeoutMs: 15000 })
        const filePath = String(info?.file_path || '')
        if (!filePath) throw new Error('getFile 未返回 file_path')
        const fileUrl = `${apiRoot()}/file/bot${token()}/${filePath}`
        const r = await fetchImpl(fileUrl, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
        })
        if (!r.ok) throw new Error(`${label}下载 HTTP ${r.status}`)
        const buf = Buffer.from(await r.arrayBuffer())
        if (!buf.length || buf.length > maxBytes) throw new Error(`${label}为空或超过大小限制`)
        return { buf, fileUrl, path: filePath, contentType: String(r.headers?.get?.('content-type') || '') }
      } catch (err) {
        if (signal?.aborted || attempt === 3) {
          log.warn?.(`Telegram ${label}下载失败：`, err.message)
          return null
        }
        await sleep(250 * attempt)
      }
    }
    return null
  }

  function rememberMember(groupId, from, date) {
    if (!groupId || !from?.id) return
    const gid = String(groupId)
    let map = groupMemberCache.get(gid)
    if (!map) { map = new Map(); groupMemberCache.set(gid, map) }
    const uid = String(from.id)
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    const nickname = from.first_name || from.username || uid
    const prev = map.get(uid) || {}
    map.set(uid, {
      ...prev,
      user_id: uid,
      nickname,
      card: fullName || from.username || nickname,
      username: from.username || prev.username || '',
      role: prev.role || 'member',
      title: prev.title || '',
      join_time: prev.join_time || Number(date) || Math.floor(Date.now() / 1000),
    })
    if (map.size > 500) map.delete(map.keys().next().value)
  }

  function rememberMessage(parsed, rawTime = 0) {
    if (!parsed?.chatKey || !parsed?.messageId) return
    const time = Number(rawTime) || Math.floor(Date.now() / 1000)
    const key = `${parsed.chatKey}|${parsed.messageId}`
    msgCache.set(key, {
      time,
      userId: String(parsed.userId || ''),
      nickname: String(parsed.nickname || parsed.userId || ''),
      msg: parsed,
    })
    msgToChat.set(String(parsed.messageId), parsed.chatKey)
    if (msgCache.size > 800) msgCache.delete(msgCache.keys().next().value)
    if (msgToChat.size > 800) msgToChat.delete(msgToChat.keys().next().value)

    const list = historyCache.get(parsed.chatKey) || []
    if (!list.some((m) => String(m.realMsgId) === String(parsed.messageId))) {
      list.push({
        realMsgId: String(parsed.messageId),
        kind: parsed.kind,
        realUserId: String(parsed.userId),
        realGroupId: parsed.groupId ? String(parsed.groupId) : '',
        nickname: String(parsed.nickname || parsed.userId || ''),
        time,
        segments: parsed.segments || [{ type: 'text', data: { text: parsed.text || '' } }],
        text: parsed.text || '',
      })
      while (list.length > 100) list.shift()
      historyCache.set(parsed.chatKey, list)
    }
  }

  async function normalize(msg, signal, { skipReplyRecurse = false } = {}) {
    if (!msg?.chat) return null
    const kind = msg.chat.type === 'private' ? 'private' : 'group'
    const realChatId = String(msg.chat.id)
    const chatKey = `${kind}:${realChatId}`
    if (kind === 'group' && msg.chat.title) groupTitleCache.set(realChatId, String(msg.chat.title))
    if (kind === 'group' && msg.from) rememberMember(realChatId, msg.from, msg.date)

    let text = String(msg.text || msg.caption || '')
    const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo.at(-1) : null
    let images = []
    if (photo?.file_id) {
      const dl = await downloadFileById(photo.file_id, { signal, label: '图片' })
      if (dl) {
        images = [{
          type: 'image',
          data: { file: 'base64://' + dl.buf.toString('base64'), file_id: photo.file_id },
          mediaType: dl.contentType || mimeOf(dl.buf) || 'image/jpeg',
        }]
      }
    }

    const stickers = []
    const stickerSource = msg.sticker
      ? ((!msg.sticker.is_animated && !msg.sticker.is_video) ? msg.sticker : (msg.sticker.thumbnail || msg.sticker.thumb || null))
      : null
    if (stickerSource?.file_id) {
      const dl = await downloadFileById(stickerSource.file_id, { signal, maxBytes: 8 * 1024 * 1024, label: '表情包' })
      if (dl) {
        const mediaType = mimeOf(dl.buf).startsWith('image/') ? mimeOf(dl.buf) : (dl.contentType || 'image/webp')
        stickers.push({
          type: 'image',
          data: {
            file: 'base64://' + dl.buf.toString('base64'),
            sub_type: 1,
            file_id: msg.sticker.file_id,
            summary: msg.sticker.emoji ? `[${msg.sticker.emoji}]` : '[表情包]',
          },
          mediaType,
        })
      }
    } else if (msg.animation?.file_id) {
      const dl = await downloadFileById(msg.animation.file_id, { signal, maxBytes: 10 * 1024 * 1024, label: '动图表情' })
      if (dl && mimeOf(dl.buf).startsWith('image/')) {
        stickers.push({
          type: 'image',
          data: { file: 'base64://' + dl.buf.toString('base64'), sub_type: 1, file_id: msg.animation.file_id },
          mediaType: mimeOf(dl.buf),
        })
      }
    }

    const records = []
    const voiceObj = msg.voice || msg.audio
    if (voiceObj?.file_id) {
      records.push({
        type: 'record',
        data: {
          file: `tgfile:${voiceObj.file_id}`,
          file_id: String(voiceObj.file_id),
          duration: Number(voiceObj.duration) || 0,
          mime_type: String(voiceObj.mime_type || 'audio/ogg'),
        },
      })
    }

    const files = []
    if (msg.document?.file_id && !msg.animation) {
      const fname = String(msg.document.file_name || 'file')
      files.push({
        name: fname,
        size: Number(msg.document.file_size) || 0,
        id: `tgfile:${msg.document.file_id}`,
        file_id: `tgfile:${msg.document.file_id}`,
        mimeType: String(msg.document.mime_type || ''),
      })
      if (!text) text = `[文件 ${fname}]`
    }

    if (!text && msg.location) {
      text = `[位置：${msg.location.latitude},${msg.location.longitude}]`
    } else if (!text && msg.contact) {
      const cname = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ').trim()
      text = `[联系人：${cname || msg.contact.phone_number || ''}]`
    } else if (!text && msg.dice) {
      text = `[${msg.dice.emoji || '骰子'}：${msg.dice.value}]`
    } else if (!text && msg.sticker && !stickers.length) {
      text = msg.sticker.emoji ? `[表情包 ${msg.sticker.emoji}]` : '[表情包]'
    }

    if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
      const origin = msg.forward_origin || {}
      const fromName = origin.sender_user?.first_name
        || origin.sender_user_name
        || origin.chat?.title
        || msg.forward_from?.first_name
        || msg.forward_from_chat?.title
        || msg.forward_sender_name
        || '某人'
      if (text && !text.startsWith('[转发自')) text = `[转发自 ${fromName}] ${text}`
    }

    if (!text && !images.length && !stickers.length && !records.length && !files.length) return null

    const realReplyMsg = msg.reply_to_message && !msg.reply_to_message.forum_topic_created ? msg.reply_to_message : null
    if (!skipReplyRecurse && realReplyMsg?.message_id) {
      const rKey = `${chatKey}|${realReplyMsg.message_id}`
      if (!msgCache.has(rKey)) {
        try {
          const replyParsed = await normalize({ ...realReplyMsg, chat: msg.chat }, signal, { skipReplyRecurse: true })
          if (replyParsed) rememberMessage(replyParsed, realReplyMsg.date)
        } catch {}
      }
    }

    const rawText = String(msg.text || msg.caption || text || '')
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])].filter((e) => (e?.type === 'mention' || e?.type === 'text_mention') && Number.isInteger(e.offset) && Number.isInteger(e.length))
    const handles = entities.filter((e) => e.type === 'mention').map((e) => rawText.slice(e.offset, e.offset + e.length).replace(/^@/, '').toLowerCase()).filter(Boolean)
    const textMentionIds = entities.filter((e) => e.type === 'text_mention' && e.user?.id).map((e) => String(e.user.id))
    const botName = String(me?.username || '').toLowerCase()
    const botId = String(me?.id || '')
    const textMention = botName ? new RegExp('(^|\\s)@' + botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$|[，。！？,.!?])', 'iu').test(rawText) : false
    const replyToBot = Boolean(realReplyMsg?.from?.is_bot && String(realReplyMsg.from.id) === botId)
    const mentioned = textMention || (botName && handles.includes(botName)) || (botId && textMentionIds.includes(botId)) || replyToBot
    const atOthers = handles.some((h) => h !== botName) || textMentionIds.some((id) => id !== botId) || Boolean(realReplyMsg?.from && !replyToBot)
    const cleanText = botName ? text.replace(new RegExp('@' + botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), '').trim() || text : text
    const fullName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim()

    const parsed = {
      kind,
      chatKey,
      realChatId,
      userId: String(msg.from?.id || msg.chat.id),
      groupId: kind === 'group' ? realChatId : '',
      groupTitle: kind === 'group' ? String(msg.chat.title || '') : '',
      nickname: fullName || msg.from?.username || String(msg.from?.id || ''),
      text: cleanText,
      mentioned,
      atOthers,
      messageId: String(msg.message_id),
      replyId: realReplyMsg?.message_id ? String(realReplyMsg.message_id) : '',
      images,
      stickers,
      records,
      files,
      segments: [
        ...(cleanText ? [{ type: 'text', data: { text: cleanText } }] : []),
        ...images,
        ...stickers,
        ...records,
        ...files.map((f) => ({ type: 'file', data: f })),
      ],
      date: Number(msg.date) || Math.floor(Date.now() / 1000),
      raw: msg,
    }
    rememberMessage(parsed, msg.date)
    return parsed
  }

  async function dispatchUpdate(update, { signal, current } = {}) {
    if (signal?.aborted || (current && !current())) return false

    if (update?.chat_join_request) {
      const req = update.chat_join_request
      const groupId = String(req.chat?.id || '')
      const userId = String(req.from?.id || '')
      if (groupId && userId) {
        const flag = `tg_join:${groupId}:${userId}`
        const comment = String(req.bio || '').slice(0, 80)
        joinRequests.set(flag, { flag, userId, groupId, comment, at: Date.now() })
        emit({ type: 'join_request', flag, groupId, userId, comment, nickname: req.from?.first_name || req.from?.username || userId })
      }
      return true
    }

    if (update?.edited_message) {
      try { await normalize(update.edited_message, signal) } catch {}
      return true
    }

    const msg = update?.message
    if (!msg) return true
    if (Number(msg.date) && Number(msg.date) < startedAt - 3) return true
    const parsed = await normalize(msg, signal)
    if (signal?.aborted || (current && !current())) return false
    if (parsed) {
      counters.inbound++
      emit({ type: 'message', msg: parsed })
    }
    return true
  }

  async function pollLoop(ctl, gen) {
    const current = () => running && generation === gen && !ctl.signal.aborted
    while (current()) {
      try {
        const updates = await callApi('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'edited_message', 'chat_join_request', 'message_reaction'],
        }, { signal: ctl.signal, timeoutMs: 35000 })
        for (const u of updates || []) {
          if (!current()) break
          const ok = await dispatchUpdate(u, { signal: ctl.signal, current })
          if (ok) offset = Math.max(offset, Number(u.update_id) + 1)
        }
      } catch (err) {
        if (!current()) break
        lastError = String(err?.message || err)
        log.warn?.('Telegram 轮询出错：', lastError)
        await sleep(3000)
      }
    }
    if (generation === gen) setState('stopped')
  }

  async function sendFileRaw(realChatId, { file, name } = {}, { timeoutMs = 60000 } = {}) {
    const fileName = String(name || 'file').trim() || 'file'
    const localBytes = resolveMediaBytes(file)
    let result
    if (localBytes) {
      const form = new FormData()
      form.set('chat_id', String(realChatId))
      form.set('document', new Blob([localBytes]), fileName)
      result = await callForm('sendDocument', form, { timeoutMs })
    } else if (typeof file === 'string' && /^https?:\/\//i.test(file)) {
      result = await callApi('sendDocument', { chat_id: String(realChatId), document: file }, { timeoutMs })
    } else {
      throw new TelegramApiError('sendDocument', 400, '无法读取要发送的文件', { definite: true })
    }
    counters.outbound++
    return result
  }

  async function voiceWav(fileRefRaw) {
    const fileRef = String(fileRefRaw || '').replace(/^tgfile:/, '').trim()
    if (!fileRef) throw new Error('Telegram 语音缺少 file_id')
    let buf = resolveMediaBytes(fileRef)
    if (!buf) {
      const dl = await downloadFileById(fileRef, { maxBytes: 30 * 1024 * 1024, label: '语音' })
      if (!dl?.buf) throw new Error('Telegram 语音下载失败')
      buf = dl.buf
    }
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
      return buf
    }
    const ffmpeg = detectFfmpeg(cfg().ffmpegPath || '')
    if (!ffmpeg) throw new Error('Telegram 语音是 OGG Opus 格式，需要本机安装 ffmpeg 才能识别语音')
    const dir = mkdtempSync(join(tmpdir(), 'aurabot-tg-voice-'))
    try {
      const input = join(dir, 'in.ogg')
      const output = join(dir, 'out.wav')
      writeFileSync(input, buf)
      const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', output], { timeout: 20000 })
      if (r.status !== 0) throw new Error(`ffmpeg 转码失败：${String(r.stderr || '').trim().slice(0, 120)}`)
      return readFileSync(output)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async function sendSegmentsRaw(kind, realChatId, segments, opts = {}) {
    const segList = Array.isArray(segments) ? segments : []
    const atPrefix = segList
      .filter((s) => s?.type === 'at' && s.data?.qq)
      .map((s) => {
        const uid = String(s.data.qq)
        if (uid === 'all') return '@everyone '
        const known = kind === 'group' ? groupMemberCache.get(String(realChatId))?.get(uid) : null
        if (known?.username) return `@${known.username} `
        if (s.data.name) return `@${s.data.name} `
        return known?.nickname ? `@${known.nickname} ` : ''
      })
      .join('')

    const rawText = segList
      .map((s) => {
        if (s?.type === 'text') {
          return String(s.data?.text || '').replace(/<\s*face\s*[:：]\s*([^>\s]{1,20})\s*>/gi, (_m, n) => faceIdOrNameToEmoji(n))
        }
        if (s?.type === 'face') return faceIdOrNameToEmoji(s.data?.id)
        return ''
      })
      .join('')
    const text = atPrefix && !rawText.startsWith(atPrefix.trim()) ? atPrefix + rawText : rawText
    const image = segList.find((s) => s?.type === 'image' || s?.type === 'mface')
    const record = segList.find((s) => s?.type === 'record')
    const video = segList.find((s) => s?.type === 'video')
    const fileSeg = segList.find((s) => s?.type === 'file')
    const cardSeg = segList.find((s) => ['location', 'contact', 'dice', 'rps', 'share', 'music'].includes(s?.type))
    const replyId = segList.find((s) => s?.type === 'reply')?.data?.id
    const params = {
      chat_id: String(realChatId),
      ...(replyId && /^\d+$/.test(String(replyId)) ? { reply_parameters: { message_id: Number(replyId), allow_sending_without_reply: true } } : {}),
    }
    let result = null

    if (record) {
      const src = record.data?.file || record.data?.url
      const bytes = resolveMediaBytes(src)
      if (bytes) {
        const buildForm = (field, filename) => {
          const form = new FormData()
          form.set('chat_id', String(realChatId))
          if (params.reply_parameters) form.set('reply_parameters', JSON.stringify(params.reply_parameters))
          if (text && text.length <= 1024) form.set('caption', text)
          form.set(field, new Blob([bytes]), filename)
          return form
        }
        try {
          result = await callForm('sendVoice', buildForm('voice', 'voice.ogg'), { timeoutMs: opts?.timeoutMs || 60000 })
        } catch (err) {
          if (/VOICE_MESSAGES_FORBIDDEN/i.test(String(err.message))) {
            result = await callForm('sendAudio', buildForm('audio', 'voice.mp3'), { timeoutMs: opts?.timeoutMs || 60000 })
          } else throw err
        }
      } else if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
        result = await callApi('sendVoice', { ...params, voice: src, ...(text ? { caption: text.slice(0, 1024) } : {}) })
      }
    } else if (video) {
      const src = video.data?.file || video.data?.url
      const bytes = resolveMediaBytes(src)
      if (bytes) {
        const form = new FormData()
        form.set('chat_id', String(realChatId))
        if (params.reply_parameters) form.set('reply_parameters', JSON.stringify(params.reply_parameters))
        if (text && text.length <= 1024) form.set('caption', text)
        form.set('video', new Blob([bytes]), 'video.mp4')
        result = await callForm('sendVideo', form, { timeoutMs: opts?.timeoutMs || 120000 })
      } else if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
        result = await callApi('sendVideo', { ...params, video: src, ...(text ? { caption: text.slice(0, 1024) } : {}) }, { timeoutMs: opts?.timeoutMs || 120000 })
      }
    } else if (fileSeg) {
      result = await sendFileRaw(realChatId, { file: fileSeg.data?.file || fileSeg.data?.url, name: fileSeg.data?.name }, { timeoutMs: opts?.timeoutMs || 60000 })
    } else if (cardSeg) {
      const d = cardSeg.data || {}
      if (cardSeg.type === 'location') {
        result = await callApi('sendLocation', { ...params, latitude: Number(d.lat), longitude: Number(d.lon) })
      } else if (cardSeg.type === 'contact') {
        result = await callApi('sendContact', { ...params, phone_number: String(d.phone || d.id || '00000'), first_name: String(d.title || d.name || d.id || '联系人') })
      } else if (cardSeg.type === 'dice' || cardSeg.type === 'rps') {
        result = await callApi('sendDice', { ...params, emoji: cardSeg.type === 'rps' ? '🎯' : (d.emoji || '🎲') })
      } else {
        const cardLines = [d.title ? `【${d.title}】` : '', d.content || '', d.url || '', d.audio ? `音频：${d.audio}` : ''].filter(Boolean)
        result = await callApi('sendMessage', { ...params, text: cardLines.join('\n') || '[卡片]' })
      }
    } else if (image) {
      const photo = image.data?.file || image.data?.url
      const localBytes = resolveMediaBytes(photo)
      if (localBytes) {
        const isGif = localBytes.length > 6 && localBytes[0] === 0x47 && localBytes[1] === 0x49 && localBytes[2] === 0x46
        const form = new FormData()
        form.set('chat_id', String(realChatId))
        if (params.reply_parameters) form.set('reply_parameters', JSON.stringify(params.reply_parameters))
        if (text && text.length <= 1024) form.set('caption', text)
        if (isGif) {
          form.set('animation', new Blob([localBytes], { type: 'image/gif' }), 'sticker.gif')
          result = await callForm('sendAnimation', form)
        } else {
          form.set('photo', new Blob([localBytes]), 'image.jpg')
          result = await callForm('sendPhoto', form)
        }
        if (text && text.length > 1024) await callApi('sendMessage', { chat_id: String(realChatId), text })
      } else if (text.length > 1024) {
        result = await callApi('sendPhoto', { ...params, photo })
        await callApi('sendMessage', { chat_id: String(realChatId), text })
      } else {
        result = await callApi('sendPhoto', { ...params, photo, ...(text ? { caption: text } : {}) })
      }
    } else if (text) {
      for (let i = 0; i < text.length; i += 4096) {
        const chunk = text.slice(i, i + 4096)
        result = await callApi('sendMessage', i === 0 ? { ...params, text: chunk } : { chat_id: String(realChatId), text: chunk })
      }
    }

    if (result) {
      counters.outbound++
      const realMsgId = String(result?.message_id || '')
      if (realMsgId && me?.id) {
        rememberMessage({
          kind,
          chatKey: `${kind}:${realChatId}`,
          realChatId: String(realChatId),
          userId: String(me.id),
          groupId: kind === 'group' ? String(realChatId) : '',
          nickname: me.first_name || me.username || String(me.id),
          text,
          messageId: realMsgId,
          segments: segList,
        })
      }
    }
    return result
  }

  return {
    state: () => state,
    me: () => me,
    lastError: () => lastError,
    counters: () => ({ ...counters }),
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    callApi,
    sendSegmentsRaw,
    sendFileRaw,
    voiceWav,
    getCachedMessage(chatKey, realMsgId) {
      if (chatKey) return msgCache.get(`${chatKey}|${realMsgId}`) || null
      const ck = msgToChat.get(String(realMsgId))
      return ck ? (msgCache.get(`${ck}|${realMsgId}`) || null) : null
    },
    getHistory(chatKey, count = 20, anchorRealMsgId = '') {
      const list = (historyCache.get(chatKey) || []).slice()
      const n = Math.max(1, Math.min(50, Number(count) || 20))
      if (anchorRealMsgId) {
        const idx = list.findIndex((m) => String(m.realMsgId) === String(anchorRealMsgId))
        if (idx >= 0) return list.slice(Math.max(0, idx - n), idx)
      }
      return list.slice(-n)
    },
    async getMember(realGroupId, realUserId, { timeoutMs = 8000 } = {}) {
      try {
        const r = await callApi('getChatMember', { chat_id: String(realGroupId), user_id: Number(realUserId) || realUserId }, { timeoutMs })
        const u = r?.user || {}
        const status = String(r?.status || '')
        const role = status === 'creator' ? 'owner' : status === 'administrator' ? 'admin' : 'member'
        const inGroup = !['left', 'kicked'].includes(status)
        const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
        const info = {
          realUserId: String(u.id ?? realUserId),
          nickname: u.first_name || u.username || String(realUserId),
          card: r?.custom_title || fullName || u.username || String(realUserId),
          username: u.username || '',
          role,
          title: r?.custom_title || '',
          join_time: inGroup ? 1 : 0,
        }
        if (inGroup && u.id) rememberMember(realGroupId, u)
        return info
      } catch {
        const cached = groupMemberCache.get(String(realGroupId))?.get(String(realUserId))
        return cached ? { ...cached, realUserId: String(cached.user_id) } : null
      }
    },
    async getMembers(realGroupId, { timeoutMs = 10000 } = {}) {
      const gid = String(realGroupId)
      const cached = new Map(groupMemberCache.get(gid) || [])
      try {
        const admins = await callApi('getChatAdministrators', { chat_id: gid }, { timeoutMs })
        for (const a of Array.isArray(admins) ? admins : []) {
          const u = a?.user
          if (!u?.id) continue
          const uid = String(u.id)
          const role = a.status === 'creator' ? 'owner' : 'admin'
          const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
          cached.set(uid, {
            user_id: uid,
            nickname: u.first_name || u.username || uid,
            card: a.custom_title || fullName || u.username || uid,
            username: u.username || '',
            role,
            title: a.custom_title || '',
            join_time: 1,
          })
        }
        groupMemberCache.set(gid, cached)
      } catch {}
      return [...cached.values()]
    },
    async getFileUrl(fileRef) {
      const fid = String(fileRef || '').replace(/^tgfile:/, '').trim()
      if (!fid) return ''
      const info = await callApi('getFile', { file_id: fid })
      return info?.file_path ? `${apiRoot()}/file/bot${token()}/${info.file_path}` : ''
    },
    async react(realChatId, realMsgId, emojiRaw) {
      const raw = String(emojiRaw || '').trim()
      const emoji = TG_REACTION_ALLOW.has(raw) ? raw : (faceIdOrNameToEmoji(raw) || '👍')
      const safeEmoji = TG_REACTION_ALLOW.has(emoji) ? emoji : '👍'
      await callApi('setMessageReaction', {
        chat_id: String(realChatId),
        message_id: Number(realMsgId),
        reaction: [{ type: 'emoji', emoji: safeEmoji }],
      }, { timeoutMs: 10000 })
    },
    groupTitle: (realGroupId) => groupTitleCache.get(String(realGroupId)) || '',
    knownGroupIds: () => [...groupTitleCache.keys()],
    async start() {
      if (running) return
      if (!cfg().enabled || !token()) { setState('stopped'); return }
      const gen = ++generation
      const ctl = new AbortController()
      controller = ctl
      manualStop = false
      running = true
      lastError = ''
      setState('connecting')
      startedAt = Math.floor(Date.now() / 1000)
      try {
        const meInfo = await callApi('getMe', {}, { signal: ctl.signal })
        if (generation !== gen || !running) { ctl.abort(); return }
        me = meInfo
        const identity = `${base()}|${me.id}`
        if (identity !== offsetIdentity) { offset = 0; offsetIdentity = identity }
        setState('connected')
        log.info?.(`Telegram 模块已连接：@${me.username || me.id}`)
        void pollLoop(ctl, gen)
      } catch (err) {
        if (generation !== gen || !running) return
        running = false
        lastError = String(err?.message || err)
        setState('stopped')
        controller = null
        me = null
        log.warn?.('Telegram 模块启动失败：', lastError)
        throw err
      }
    },
    stop() {
      manualStop = true
      running = false
      generation++
      try { controller?.abort() } catch {}
      controller = null
      me = null
      setState('stopped')
    },
    async restart() {
      this.stop()
      manualStop = false
      await this.start()
    },
    watch() {
      if (manualStop || state === 'connecting') return
      if (!cfg().enabled || !token()) { if (state !== 'stopped') this.stop(); return }
      if (state === 'stopped') this.start().catch(() => {})
    },
  }
}
