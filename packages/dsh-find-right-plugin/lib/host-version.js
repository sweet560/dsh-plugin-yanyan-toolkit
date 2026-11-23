/**
 * 宿主版本检测与兼容性比对（尽力而为，检测不到就返回 null，绝不臆测）。
 *
 * 目录里的 dsh.works / catalog 条目常带 verifiedAgainst / engines.dsh，
 * 它能帮 agent 避开「为 0.1.x 写、装到 0.2.x 就崩」的插件。这是「可信度」
 * 的一个软信号：跨版本线打 ⚠，但不淘汰（很多插件其实向前兼容）。
 *
 * @module dsh-find-right-plugin/host-version
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

function tryReadJson (file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 从多个候选位置读宿主 dsh 版本；DSH_HOST_VERSION 可覆盖（测试用）。 */
export function detectHostVersion () {
  if (process.env.DSH_HOST_VERSION) return String(process.env.DSH_HOST_VERSION)
  const roots = []
  if (process.resourcesPath) {
    roots.push(
      join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'package.json'),
      join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'),
      join(process.resourcesPath, 'app', 'package.json'),
      join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )
  }
  // 从入口脚本上溯若干层找 package.json（dsh CLI 场景）
  let dir = process.argv?.[1] ? dirname(process.argv[1]) : null
  for (let i = 0; dir && i < 8; i++) {
    roots.push(join(dir, 'package.json'))
    dir = dirname(dir)
  }
  // 只认宿主运行时自身的确切包名，绝不用 /dsh/i 这类模糊匹配：
  // 否则从 process.argv[1] 上溯会读到本插件自己的 package.json
  //（name=dsh-find-right-plugin, version=1.0.0），把「1.0.0」误报成宿主版本
  //（真实网络冒烟里就出现过「当前 DSH 版本：1.0.0」）。检测不到就返回 null，
  // 如实呈现为「未检测到」，好过臆测一个假版本。
  const HOST_PKG_NAMES = new Set([
    '@deepseek-ai/dsh', 'dsh',
    '@deepseek-ai/deepseek-harness', 'deepseek-harness',
  ])
  for (const file of roots) {
    const pkg = tryReadJson(file)
    if (pkg && HOST_PKG_NAMES.has(pkg.name) && pkg.version) return String(pkg.version)
    const runtime = tryReadJson(join(dirname(file), 'runtime', 'primary-runtime', 'runtime.json'))
    if (runtime?.desktopVersion) return String(runtime.desktopVersion)
  }
  return null
}

function parseVersion (v) {
  // 保留 prerelease（如 0.2.0-rc.9）：0.x 阶段 rc 号不同也可能是破坏性变更，
  // 不能把 0.2.0-rc.9 与 0.2.0-rc.2 当成「完全匹配」。
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' } : null
}

/**
 * 0.x 阶段以 major.minor 为「版本线」。
 * 返回 match / same-line / cross / unknown。
 * 版本范围（含 < > = | 空格 ^ ~ *）无法可靠比对，如实返回 unknown ——
 * 软信号宁可未知，也不臆测一个假的「兼容」。
 */
export function compareCompat (hostVersion, compatVersion) {
  if (!hostVersion || !compatVersion) return 'unknown'
  if (/[<>=|\s^~*]/.test(String(compatVersion))) return 'unknown'
  const h = parseVersion(hostVersion)
  const c = parseVersion(compatVersion)
  if (!h || !c) return 'unknown'
  if (h.major === c.major && h.minor === c.minor && h.patch === c.patch && h.pre === c.pre) return 'match'
  if (h.major === c.major && h.minor === c.minor) return 'same-line'
  return 'cross'
}

/** 给一行标注 compat 结论（不改原对象，返回新字段）。 */
export function compatNote (hostVersion, item) {
  const against = item?.compat?.version || null
  const level = compareCompat(hostVersion, against)
  return { against, level }
}
