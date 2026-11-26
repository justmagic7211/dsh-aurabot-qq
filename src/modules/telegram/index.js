// 内置模块「Telegram」—— 将大肥鱼完整接入 Telegram Bot API（配置入口在面板「连接」标签与设置向导）。
// 支持长轮询、语音 ASR/TTS、表情包/GIF、图片、文件、视频、引用回复、撤回、贴表情、群管与加群审批；
// 通过共享多平台路由器可与 SnowLuma/NapCat、官方 QQBot 同时在线且互不干扰。

import { acquirePlatformRouter, createVirtualIdMapper, createRuntimeAllowSync } from '../qqbot/router.js'
import { createTelegramClient } from './channel.js'

const parseList = (raw) => [...new Set(
  (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，;；\n]+/))
    .map((s) => String(s).trim())
    .filter(Boolean),
)]

/** @type {import('../aurabot.d.ts').AurabotModule} */
export default {
  id: 'telegram',
  name: 'Telegram',
  version: '1.0.0',
  api: 1,
  tab: 'connect',
  files: ['modules/qqbot/router.js', 'modules/telegram/channel.js'],
  description: '将大肥鱼完整接入 Telegram Bot（支持语音 ASR/TTS、表情包/GIF、图片、文件、视频、引用回复、撤回、贴表情、群管与加群审批）。',

  defaults: {
    enabled: false,
    token: '',
    apiBase: 'https://api.telegram.org',
    ownerId: '',
    ownerSessionMode: 'shared',
    c2cMode: 'open',
    allowPrivate: '',
    groupMode: 'open',
    allowGroups: '',
    requireMentionInGroup: false,
    nonMentionReplyMode: 'always',
    ffmpegPath: '',
  },

  settings: [
    { key: 'enabled', label: '启用 Telegram 接入', type: 'switch', hint: '打开后自动建立 Telegram Bot 长轮询连接（同时需开启右上角 Aurabot 总开关）' },
    { key: 'token', label: 'Bot Token', type: 'password', placeholder: '123456789:AAH...（从 @BotFather 获取；也可设环境变量 TELEGRAM_BOT_TOKEN）' },
    { key: 'apiBase', label: 'Bot API 地址', type: 'text', placeholder: 'https://api.telegram.org', hint: '支持自定义反代或自建 Local Bot API Server' },
    { key: 'ownerId', label: '主人 Telegram 数字 ID', type: 'text', placeholder: '如 123456789', hint: '填你的 Telegram 用户数字 ID，即可在 TG 拥有完整主人权限（私聊工具、群管等）' },
    {
      key: 'ownerSessionMode',
      label: '主人私聊会话模式',
      type: 'select',
      options: [
        { value: 'shared', label: '与 QQ 主人共享同一记忆与私聊会话（推荐）' },
        { value: 'isolated', label: '独立虚拟会话（与 QQ 私聊分开）' },
      ],
    },
    {
      key: 'c2cMode',
      label: '私聊访问策略',
      type: 'select',
      options: [
        { value: 'open', label: '开放（所有人可私聊）' },
        { value: 'allowlist', label: '白名单（仅下方列表与主人可私聊）' },
        { value: 'disabled', label: '仅主人可私聊' },
      ],
    },
    { key: 'allowPrivate', label: '私聊白名单（TG 用户 ID）', type: 'textarea', placeholder: '一行一个 Telegram 用户 ID' },
    {
      key: 'groupMode',
      label: '群聊访问策略',
      type: 'select',
      options: [
        { value: 'open', label: '开放（机器人所在群均可响应）' },
        { value: 'allowlist', label: '白名单（仅下方群 ID 可响应）' },
        { value: 'disabled', label: '关闭群聊响应' },
      ],
    },
    { key: 'allowGroups', label: '群聊白名单（TG 群 ID）', type: 'textarea', placeholder: '一行一个 Telegram 群 ID（如 -1001234567890）' },
    { key: 'requireMentionInGroup', label: '群聊仅在 @机器人 或回复时触发', type: 'switch', hint: '关闭后群聊不用 @ 也能回（注意：TG 需将机器人设为群管理员，或在 @BotFather 发 /setprivacy 选 Disable）' },
    {
      key: 'nonMentionReplyMode',
      label: '免 @ 时的群聊回复策略',
      type: 'select',
      options: [
        { value: 'always', label: '每条普通消息都直接回（不用 @ 也不用叫名字）' },
        { value: 'aurabot', label: '按大肥鱼群聊策略（叫「大肥鱼」必回，其余按概率插话）' },
      ],
    },
    { key: 'ffmpegPath', label: 'ffmpeg 路径（可选）', type: 'text', placeholder: '留空自动检测系统 ffmpeg（用于 TG OGG 语音转写）' },
  ],

  setup(api) {
    const router = acquirePlatformRouter(api)
    const idMap = createVirtualIdMapper({
      file: api.dataDir('id-map.json'),
      prefixUser: '71',
      prefixGroup: '72',
      prefixMsg: '79',
    })
    const allowSync = createRuntimeAllowSync(api)

    const effectiveSettings = () => {
      const s = api.settings()
      const coreTg = api.config()?.platforms?.telegram || api.config()?.telegram || {}
      return {
        ...s,
        enabled: Boolean(s.enabled),
        token: String(s.token || process.env.TELEGRAM_BOT_TOKEN || coreTg.token || '').trim(),
        apiBase: String(s.apiBase || coreTg.apiBase || 'https://api.telegram.org').trim().replace(/\/+$/, ''),
        ownerId: String(s.ownerId || process.env.TELEGRAM_OWNER_ID || coreTg.ownerQQ || '').trim(),
        ffmpegPath: String(s.ffmpegPath || api.config()?.bili?.ffmpegPath || '').trim(),
      }
    }

    const resolveOwnerVirtId = () => {
      const s = effectiveSettings()
      if (!s.ownerId) return ''
      const cfg = api.config()
      if (s.ownerSessionMode !== 'isolated' && cfg?.ownerQQ) {
        return String(cfg.ownerQQ)
      }
      const virt = idMap.toVirtualUser(s.ownerId, cfg?.ownerName || '主人')
      if (cfg && !cfg.ownerQQ) cfg.ownerQQ = virt
      return virt
    }

    const toVirtUser = (realUserId, name = '') => {
      const s = effectiveSettings()
      if (s.ownerId && String(realUserId) === String(s.ownerId)) {
        return resolveOwnerVirtId() || idMap.toVirtualUser(realUserId, name)
      }
      return idMap.toVirtualUser(realUserId, name)
    }

    const toRealUser = (virtId) => {
      const v = String(virtId ?? '').trim()
      const s = effectiveSettings()
      if (s.ownerId && v === String(api.config()?.ownerQQ || '')) return String(s.ownerId)
      const mapped = idMap.toRealUser(v)
      if (mapped) return mapped
      if (/^\d+$/.test(v) && !v.startsWith('71') && !v.startsWith('81')) return v
      return null
    }

    const toRealGroup = (virtGroupId) => {
      const v = String(virtGroupId ?? '').trim()
      const mapped = idMap.toRealGroup(v)
      if (mapped) return mapped
      if (/^-?\d+$/.test(v) && !v.startsWith('72') && !v.startsWith('82')) return v
      return null
    }

    const isAllowedInbound = (msg) => {
      const s = effectiveSettings()
      const isOwnerMsg = Boolean(s.ownerId && String(msg.userId) === String(s.ownerId))
      if (msg.kind === 'private') {
        if (isOwnerMsg) return true
        if (s.c2cMode === 'disabled') return false
        if (s.c2cMode === 'open') return true
        return parseList(s.allowPrivate).includes(String(msg.userId))
      }
      if (s.groupMode === 'disabled') return false
      if (s.groupMode === 'open') return true
      return parseList(s.allowGroups).includes(String(msg.groupId))
    }

    const client = createTelegramClient({
      getSettings: effectiveSettings,
      log: api.log,
    })

    // 处理入站消息与加群申请
    client.on(async (ev) => {
      if (ev.type === 'join_request') {
        const virtGroupId = idMap.toVirtualGroup(ev.groupId)
        const virtUserId = toVirtUser(ev.userId, ev.nickname)
        api.emit('onebot', {
          _fromPlatformModule: 'telegram',
          post_type: 'request',
          request_type: 'group',
          sub_type: 'add',
          flag: ev.flag,
          group_id: Number(virtGroupId),
          user_id: Number(virtUserId),
          comment: ev.comment || '',
        })
        return
      }

      if (ev.type !== 'message' || !ev.msg) return
      const msg = ev.msg
      if (!isAllowedInbound(msg)) return
      if (msg.kind === 'group' && effectiveSettings().requireMentionInGroup && !msg.mentioned) return

      const s = effectiveSettings()
      const isOwnerMsg = Boolean(s.ownerId && String(msg.userId) === String(s.ownerId))
      const virtUserId = toVirtUser(msg.userId, msg.nickname)
      const virtGroupId = msg.kind === 'group' ? idMap.toVirtualGroup(msg.groupId, msg.groupTitle) : ''

      if (msg.kind === 'private') {
        if (isOwnerMsg) router.markOwnerActive('telegram')
        if (virtUserId !== String(api.config()?.ownerQQ || '')) allowSync.allowPrivate(virtUserId)
      } else if (virtGroupId) {
        allowSync.allowGroup(virtGroupId)
      }

      const virtMsgId = idMap.rememberMessage(`${msg.chatKey}|${msg.messageId}`, {
        chatKey: msg.chatKey,
        kind: msg.kind,
        realChatId: msg.realChatId,
        realMsgId: msg.messageId,
        realUserId: msg.userId,
        virtUserId,
        virtGroupId,
      })

      let virtReplyId = ''
      if (msg.replyId) {
        virtReplyId = idMap.rememberMessage(`${msg.chatKey}|${msg.replyId}`, {
          chatKey: msg.chatKey,
          kind: msg.kind,
          realChatId: msg.realChatId,
          realMsgId: msg.replyId,
        })
      }

      const botSelfId = String(api.config()?.botQQ || '700000000001')
      const onebotSegs = []
      if (virtReplyId) onebotSegs.push({ type: 'reply', data: { id: virtReplyId } })
      if (msg.mentioned) onebotSegs.push({ type: 'at', data: { qq: botSelfId } })
      if (msg.text) onebotSegs.push({ type: 'text', data: { text: msg.text } })
      for (const img of msg.images || []) onebotSegs.push(img)
      for (const st of msg.stickers || []) onebotSegs.push(st)
      for (const rec of msg.records || []) onebotSegs.push(rec)
      for (const f of msg.files || []) onebotSegs.push({ type: 'file', data: f })

      const onebotEv = {
        _fromPlatformModule: 'telegram',
        post_type: 'message',
        message_type: msg.kind === 'group' ? 'group' : 'private',
        sub_type: msg.kind === 'group' ? 'normal' : 'friend',
        self_id: Number(botSelfId) || botSelfId,
        user_id: Number(virtUserId),
        ...(virtGroupId ? { group_id: Number(virtGroupId) } : {}),
        message_id: Number(virtMsgId),
        time: msg.date,
        sender: {
          user_id: Number(virtUserId),
          nickname: msg.nickname || virtUserId,
          card: msg.nickname || virtUserId,
          role: isOwnerMsg ? 'owner' : 'member',
        },
        message: onebotSegs,
        raw_message: msg.text || '',
      }

      api.emit('onebot', onebotEv)
      if (onebotEv.message_type === 'private' && msg.text) {
        if (api.core.dangerGuard?.handleReply?.(`private:${virtUserId}`, virtUserId, msg.text)) return
        if (api.core.approvalRelay?.handleReply?.(`private:${virtUserId}`, virtUserId, msg.text)) return
      }
      await api.core.hub.onMessage(onebotEv)
    })

    // 当开启「免 @ 回复」且策略为 always 时，覆盖大肥鱼默认的插话概率限制
    api.on('group/decide', (decision, info) => {
      const m = info?.msg
      if (!m || !idMap.isVirtualGroup(m.groupId)) return undefined
      const s = effectiveSettings()
      if (!s.requireMentionInGroup && s.nonMentionReplyMode !== 'aurabot') {
        if (!decision?.reply && !m.atOthers) {
          return { ...decision, reply: true, mode: 'must', reason: 'Telegram 群聊免 @ 直回' }
        }
      }
      return undefined
    })

    const rewriteOutboundSegments = (segs) => {
      const list = Array.isArray(segs) ? segs : [{ type: 'text', data: { text: String(segs ?? '') } }]
      return list.map((seg) => {
        if (!seg || typeof seg !== 'object') return seg
        if (seg.type === 'reply' && seg.data?.id) {
          const hit = idMap.resolveMessage(seg.data.id)
          if (hit?.realMsgId) return { ...seg, data: { ...seg.data, id: String(hit.realMsgId) } }
        }
        if (seg.type === 'at' && seg.data?.qq && String(seg.data.qq) !== 'all') {
          const realU = toRealUser(seg.data.qq)
          if (realU) return { ...seg, data: { ...seg.data, qq: realU } }
        }
        return seg
      })
    }

    const adapter = {
      isReady: () => client.state() === 'connected',
      hasOwner: () => Boolean(effectiveSettings().ownerId),
      ownsTarget(action, params = {}) {
        if (params.group_id != null && idMap.isVirtualGroup(params.group_id)) return true
        if (params.user_id != null && idMap.isVirtualUser(params.user_id)) return true
        if (params.message_id != null && idMap.isVirtualMsg(params.message_id)) return true
        if (typeof params.file === 'string' && params.file.startsWith('tgfile:')) return true
        if (typeof params.file_id === 'string' && params.file_id.startsWith('tgfile:')) return true
        if (typeof params.flag === 'string' && params.flag.startsWith('tg_join:')) return true
        return false
      },
      async handleCall(action, params = {}, opts = {}) {
        switch (action) {
          case 'get_login_info': {
            const me = client.me() || await client.callApi('getMe', {}, opts)
            return { user_id: Number(api.config()?.botQQ || me.id), nickname: me.first_name || me.username || String(me.id) }
          }
          case 'send_private_msg': {
            const realUid = toRealUser(params.user_id)
            if (!realUid) throw new Error(`找不到对应的 Telegram 私聊目标：${params.user_id}`)
            const res = await client.sendSegmentsRaw('private', realUid, rewriteOutboundSegments(params.message), opts)
            const realMid = String(res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`private:${realUid}|${realMid}`, { chatKey: `private:${realUid}`, kind: 'private', realChatId: realUid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : res?.message_id }
          }
          case 'send_group_msg': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) throw new Error(`找不到对应的 Telegram 群目标：${params.group_id}`)
            const res = await client.sendSegmentsRaw('group', realGid, rewriteOutboundSegments(params.message), opts)
            const realMid = String(res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`group:${realGid}|${realMid}`, { chatKey: `group:${realGid}`, kind: 'group', realChatId: realGid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : res?.message_id }
          }
          case 'send_msg': {
            const isGroup = params.message_type === 'group' || params.group_id != null
            return isGroup
              ? this.handleCall('send_group_msg', params, opts)
              : this.handleCall('send_private_msg', params, opts)
          }
          case 'upload_private_file': {
            const realUid = toRealUser(params.user_id)
            if (!realUid) throw new Error(`找不到对应的 Telegram 私聊目标：${params.user_id}`)
            const res = await client.sendFileRaw(realUid, { file: params.file, name: params.name }, opts)
            const realMid = String(res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`private:${realUid}|${realMid}`, { chatKey: `private:${realUid}`, kind: 'private', realChatId: realUid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : res?.message_id }
          }
          case 'upload_group_file': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) throw new Error(`找不到对应的 Telegram 群目标：${params.group_id}`)
            const res = await client.sendFileRaw(realGid, { file: params.file, name: params.name }, opts)
            const realMid = String(res?.message_id || '')
            const virtMid = realMid
              ? idMap.rememberMessage(`group:${realGid}|${realMid}`, { chatKey: `group:${realGid}`, kind: 'group', realChatId: realGid, realMsgId: realMid })
              : ''
            return { message_id: virtMid ? Number(virtMid) : res?.message_id }
          }
          case 'get_msg': {
            const ref = idMap.resolveMessage(params.message_id)
            if (!ref) throw new Error('找不到引用的 Telegram 消息')
            const hit = client.getCachedMessage(ref.chatKey, ref.realMsgId)
            if (!hit) throw new Error('Telegram 消息不在本地缓存中')
            const m = hit.msg
            const botId = String(client.me()?.id || '')
            const senderVirt = String(m.userId) === botId ? String(api.config()?.botQQ || '700000000001') : toVirtUser(m.userId, hit.nickname)
            const groupVirt = m.groupId ? idMap.toVirtualGroup(m.groupId) : undefined
            return {
              message_id: Number(params.message_id),
              message_type: m.kind,
              group_id: groupVirt ? Number(groupVirt) : undefined,
              user_id: Number(senderVirt),
              time: hit.time,
              sender: { user_id: Number(senderVirt), nickname: hit.nickname, card: hit.nickname },
              message: m.segments || [{ type: 'text', data: { text: m.text || '' } }],
              raw_message: m.text || '',
            }
          }
          case 'get_record': {
            const wav = await client.voiceWav(params.file)
            return { base64: wav.toString('base64') }
          }
          case 'fetch_ptt_text':
            return { text: '' }
          case 'get_group_file_url':
          case 'get_private_file_url':
            return { url: await client.getFileUrl(params.file_id || params.file) }
          case 'get_group_member_info': {
            const realGid = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            if (!realGid || !realUid) return null
            const info = await client.getMember(realGid, realUid, opts)
            if (!info) return null
            return {
              user_id: Number(params.user_id),
              group_id: Number(params.group_id),
              nickname: info.nickname,
              card: info.card,
              role: info.role,
              title: info.title,
              join_time: info.join_time,
            }
          }
          case 'get_group_member_list': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) return []
            const list = await client.getMembers(realGid, opts)
            return list.map((m) => ({
              user_id: Number(toVirtUser(m.user_id, m.nickname)),
              group_id: Number(params.group_id),
              nickname: m.nickname,
              card: m.card,
              role: m.role,
              title: m.title,
              join_time: m.join_time,
            }))
          }
          case 'get_group_list': {
            const snapGroups = idMap.snapshot(100).filter((x) => x.kind === 'group')
            const known = [...new Set([
              ...parseList(effectiveSettings().allowGroups),
              ...client.knownGroupIds(),
              ...snapGroups.map((g) => g.rawId),
            ])]
            return known.map((realGid) => {
              const prev = snapGroups.find((g) => g.rawId === String(realGid))
              const title = client.groupTitle(realGid) || prev?.name || `TG群 ${realGid}`
              const virtGid = idMap.toVirtualGroup(realGid, title)
              return { group_id: Number(virtGid), group_name: title }
            })
          }
          case 'get_friend_list': {
            const snapUsers = idMap.snapshot(100).filter((x) => x.kind === 'private')
            const s = effectiveSettings()
            const rawUsers = [...new Set([
              s.ownerId,
              ...parseList(s.allowPrivate),
              ...snapUsers.map((u) => u.rawId),
            ].filter(Boolean))]
            return rawUsers.map((realUid) => {
              const virtUid = toVirtUser(realUid)
              const meta = idMap.lookupMeta(virtUid)
              return { user_id: Number(virtUid), nickname: meta?.name || `TG用户 ${realUid}`, remark: '' }
            })
          }
          case 'get_group_info': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) throw new Error('未知 Telegram 群')
            const r = await client.callApi('getChat', { chat_id: realGid }, opts)
            return { group_id: Number(params.group_id), group_name: r?.title || realGid, member_count: r?.member_count || 0 }
          }
          case 'get_group_msg_history':
          case 'get_friend_msg_history': {
            const isGroup = action === 'get_group_msg_history'
            const realTarget = isGroup ? toRealGroup(params.group_id) : toRealUser(params.user_id)
            if (!realTarget) return { messages: [] }
            const chatKey = `${isGroup ? 'group' : 'private'}:${realTarget}`
            const anchorRef = params.message_id ? idMap.resolveMessage(params.message_id) : null
            const rawList = client.getHistory(chatKey, params.count || 20, anchorRef?.realMsgId || '')
            const botId = String(client.me()?.id || '')
            const messages = rawList.map((item) => {
              const virtMid = idMap.rememberMessage(`${chatKey}|${item.realMsgId}`, {
                chatKey,
                kind: item.kind,
                realChatId: realTarget,
                realMsgId: item.realMsgId,
              })
              const senderVirt = String(item.realUserId) === botId
                ? String(api.config()?.botQQ || '700000000001')
                : toVirtUser(item.realUserId, item.nickname)
              return {
                message_id: Number(virtMid),
                message_type: item.kind,
                group_id: isGroup ? Number(params.group_id) : undefined,
                user_id: Number(senderVirt),
                time: item.time,
                sender: { user_id: Number(senderVirt), nickname: item.nickname, card: item.nickname },
                message: item.segments,
                raw_message: item.text,
              }
            })
            return { messages }
          }
          case 'delete_msg': {
            const ref = idMap.resolveMessage(params.message_id)
            if (!ref?.realChatId || !ref?.realMsgId) throw new Error('找不到要撤回的 Telegram 消息')
            await client.callApi('deleteMessage', { chat_id: ref.realChatId, message_id: Number(ref.realMsgId) }, opts)
            return {}
          }
          case 'set_msg_emoji_like': {
            const ref = idMap.resolveMessage(params.message_id)
            if (ref?.realChatId && ref?.realMsgId) {
              await client.react(ref.realChatId, ref.realMsgId, params.emoji_id)
            }
            return {}
          }
          case 'set_input_status': {
            const realUid = toRealUser(params.user_id)
            if (realUid) await client.callApi('sendChatAction', { chat_id: realUid, action: 'typing' }, { timeoutMs: 5000 }).catch(() => {})
            return {}
          }
          case 'set_group_ban': {
            const realGid = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            if (!realGid || !realUid) throw new Error('Telegram 禁言目标无效')
            const duration = Number(params.duration) || 0
            await client.callApi('restrictChatMember', {
              chat_id: realGid,
              user_id: Number(realUid),
              permissions: duration > 0
                ? { can_send_messages: false }
                : {
                    can_send_messages: true, can_send_audios: true, can_send_documents: true,
                    can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
                    can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
                    can_add_web_page_previews: true,
                  },
              ...(duration > 0 ? { until_date: Math.floor(Date.now() / 1000) + Math.max(30, duration) } : {}),
            }, opts)
            return {}
          }
          case 'set_group_whole_ban': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) throw new Error('Telegram 群目标无效')
            await client.callApi('setChatPermissions', { chat_id: realGid, permissions: { can_send_messages: !params.enable } }, opts)
            return {}
          }
          case 'set_group_kick': {
            const realGid = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            if (!realGid || !realUid) throw new Error('Telegram 踢人目标无效')
            await client.callApi('banChatMember', { chat_id: realGid, user_id: Number(realUid) }, opts)
            if (!params.reject_add_request) {
              await client.callApi('unbanChatMember', { chat_id: realGid, user_id: Number(realUid), only_if_banned: true }, opts).catch(() => {})
            }
            return {}
          }
          case 'set_group_card':
          case 'set_group_special_title': {
            const realGid = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            const title = String(params.special_title ?? params.card ?? '').slice(0, 16)
            if (realGid && realUid) {
              await client.callApi('setChatAdministratorCustomTitle', { chat_id: realGid, user_id: Number(realUid), custom_title: title }, opts)
            }
            return {}
          }
          case 'set_group_name': {
            const realGid = toRealGroup(params.group_id)
            if (realGid) await client.callApi('setChatTitle', { chat_id: realGid, title: String(params.group_name || '') }, opts)
            return {}
          }
          case 'set_group_admin': {
            const realGid = toRealGroup(params.group_id)
            const realUid = toRealUser(params.user_id)
            if (realGid && realUid) {
              const on = Boolean(params.enable)
              await client.callApi('promoteChatMember', {
                chat_id: realGid, user_id: Number(realUid),
                can_manage_chat: on, can_delete_messages: on, can_restrict_members: on, can_pin_messages: on, can_invite_users: on,
              }, opts)
            }
            return {}
          }
          case '_send_group_notice':
          case 'send_group_notice': {
            const realGid = toRealGroup(params.group_id)
            if (!realGid) throw new Error('Telegram 群目标无效')
            const sent = await client.callApi('sendMessage', { chat_id: realGid, text: `【群公告】\n${String(params.content || '')}` }, opts)
            if (sent?.message_id) await client.callApi('pinChatMessage', { chat_id: realGid, message_id: sent.message_id }, opts).catch(() => {})
            return sent
          }
          case 'set_essence_msg':
          case 'delete_essence_msg': {
            const ref = idMap.resolveMessage(params.message_id)
            if (ref?.realChatId && ref?.realMsgId) {
              await client.callApi(action === 'set_essence_msg' ? 'pinChatMessage' : 'unpinChatMessage', {
                chat_id: ref.realChatId,
                message_id: Number(ref.realMsgId),
              }, opts)
            }
            return {}
          }
          case 'set_group_add_request': {
            const parts = String(params.flag || '').split(':')
            const realGid = parts[0] === 'tg_join' ? parts[1] : toRealGroup(params.group_id)
            const realUid = parts[0] === 'tg_join' ? parts[2] : toRealUser(params.user_id)
            if (!realGid || !realUid) throw new Error('Telegram 加群审批参数无效')
            await client.callApi(params.approve ? 'approveChatJoinRequest' : 'declineChatJoinRequest', {
              chat_id: realGid,
              user_id: Number(realUid),
            }, opts)
            return {}
          }
          case 'set_qq_profile':
            await client.callApi('setMyName', { name: String(params.nickname || '').slice(0, 64) }, opts)
            return {}
          case 'set_self_longnick': {
            const desc = String(params.longNick || '').slice(0, 512)
            await client.callApi('setMyDescription', { description: desc }, opts)
            await client.callApi('setMyShortDescription', { short_description: desc.slice(0, 120) }, opts).catch(() => {})
            return {}
          }
          default:
            return {}
        }
      },
    }

    const unregisterRouter = router.register('telegram', adapter)

    const syncConnection = () => {
      const s = effectiveSettings()
      resolveOwnerVirtId()
      for (const uid of parseList(s.allowPrivate)) allowSync.allowPrivate(toVirtUser(uid))
      for (const gid of parseList(s.allowGroups)) allowSync.allowGroup(idMap.toVirtualGroup(gid))
      if (s.enabled && s.token) {
        client.start().catch(() => {})
      } else if (client.state() !== 'stopped') {
        client.stop()
      }
    }

    api.on('config', () => syncConnection())
    api.every(20_000, () => client.watch(), 'Telegram 连接守护')
    api.later(200, () => syncConnection())

    // 面板 HTTP 路由（内置模块无 /ext/telegram 前缀，自带 /telegram/ 前缀）
    api.route('/telegram/status', async () => {
      const s = effectiveSettings()
      const me = client.me()
      return {
        ok: true,
        state: client.state(),
        enabled: s.enabled,
        tokenConfigured: Boolean(s.token),
        apiBase: s.apiBase,
        ownerId: s.ownerId,
        settings: {
          enabled: Boolean(s.enabled),
          tokenSet: Boolean(s.token),
          apiBase: s.apiBase || 'https://api.telegram.org',
          ownerId: s.ownerId || '',
          requireMentionInGroup: Boolean(s.requireMentionInGroup),
          nonMentionReplyMode: s.nonMentionReplyMode === 'aurabot' ? 'aurabot' : 'always',
        },
        lastError: client.lastError(),
        bot: me ? { id: String(me.id), username: me.username || '', name: me.first_name || '' } : null,
        counters: client.counters(),
        mappings: idMap.snapshot(25),
      }
    })

    api.route('/telegram/save', async (req) => {
      const body = (await api.core.http.body(req)) || {}
      const cur = api.settings()
      const patch = {}
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
      if (typeof body.token === 'string' && body.token.trim() !== '') {
        patch.token = body.token.trim()
      }
      if (body.apiBase !== undefined) {
        patch.apiBase = String(body.apiBase || 'https://api.telegram.org').trim() || 'https://api.telegram.org'
      }
      if (body.ownerId !== undefined) patch.ownerId = String(body.ownerId || '').trim()
      if (body.requireMentionInGroup !== undefined) patch.requireMentionInGroup = Boolean(body.requireMentionInGroup)
      if (body.nonMentionReplyMode === 'always' || body.nonMentionReplyMode === 'aurabot') {
        patch.nonMentionReplyMode = body.nonMentionReplyMode
      }

      api.saveSettings({ ...cur, ...patch })
      const next = effectiveSettings()
      if (next.enabled && next.token) {
        try {
          await client.restart()
          const me = client.me()
          return { ok: true, message: `Telegram 设置已保存并连接 @${me?.username || me?.id || 'Bot'}` }
        } catch (err) {
          return { ok: true, message: `设置已保存，但连接失败：${err.message}` }
        }
      }
      client.stop()
      return { ok: true, message: 'Telegram 设置已保存' }
    })

    api.route('/telegram/reconnect', async () => {
      const s = effectiveSettings()
      if (!s.token) return { ok: false, message: '请先填写并保存 Telegram Bot Token' }
      if (!s.enabled) api.saveSettings({ ...api.settings(), enabled: true })
      try {
        await client.restart()
        const me = client.me()
        return { ok: true, message: `已连接 @${me?.username || me?.id || 'Telegram Bot'}` }
      } catch (err) {
        return { ok: false, message: `连接失败：${err.message}` }
      }
    })

    api.route('/telegram/unbind', async () => {
      client.stop()
      api.saveSettings({ ...api.settings(), enabled: false, token: '' })
      return { ok: true, message: '已解绑 Telegram Bot Token 并断开连接' }
    })

    api.route('/telegram/test-send', async (req) => {
      const body = await api.core.http.body(req)
      const s = effectiveSettings()
      const targetId = String(body?.chatId || s.ownerId || '').trim()
      if (!targetId) return { ok: false, message: '请先填写「主人 Telegram 数字 ID」或指定目标 ID' }
      if (client.state() !== 'connected') await client.start()
      const text = String(body?.text || '🐟 大肥鱼 Telegram 模块连通测试成功！').trim()
      const res = await client.sendSegmentsRaw(targetId.startsWith('-') ? 'group' : 'private', targetId, [{ type: 'text', data: { text } }])
      return { ok: true, message: `已发送测试消息（message_id=${res?.message_id}）` }
    })

    api.command({
      name: 'tg',
      desc: '查看 Telegram 平台连接状态与收发统计',
      run: () => {
        const me = client.me()
        const c = client.counters()
        return `Telegram 状态：${client.state()}${me ? `（@${me.username || me.id}）` : ''} · 收 ${c.inbound} / 发 ${c.outbound}`
      },
    })

    api.onDispose(() => {
      unregisterRouter()
      client.stop()
      allowSync.cleanup()
      idMap.flush()
    })

    return {
      active: () => client.state() === 'connected',
      state: () => client.state(),
      summary: () => {
        const me = client.me()
        return {
          state: client.state(),
          enabled: Boolean(effectiveSettings().enabled),
          hasToken: Boolean(effectiveSettings().token),
          username: me?.username || '',
          botId: me?.id ? String(me.id) : '',
        }
      },
      bot: () => client.me(),
      toVirtualUser: toVirtUser,
      toVirtualGroup: (gid, name) => idMap.toVirtualGroup(gid, name),
    }
  },
}
