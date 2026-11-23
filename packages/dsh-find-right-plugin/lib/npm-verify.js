/**
 * npm 目标验证：只对「最终要推给 agent 的少数几行」逐条查 npm latest manifest。
 *
 * 目的不是再排一次序，而是回答三个问题：
 *   1. 这个安装目标现在真的能装到吗（registry 上有这个包）？
 *   2. 它真的是 DSH 插件吗（manifest 含 dsh 字段 / 关键字）？
 *   3. 它声明的仓库和我们归并出的仓库是不是同一个（防冒名/防错配）？
 * 主推候选若验证失败，决策层会换人——「找到对的那个」不能推一个装不上的包。
 *
 * 严格预算：只对少量行查，并发受限，整体有硬上限；失败一律「未知」而非
 * 「否」，避免网络抖动把好插件误杀。
 *
 * @module dsh-find-right-plugin/npm-verify
 */

import { fetchJson } from './cache.js'
import { repoFromUrl, repoFromSpec } from './merge.js'

const TIMEOUT_MS = 4_000
const CONCURRENCY = 5
const TTL_MS = 10 * 60_000

/** 从仓库名猜一个无 scope 的 npm 包名（仅在源没给 npm 名时用）。 */
export function guessNpmName (item) {
  if (item?.npm) return item.npm
  const name = item?.name || (item?.repo ? item.repo.split('/')[1] : null)
  if (!name) return null
  const clean = String(name).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return clean || null
}

function manifestIsPlugin (manifest) {
  if (!manifest || typeof manifest !== 'object') return false
  if (manifest.dsh) return true
  const kw = Array.isArray(manifest.keywords) ? manifest.keywords : []
  return kw.some((k) => /^(dsh-plugin|dsh-plugins|deepseek-harness|dsh-bundle)$/i.test(String(k)))
}

async function verifyOne (item) {
  const name = guessNpmName(item)
  if (!name) return { verified: false, reason: '无 npm 目标' }
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`
  const res = await fetchJson(url, { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS })
  if (!res.ok) return { verified: null, reason: res.error } // 网络问题 ≠ 不是插件
  const manifest = res.value
  const isPlugin = manifestIsPlugin(manifest)
  const declaredRepo = repoFromUrl(manifest?.repository?.url || manifest?.repository) ||
    repoFromSpec(manifest?.repository?.url || manifest?.repository) ||
    repoFromUrl(manifest?.homepage)
  const repoMatch = !item?.repo || !declaredRepo || declaredRepo.toLowerCase() === String(item.repo).toLowerCase()
  return {
    verified: isPlugin && repoMatch,
    isPlugin,
    repoMatch,
    version: manifest?.version || null,
    ...(isPlugin && !repoMatch && { reason: '仓库不匹配' }),
    ...(!isPlugin && { reason: 'manifest 未声明 dsh' }),
  }
}

/** 并发受限地验证多行；返回按输入顺序对齐的结果数组。 */
export async function verifyRows (rows, budgetMs = 6_000) {
  const results = new Array(rows.length)
  let cursor = 0
  let deadlineHit = false
  const deadline = Date.now() + budgetMs

  async function worker () {
    while (true) {
      if (Date.now() > deadline) { deadlineHit = true; return }
      const i = cursor++
      if (i >= rows.length) return
      try {
        results[i] = await verifyOne(rows[i].item)
      } catch (e) {
        results[i] = { verified: null, reason: String(e?.message || e) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))
  for (let i = 0; i < rows.length; i++) {
    if (results[i] === undefined) results[i] = { verified: null, reason: deadlineHit ? '验证超时' : '未验证' }
  }
  return results
}
