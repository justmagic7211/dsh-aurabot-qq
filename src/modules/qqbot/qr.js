// 零依赖内置：腾讯官方 QQBot 手机扫码绑定协议 + 纯 JS SVG 二维码编码器
// 完整对齐 @tencent-connect/qqbot-connector@1.2.0 协议，无需安装任何外部 npm 包即可扫码创建/绑定机器人。

import { createDecipheriv, randomBytes } from 'node:crypto'

export const BindStatus = Object.freeze({
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
})

const HOSTS = {
  production: 'q.qq.com',
  test: 'test.q.qq.com',
}

export function generateBindKey() {
  return randomBytes(32).toString('base64')
}

export function decryptBindSecret(encryptedB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64')
  const raw = Buffer.from(encryptedB64, 'base64')
  if (raw.length < 29) throw new Error('加密凭据长度异常')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function buildConnectUrl(taskId, source = 'dsh-qqbot', env = 'production') {
  const host = HOSTS[env] || HOSTS.production
  return `https://${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source || '')}&_wv=2`
}

async function postJson(url, body, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, signal } = {}) {
  const timeoutSig = AbortSignal.timeout(timeoutMs)
  const sig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: sig,
  })
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  return res.json()
}

export async function createBindTask({ env = 'production', timeoutMs = 10_000, fetchImpl, signal } = {}) {
  const host = HOSTS[env] || HOSTS.production
  const url = `https://${host}/lite/create_bind_task`
  const key = generateBindKey()
  const json = await postJson(url, { key }, { fetchImpl, timeoutMs, signal })
  if (json?.retcode !== 0) throw new Error(json?.msg || 'create_bind_task failed')
  if (!json?.data?.task_id) throw new Error('create_bind_task: missing task_id')
  return { taskId: String(json.data.task_id), key }
}

export async function pollBindResult(taskId, { env = 'production', timeoutMs = 10_000, fetchImpl, signal } = {}) {
  const host = HOSTS[env] || HOSTS.production
  const url = `https://${host}/lite/poll_bind_result`
  const json = await postJson(url, { task_id: taskId }, { fetchImpl, timeoutMs, signal })
  if (json?.retcode !== 0) throw new Error(json?.msg || 'poll_bind_result failed')
  return {
    status: json?.data?.status ?? BindStatus.NONE,
    botAppId: String(json?.data?.bot_appid ?? ''),
    botEncryptSecret: String(json?.data?.bot_encrypt_secret ?? ''),
    userOpenid: json?.data?.user_openid ? String(json.data.user_openid) : undefined,
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    timer?.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

/**
 * 内置零依赖版 startQrConnect（与 @tencent-connect/qqbot-connector 签名一致）
 */
export function startLiteQrConnect(callbacks = {}, options = {}) {
  const ctl = new AbortController()
  const signal = options.signal ? AbortSignal.any([ctl.signal, options.signal]) : ctl.signal
  const pollIntervalMs = Math.max(500, Number(options.pollIntervalMs) || 2000)
  const env = options.env || 'production'
  const source = options.source ?? 'dsh-qqbot'
  const fetchImpl = options.fetchImpl || globalThis.fetch

  ;(async () => {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      let task
      try {
        task = await createBindTask({ env, fetchImpl, signal })
      } catch (err) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        throw new Error(`获取绑定任务失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      const connectUrl = buildConnectUrl(task.taskId, source, env)
      await callbacks.onQrDisplayed?.(connectUrl)

      let expired = false
      while (!signal.aborted) {
        let res
        try {
          res = await pollBindResult(task.taskId, { env, fetchImpl, signal })
        } catch {
          await abortableSleep(pollIntervalMs, signal)
          continue
        }
        if (res.status === BindStatus.COMPLETED) {
          const appSecret = decryptBindSecret(res.botEncryptSecret, task.key)
          callbacks.onSuccess?.([{
            appId: res.botAppId,
            appSecret,
            userOpenid: res.userOpenid,
          }])
          return
        }
        if (res.status === BindStatus.EXPIRED) {
          expired = true
          break
        }
        await abortableSleep(pollIntervalMs, signal)
      }
      if (expired && !signal.aborted) {
        callbacks.onQrExpired?.()
      }
    }
  })().catch((err) => {
    if (err?.name === 'AbortError' || signal.aborted) {
      callbacks.onFailure?.(new Error('已取消'))
      return
    }
    callbacks.onFailure?.(err instanceof Error ? err : new Error(String(err)))
  })

  return () => ctl.abort()
}

// ---------------- 零依赖 ISO/IEC 18004 QR Code 编码器（Byte 模式 · 纠错等级 L · Version 1–10） ----------------

// [ecCodewordsPerBlock, dataBlockLengths[], alignmentCenters[]]
const QR_VER_L = [
  null,
  [7, [19], []],
  [10, [34], [6, 18]],
  [15, [55], [6, 22]],
  [20, [80], [6, 26]],
  [26, [108], [6, 30]],
  [18, [68, 68], [6, 34]],
  [20, [78, 78], [6, 22, 38]],
  [24, [97, 97], [6, 24, 42]],
  [30, [116, 116], [6, 26, 46]],
  [18, [68, 68, 69, 69], [6, 28, 50]],
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const rem = new Uint8Array(ecLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecLen - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor)
      }
    }
  }
  return rem
}

function bchFormatBits(ecLevelBits, mask) {
  const data = (ecLevelBits << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function bchVersionBits(ver) {
  let rem = ver << 12
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12)
  }
  return (ver << 12) | rem
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return false
  }
}

function penaltyScore(grid) {
  const n = grid.length
  let score = 0
  // N1: 连续同色 >= 5
  for (let r = 0; r < n; r++) {
    let runH = 1
    let runV = 1
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === grid[r][c - 1]) {
        runH++
        if (runH === 5) score += 3
        else if (runH > 5) score += 1
      } else runH = 1
      if (grid[c][r] === grid[c - 1][r]) {
        runV++
        if (runV === 5) score += 3
        else if (runV > 5) score += 1
      } else runV = 1
    }
  }
  // N2: 2x2 同色块
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c]
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3
    }
  }
  // N3: 1:1:3:1:1 finder 样式
  const hasFinderLike = (arr, i) => (
    arr[i] && !arr[i + 1] && arr[i + 2] && arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] &&
    ((i >= 4 && !arr[i - 1] && !arr[i - 2] && !arr[i - 3] && !arr[i - 4]) ||
     (i + 10 < n && !arr[i + 7] && !arr[i + 8] && !arr[i + 9] && !arr[i + 10]))
  )
  for (let r = 0; r < n; r++) {
    const col = new Array(n)
    for (let i = 0; i < n; i++) col[i] = grid[i][r]
    for (let c = 0; c <= n - 7; c++) {
      if (hasFinderLike(grid[r], c)) score += 40
      if (hasFinderLike(col, c)) score += 40
    }
  }
  // N4: 深色占比偏离 50%
  let dark = 0
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) dark++
  const k = Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n))
  score += k * 10
  return score
}

/**
 * 将 UTF-8 字符串编码为布尔二维码矩阵（true = 深色模块）。
 */
export function encodeQrMatrix(text) {
  const payload = Buffer.from(String(text || ''), 'utf8')
  let ver = 0
  for (let v = 1; v <= 10; v++) {
    const [, blocks] = QR_VER_L[v]
    const totalDataBytes = blocks.reduce((a, b) => a + b, 0)
    const countBits = v < 10 ? 8 : 16
    const neededBits = 4 + countBits + payload.length * 8
    if (neededBits <= totalDataBytes * 8) {
      ver = v
      break
    }
  }
  if (!ver) throw new Error('二维码内容过长（超出 Version 10 容量）')

  const [ecLen, blockSizes, alignCenters] = QR_VER_L[ver]
  const totalDataCodewords = blockSizes.reduce((a, b) => a + b, 0)
  const countBits = ver < 10 ? 8 : 16

  // 组装数据比特流：0100 (Byte 模式) + 长度 + UTF-8 字节 + 终止符 + 0xEC/0x11 补齐
  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  pushBits(0b0100, 4)
  pushBits(payload.length, countBits)
  for (const byte of payload) pushBits(byte, 8)

  const maxDataBits = totalDataCodewords * 8
  pushBits(0, Math.min(4, maxDataBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const dataBytes = new Uint8Array(totalDataCodewords)
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]
    dataBytes[i] = b
  }
  for (let i = bits.length / 8, toggle = 0; i < totalDataCodewords; i++, toggle ^= 1) {
    dataBytes[i] = toggle ? 0x11 : 0xec
  }

  // 分块计算 Reed-Solomon 纠错码并交织
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (const sz of blockSizes) {
    const block = dataBytes.subarray(offset, offset + sz)
    offset += sz
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, ecLen))
  }

  const finalCodewords = []
  const maxBlockLen = Math.max(...blockSizes)
  for (let i = 0; i < maxBlockLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) finalCodewords.push(blk[i])
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ec of ecBlocks) finalCodewords.push(ec[i])
  }

  // 初始化矩阵与功能区标记
  const size = ver * 4 + 17
  const base = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false))
  const setFunc = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    base[r][c] = Boolean(dark)
    isFunc[r][c] = true
  }

  // Finder + 分隔白边
  const placeFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
        const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (d === 3 || d === 0 || d === 1)
        setFunc(top + dr, left + dc, dark)
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  // Timing 线
  for (let i = 8; i < size - 8; i++) {
    if (!isFunc[6][i]) setFunc(6, i, i % 2 === 0)
    if (!isFunc[i][6]) setFunc(i, 6, i % 2 === 0)
  }

  // Alignment 校正图形
  for (const r of alignCenters) {
    for (const c of alignCenters) {
      if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const d = Math.max(Math.abs(dr), Math.abs(dc))
          setFunc(r + dr, c + dc, d !== 1)
        }
      }
    }
  }

  // Dark Module + 预留 Format 信息区
  setFunc(4 * ver + 9, 8, true)
  for (let i = 0; i < 9; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false)
    if (!isFunc[i][8]) setFunc(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][size - 1 - i]) setFunc(8, size - 1 - i, false)
    if (!isFunc[size - 1 - i][8]) setFunc(size - 1 - i, 8, false)
  }

  // Version >= 7 时写入 18 位版本信息
  if (ver >= 7) {
    const vBits = bchVersionBits(ver)
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunc(b, a, bit)
      setFunc(a, b, bit)
    }
  }

  // 按双列蛇形写入数据码字
  let bitIdx = 0
  const totalBits = finalCodewords.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过垂直 Timing 列
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step
      for (let dc = 0; dc < 2; dc++) {
        const c = right - dc
        if (isFunc[r][c]) continue
        let dark = false
        if (bitIdx < totalBits) {
          dark = ((finalCodewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1
          bitIdx++
        }
        base[r][c] = dark
      }
    }
    upward = !upward
  }

  const writeFormatInfo = (grid, mask) => {
    // 纠错等级 L 的格式位为 01 (二进制 1)
    const fBits = bchFormatBits(0b01, mask)
    for (let i = 0; i <= 5; i++) grid[8][i] = ((fBits >> (14 - i)) & 1) === 1
    grid[8][7] = ((fBits >> 8) & 1) === 1
    grid[8][8] = ((fBits >> 7) & 1) === 1
    grid[7][8] = ((fBits >> 6) & 1) === 1
    for (let i = 9; i < 15; i++) grid[14 - i][8] = ((fBits >> (14 - i)) & 1) === 1

    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = ((fBits >> i) & 1) === 1
    for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = ((fBits >> i) & 1) === 1
    grid[size - 8][8] = true
  }

  // 遍历 8 种掩码选择最低惩罚分
  let bestGrid = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row, r) => row.map((v, c) => (!isFunc[r][c] && maskBit(mask, r, c) ? !v : v)))
    writeFormatInfo(candidate, mask)
    const sc = penaltyScore(candidate)
    if (sc < bestScore) {
      bestScore = sc
      bestGrid = candidate
    }
  }
  return bestGrid
}

/**
 * 零依赖渲染二维码为 SVG Data URL（供面板 <img src> 直接展示）
 */
export function renderLiteQrSvgDataUrl(text, { margin = 2 } = {}) {
  const matrix = encodeQrMatrix(text)
  const n = matrix.length
  const total = n + margin * 2
  let paths = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) paths += `M${c + margin},${r + margin}h1v1h-1z`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${paths}" fill="#000"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
