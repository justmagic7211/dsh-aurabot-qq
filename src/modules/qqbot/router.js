// 多平台共享 OneBot 路由器 + 虚拟数字 ID 映射器
// 支持多个外部平台模块（如 telegram / qqbot）与原版 SnowLuma/NapCat 同时在线、独立热重载互不覆盖。

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTER_SYMBOL = Symbol.for('aurabot.multiPlatformRouter.v1')

const LIST_MERGE_ACTIONS = new Set(['get_group_list', 'get_friend_list'])
const CUSTOM_FACE_ACTIONS = new Set(['add_custom_face', 'modify_custom_face', 'delete_custom_face', 'fetch_custom_face'])
const B64_URI_RE = /(?:base64:\/\/|data:[^;\s]+;base64,)[A-Za-z0-9+/=\r\n]{120,}/g

function detectImgExt(buf) {
  if (!buf || buf.length < 12) return 'png'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  return 'png'
}

function sanitizeOneBotError(err) {
  if (!err || typeof err.message !== 'string') return err
  if (!B64_URI_RE.test(err.message)) return err
  B64_URI_RE.lastIndex = 0
  const cleaned = err.message.replace(B64_URI_RE, (m) => {
    const idx = m.indexOf('base64')
    const head = m.startsWith('data:') ? m.slice(0, idx + 7) : 'base64://'
    return `${head}[omitted ${m.length} chars]`
  })
  try {
    err.message = cleaned
    return err
  } catch {
    return new Error(cleaned)
  }
}

/**
 * 获取或挂载挂在 api.core.onebot 上的多平台共享路由器。
 * 任意顺序加载、卸载或 reload_module 均不会互相覆盖其它平台模块的拦截器。
 */
export function acquirePlatformRouter(api) {
  const onebot = api.core.onebot
  if (!onebot || typeof onebot.call !== 'function') {
    throw new Error('当前宿主未暴露 api.core.onebot.call')
  }

  let router = onebot[ROUTER_SYMBOL]
  if (!router) {
    const rawCall = onebot.call.bind(onebot)
    const adapters = new Map() // platformId → adapter
    const state = {
      lastOwnerPlatform: 'qq', // 'qq' | 'telegram' | 'qqbot' | ...
      lastOwnerAt: 0,
    }

    const findAdapterForCall = (action, params = {}) => {
      // 1. 按群号或用户号或消息号精确归属判断
      for (const adapter of adapters.values()) {
        if (adapter.ownsTarget?.(action, params)) return adapter
      }
      // 2. 发往主人私聊（shared owner 模式下 user_id === cfg.ownerQQ）：按最近活跃的主人渠道投递
      const cfg = api.config()
      const ownerQQ = String(cfg?.ownerQQ || '')
      const uid = params?.user_id != null ? String(params.user_id) : ''
      if (ownerQQ && uid === ownerQQ && (action === 'send_private_msg' || action === 'upload_private_file' || action === 'send_poke' || action === 'get_friend_msg_history')) {
        if (state.lastOwnerPlatform && state.lastOwnerPlatform !== 'qq') {
          const hit = adapters.get(state.lastOwnerPlatform)
          if (hit && hit.isReady?.()) return hit
        }
        // 若原版 QQ 网关未连接，而某个外部平台配置了主人且在线，则自动兜底投递到在线平台
        if (onebot.state !== 'connected') {
          for (const adapter of adapters.values()) {
            if (adapter.hasOwner?.() && adapter.isReady?.()) return adapter
          }
        }
      }
      // 3. 当原版 QQ 网关未连接时，get_login_info 等全局查询可由已连接的平台兜底返回
      if (action === 'get_login_info' && onebot.state !== 'connected') {
        for (const adapter of adapters.values()) {
          if (adapter.isReady?.() && adapter.handleCall) return adapter
        }
      }
      return null
    }

    const routedCall = async (action, params = {}, opts) => {
      try {
        if (LIST_MERGE_ACTIONS.has(action) && adapters.size > 0) {
          const merged = []
          if (onebot.state === 'connected') {
            try {
              const base = await rawCall(action, params, opts)
              if (Array.isArray(base)) merged.push(...base)
              else if (Array.isArray(base?.data)) merged.push(...base.data)
            } catch {}
          }
          for (const adapter of adapters.values()) {
            if (!adapter.handleCall) continue
            try {
              const extra = await adapter.handleCall(action, params, opts)
              if (Array.isArray(extra)) merged.push(...extra)
            } catch {}
          }
          return merged
        }

        // QQ 漫游收藏表情动作（add/modify/delete/fetch_custom_face）不携带 group_id / user_id：
        // 1. 原版 OneBot (NapCat/SnowLuma) 未连接时，直接静默返回空结果，避免仅开 qqbot/telegram 时报错；
        // 2. NapCat 的 add_custom_face 对 file 直接执行 fs.stat(path)，传入 base64://... 会触发 ENAMETOOLONG 并刷屏百万字节日志，
        //    因此自动落盘为短路径临时文件再转发，调用完成后立即清理。
        if (CUSTOM_FACE_ACTIONS.has(action)) {
          if (onebot.state !== 'connected') {
            return action === 'fetch_custom_face' ? [] : {}
          }
          if (action === 'add_custom_face' && typeof params?.file === 'string' && params.file.startsWith('base64://')) {
            const buf = Buffer.from(params.file.slice(9), 'base64')
            const tmpFile = join(tmpdir(), `aurabot-face-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${detectImgExt(buf)}`)
            writeFileSync(tmpFile, buf)
            try {
              return await rawCall(action, { ...params, file: tmpFile }, opts)
            } finally {
              try { unlinkSync(tmpFile) } catch {}
            }
          }
        }

        const targetAdapter = findAdapterForCall(action, params)
        if (targetAdapter) {
          return await targetAdapter.handleCall(action, params, opts)
        }
        return await rawCall(action, params, opts)
      } catch (err) {
        throw sanitizeOneBotError(err)
      }
    }

    onebot.call = routedCall
    router = {
      rawCall,
      adapters,
      state,
      register(platformId, adapter) {
        adapters.set(platformId, adapter)
        if (onebot.call !== routedCall) onebot.call = routedCall
        return () => router.unregister(platformId, adapter)
      },
      unregister(platformId, adapter) {
        if (adapter && adapters.get(platformId) !== adapter) return
        adapters.delete(platformId)
        if (state.lastOwnerPlatform === platformId) state.lastOwnerPlatform = 'qq'
      },
      markOwnerActive(platformId) {
        state.lastOwnerPlatform = platformId
        state.lastOwnerAt = Date.now()
      },
    }
    Object.defineProperty(onebot, ROUTER_SYMBOL, { value: router, configurable: true, enumerable: false })
  }

  // 监听原版 OneBot 私聊消息：若主人在原版 QQ 说话，把活跃主人渠道切回 'qq'
  api.on('onebot', (ev) => {
    if (!ev || ev.post_type !== 'message' || ev._fromPlatformModule) return
    const ownerQQ = String(api.config()?.ownerQQ || '')
    if (ownerQQ && String(ev.user_id || '') === ownerQQ) {
      router.markOwnerActive('qq')
    }
  })

  return router
}

/**
 * 创建持久化双向虚拟数字 ID 映射器（12 位安全正整数，完美兼容原版 hub.js / access.js / qq-tools）。
 *
 * 例如 prefixUser='81', prefixGroup='82', prefixMsg='89'：
 *   user  → 810000000001
 *   group → 820000000001
 *   msg   → 890000000001 （内存 LRU，最多保留 maxMessages 条）
 */
export function createVirtualIdMapper({ file, prefixUser, prefixGroup, prefixChannel = '', prefixMsg, maxMessages = 5000 }) {
  const pUser = String(prefixUser)
  const pGroup = String(prefixGroup)
  const pChan = String(prefixChannel || '')
  const pMsg = String(prefixMsg)

  const userToVirt = new Map()
  const virtToUser = new Map()
  const groupToVirt = new Map()
  const virtToGroup = new Map()
  const chanToVirt = new Map()
  const virtToChan = new Map()
  const metaByVirt = new Map() // virtId → { rawId, kind, name, updatedAt }

  let userSeq = 0
  let groupSeq = 0
  let chanSeq = 0
  let msgSeq = 0

  const msgToVirt = new Map() // key → virtMsgId
  const virtToMsg = new Map() // virtMsgId → payload

  const formatVirt = (prefix, seq) => `${prefix}${String(seq).padStart(10, '0')}`

  const load = () => {
    if (!file || !existsSync(file)) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      userSeq = Number(data.userSeq) || 0
      groupSeq = Number(data.groupSeq) || 0
      chanSeq = Number(data.chanSeq) || 0
      for (const [raw, virt] of Object.entries(data.users || {})) {
        userToVirt.set(raw, String(virt))
        virtToUser.set(String(virt), raw)
      }
      for (const [raw, virt] of Object.entries(data.groups || {})) {
        groupToVirt.set(raw, String(virt))
        virtToGroup.set(String(virt), raw)
      }
      for (const [raw, virt] of Object.entries(data.channels || {})) {
        chanToVirt.set(raw, String(virt))
        virtToChan.set(String(virt), raw)
      }
      for (const [virt, meta] of Object.entries(data.meta || {})) {
        metaByVirt.set(String(virt), meta)
      }
    } catch {}
  }

  let saveTimer = null
  const saveNow = () => {
    if (!file) return
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const out = {
        userSeq,
        groupSeq,
        chanSeq,
        users: Object.fromEntries(userToVirt),
        groups: Object.fromEntries(groupToVirt),
        channels: Object.fromEntries(chanToVirt),
        meta: Object.fromEntries(metaByVirt),
      }
      writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
    } catch {}
  }

  const scheduleSave = () => {
    if (!file || saveTimer) return
    saveTimer = setTimeout(saveNow, 500)
    saveTimer?.unref?.()
  }

  load()

  const touchMeta = (virt, rawId, kind, name) => {
    if (!name && metaByVirt.has(virt)) return
    const prev = metaByVirt.get(virt) || {}
    metaByVirt.set(virt, {
      rawId: String(rawId),
      kind,
      name: String(name || prev.name || ''),
      updatedAt: Date.now(),
    })
  }

  return {
    toVirtualUser(rawUserId, name = '') {
      const key = String(rawUserId ?? '').trim()
      if (!key) return ''
      let virt = userToVirt.get(key)
      if (!virt) {
        virt = formatVirt(pUser, ++userSeq)
        userToVirt.set(key, virt)
        virtToUser.set(virt, key)
        scheduleSave()
      }
      if (name) { touchMeta(virt, key, 'user', name); scheduleSave() }
      return virt
    },

    toRealUser(virtId) {
      return virtToUser.get(String(virtId ?? '').trim()) ?? null
    },

    toVirtualGroup(rawGroupId, name = '') {
      const key = String(rawGroupId ?? '').trim()
      if (!key) return ''
      let virt = groupToVirt.get(key)
      if (!virt) {
        virt = formatVirt(pGroup, ++groupSeq)
        groupToVirt.set(key, virt)
        virtToGroup.set(virt, key)
        scheduleSave()
      }
      if (name) { touchMeta(virt, key, 'group', name); scheduleSave() }
      return virt
    },

    toRealGroup(virtId) {
      const s = String(virtId ?? '').trim()
      return virtToGroup.get(s) ?? (pChan ? virtToChan.get(s) ?? null : null)
    },

    toVirtualChannel(rawChanId, name = '') {
      if (!pChan) return this.toVirtualGroup(rawChanId, name)
      const key = String(rawChanId ?? '').trim()
      if (!key) return ''
      let virt = chanToVirt.get(key)
      if (!virt) {
        virt = formatVirt(pChan, ++chanSeq)
        chanToVirt.set(key, virt)
        virtToChan.set(virt, key)
        scheduleSave()
      }
      if (name) { touchMeta(virt, key, 'channel', name); scheduleSave() }
      return virt
    },

    toRealChannel(virtId) {
      return pChan ? (virtToChan.get(String(virtId ?? '').trim()) ?? null) : null
    },

    isVirtualUser(id) {
      const s = String(id ?? '').trim()
      return s.length === pUser.length + 10 && s.startsWith(pUser) && virtToUser.has(s)
    },

    isVirtualGroup(id) {
      const s = String(id ?? '').trim()
      if (s.length === pGroup.length + 10 && s.startsWith(pGroup) && virtToGroup.has(s)) return true
      if (pChan && s.length === pChan.length + 10 && s.startsWith(pChan) && virtToChan.has(s)) return true
      return false
    },

    isVirtualMsg(id) {
      const s = String(id ?? '').trim()
      return s.length === pMsg.length + 10 && s.startsWith(pMsg) && virtToMsg.has(s)
    },

    rememberMessage(uniqueKey, payload) {
      const key = String(uniqueKey ?? '').trim()
      if (!key) return ''
      let virt = msgToVirt.get(key)
      if (!virt) {
        virt = formatVirt(pMsg, ++msgSeq)
        msgToVirt.set(key, virt)
        if (msgToVirt.size > maxMessages) {
          const oldestKey = msgToVirt.keys().next().value
          const oldestVirt = msgToVirt.get(oldestKey)
          msgToVirt.delete(oldestKey)
          virtToMsg.delete(oldestVirt)
        }
      }
      virtToMsg.set(virt, { ...(virtToMsg.get(virt) || {}), ...payload, virtMsgId: virt, at: Date.now() })
      return virt
    },

    resolveMessage(virtMsgId) {
      return virtToMsg.get(String(virtMsgId ?? '').trim()) ?? null
    },

    lookupMeta(virtId) {
      return metaByVirt.get(String(virtId ?? '').trim()) || null
    },

    snapshot(limit = 50) {
      const items = []
      for (const [virt, raw] of virtToUser) {
        items.push({ virtId: virt, rawId: raw, kind: 'private', name: metaByVirt.get(virt)?.name || '' })
      }
      for (const [virt, raw] of virtToGroup) {
        items.push({ virtId: virt, rawId: raw, kind: 'group', name: metaByVirt.get(virt)?.name || '' })
      }
      for (const [virt, raw] of virtToChan) {
        items.push({ virtId: virt, rawId: raw, kind: 'channel', name: metaByVirt.get(virt)?.name || '' })
      }
      return items.slice(-limit).reverse()
    },

    flush: saveNow,
  }
}

/**
 * 动态在内存中的 cfg.allow.private / cfg.allow.groups 注入允许通行的虚拟 ID，
 * 让未修改核心代码的 dsh-aurabot-qq 的 checkAllowed(cfg, msg) 直接放行，同时不污染磁盘白名单。
 */
export function createRuntimeAllowSync(api) {
  const injectedPrivate = new Set()
  const injectedGroups = new Set()

  const applyToConfig = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return
    if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { private: [], groups: [] }
    if (!Array.isArray(cfg.allow.private)) cfg.allow.private = []
    if (!Array.isArray(cfg.allow.groups)) cfg.allow.groups = []
    for (const uid of injectedPrivate) {
      if (!cfg.allow.private.includes(uid)) cfg.allow.private.push(uid)
    }
    for (const gid of injectedGroups) {
      if (!cfg.allow.groups.includes(gid)) cfg.allow.groups.push(gid)
    }
  }

  api.on('config', (nextCfg) => applyToConfig(nextCfg))

  return {
    allowPrivate(virtUserId) {
      const id = String(virtUserId || '').trim()
      if (!id) return
      injectedPrivate.add(id)
      applyToConfig(api.config())
    },
    allowGroup(virtGroupId) {
      const id = String(virtGroupId || '').trim()
      if (!id) return
      injectedGroups.add(id)
      applyToConfig(api.config())
    },
    cleanup() {
      const cfg = api.config()
      if (cfg?.allow) {
        if (Array.isArray(cfg.allow.private)) {
          cfg.allow.private = cfg.allow.private.filter((x) => !injectedPrivate.has(String(x)))
        }
        if (Array.isArray(cfg.allow.groups)) {
          cfg.allow.groups = cfg.allow.groups.filter((x) => !injectedGroups.has(String(x)))
        }
      }
      injectedPrivate.clear()
      injectedGroups.clear()
    },
  }
}
