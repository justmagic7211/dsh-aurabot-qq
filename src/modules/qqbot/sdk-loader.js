// @tencent-connect/dsh-qqbot 生态加载器与凭据发现器
// 1. 优先加载本地或 DSH Profile（含 pnpm 仓库）已安装的 @tencent-connect/qqbot-nodejs、@tencent-connect/qqbot-connector、qrcode
// 2. 支持直接扫描 ~/.dsh/profiles/*/cordis.patch.yml 读取 @tencent-connect/dsh-qqbot 已扫码绑定的凭据与白名单

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { startLiteQrConnect, renderLiteQrSvgDataUrl } from './qr.js'

function dshProfileDirs() {
  const home = process.env.DSH_HOME || resolve(homedir(), '.dsh')
  const profilesRoot = resolve(home, 'profiles')
  if (!existsSync(profilesRoot)) return []
  let names = []
  try { names = readdirSync(profilesRoot) } catch { return [] }
  // 优先 desktop 与常见 profile 名
  const priority = ['desktop', 'qqbot', 'default']
  names.sort((a, b) => {
    const ia = priority.indexOf(a)
    const ib = priority.indexOf(b)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return a.localeCompare(b)
  })
  return names.map((n) => ({ name: n, dir: resolve(profilesRoot, n) }))
}

function findPackageEntryInProfile(profileDir, pkgName, entryRelPaths) {
  const candidates = [
    resolve(profileDir, 'node_modules', ...pkgName.split('/')),
    resolve(profileDir, 'dependencies', 'node_modules', ...pkgName.split('/')),
  ]
  // 兼容 Desktop profile 的 pnpm 布局：dependencies/node_modules/.pnpm/<pkg>@*/node_modules/<pkg>
  for (const pnpmRoot of [
    resolve(profileDir, 'node_modules', '.pnpm'),
    resolve(profileDir, 'dependencies', 'node_modules', '.pnpm'),
  ]) {
    if (!existsSync(pnpmRoot)) continue
    const prefix = pkgName.replace('/', '+') + '@'
    try {
      for (const entry of readdirSync(pnpmRoot)) {
        if (entry.startsWith(prefix)) {
          candidates.push(resolve(pnpmRoot, entry, 'node_modules', ...pkgName.split('/')))
        }
      }
    } catch {}
  }

  for (const pkgDir of candidates) {
    if (!existsSync(pkgDir)) continue
    for (const rel of entryRelPaths) {
      const full = resolve(pkgDir, rel)
      if (existsSync(full)) return full
    }
  }
  return ''
}

let cachedNodeSdk = undefined
export async function loadOfficialQqbotSdk() {
  if (cachedNodeSdk !== undefined) return cachedNodeSdk
  try {
    cachedNodeSdk = await import('@tencent-connect/qqbot-nodejs')
    return cachedNodeSdk
  } catch {}
  for (const p of dshProfileDirs()) {
    const hit = findPackageEntryInProfile(p.dir, '@tencent-connect/qqbot-nodejs', ['dist/index.js', 'lib/index.js'])
    if (hit) {
      try {
        cachedNodeSdk = await import(pathToFileURL(hit).href)
        return cachedNodeSdk
      } catch {}
    }
  }
  cachedNodeSdk = null
  return null
}

let cachedConnector = undefined
export async function loadOfficialQrConnector() {
  if (cachedConnector !== undefined) return cachedConnector
  try {
    cachedConnector = await import('@tencent-connect/qqbot-connector')
    return cachedConnector
  } catch {}
  for (const p of dshProfileDirs()) {
    const hit = findPackageEntryInProfile(p.dir, '@tencent-connect/qqbot-connector', ['dist/esm/index.js', 'dist/cjs/index.js'])
    if (hit) {
      try {
        cachedConnector = await import(pathToFileURL(hit).href)
        return cachedConnector
      } catch {}
    }
  }
  // 零依赖回退到内置扫码绑定实现
  cachedConnector = { startQrConnect: startLiteQrConnect, builtin: true }
  return cachedConnector
}

let cachedQrLib = undefined
function loadQrcodeLib() {
  if (cachedQrLib !== undefined) return cachedQrLib
  try {
    const req = createRequire(import.meta.url)
    cachedQrLib = req('qrcode')
    return cachedQrLib
  } catch {}
  for (const p of dshProfileDirs()) {
    const hit = findPackageEntryInProfile(p.dir, 'qrcode', ['lib/index.js', 'index.js'])
    if (hit) {
      try {
        const req = createRequire(import.meta.url)
        cachedQrLib = req(hit)
        return cachedQrLib
      } catch {}
    }
  }
  cachedQrLib = null
  return null
}

export async function renderQrSvgDataUrl(url) {
  const qr = loadQrcodeLib()
  if (qr && typeof qr.toString === 'function') {
    try {
      const svg = await qr.toString(url, { type: 'svg', margin: 1, width: 240 })
      if (typeof svg === 'string' && svg.trimStart().startsWith('<svg')) {
        return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
      }
    } catch {}
  }
  try {
    return renderLiteQrSvgDataUrl(url)
  } catch {
    return ''
  }
}

/**
 * 零依赖轻量解析 cordis.patch.yml 中的 im-qqbot 条目（避免未安装 yaml 包时报错）。
 */
export function parseImQqbotFromPatchYaml(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/)
  let inImQqbot = false
  let entryIndent = -1
  let inConfig = false
  let configIndent = -1
  let inAccess = false
  let accessIndent = -1
  let activeList = null
  let disabled = false

  const out = {
    appId: '',
    appSecret: '',
    c2cMode: '',
    c2cAllow: [],
    groupMode: '',
    groupAllow: [],
    disabled: false,
  }

  const unquote = (s) => {
    const t = String(s || '').trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1)
    }
    return t.replace(/\s+#.*$/, '').trim()
  }

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.match(/^\s*/)[0].length
    const trimmed = rawLine.trim()

    // 顶层列表项切换
    if (trimmed.startsWith('- ')) {
      if (inImQqbot && indent <= entryIndent) {
        break
      }
      const afterDash = trimmed.slice(2).trim()
      if (/^id:\s*['"]?im-qqbot['"]?(\s|$)/.test(afterDash)) {
        inImQqbot = true
        entryIndent = indent
        inConfig = false
        inAccess = false
        activeList = null
        continue
      }
      if (inAccess && activeList && indent > accessIndent) {
        const val = unquote(afterDash)
        if (val) out[activeList].push(val)
        continue
      }
    }

    if (!inImQqbot) continue
    if (indent <= entryIndent && !trimmed.startsWith('-')) {
      break
    }

    if (/^disabled:\s*true\b/i.test(trimmed) && indent <= (configIndent > 0 ? configIndent : entryIndent + 4)) {
      disabled = true
      out.disabled = true
    }

    if (/^config:\s*$/.test(trimmed)) {
      inConfig = true
      configIndent = indent
      inAccess = false
      activeList = null
      continue
    }

    if (!inConfig) continue
    if (indent <= configIndent) {
      inConfig = false
      inAccess = false
      activeList = null
      continue
    }

    if (inAccess && indent <= accessIndent) {
      inAccess = false
      activeList = null
    }

    if (/^access:\s*$/.test(trimmed)) {
      inAccess = true
      accessIndent = indent
      activeList = null
      continue
    }

    const kv = trimmed.match(/^([a-zA-Z0-9_]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, rawVal] = kv

    if (!inAccess) {
      const val = unquote(rawVal)
      if (key === 'appId' && val && val !== '__FROM_ENV__' && !val.startsWith('process.env')) out.appId = val
      if (key === 'appSecret' && val && val !== '__FROM_ENV__' && !val.startsWith('process.env')) out.appSecret = val
    } else {
      if (key === 'c2cAllow' || key === 'groupAllow') {
        const inline = rawVal.trim()
        if (inline.startsWith('[') && inline.endsWith(']')) {
          const items = inline.slice(1, -1).split(',').map(unquote).filter(Boolean)
          out[key].push(...items)
          activeList = null
        } else {
          activeList = key
        }
      } else {
        activeList = null
        const val = unquote(rawVal)
        if (key === 'c2cMode') out.c2cMode = val
        if (key === 'groupMode') out.groupMode = val
      }
    }
  }

  if (!out.appId && !out.appSecret) return null
  out.disabled = disabled
  return out
}

/**
 * 扫描 ~/.dsh/profiles/* 寻找 @tencent-connect/dsh-qqbot 已绑定的凭据。
 */
export function discoverDshQqbotCredentials() {
  for (const p of dshProfileDirs()) {
    const patchPath = join(p.dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    try {
      const parsed = parseImQqbotFromPatchYaml(readFileSync(patchPath, 'utf8'))
      if (parsed && parsed.appId && parsed.appSecret) {
        const pluginInstalled = Boolean(
          findPackageEntryInProfile(p.dir, '@tencent-connect/dsh-qqbot', ['package.json']),
        )
        return {
          ...parsed,
          profileName: p.name,
          patchPath,
          coexistingActivePlugin: pluginInstalled && !parsed.disabled,
        }
      }
    } catch {}
  }
  return null
}
