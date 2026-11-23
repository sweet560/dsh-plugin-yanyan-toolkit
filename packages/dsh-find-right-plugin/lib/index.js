/**
 * dsh-find-right-plugin — 帮 DeepSeek Harness 找到「对的那个」插件。
 *
 * 只注册一个面向模型的工具 `find_dsh_plugins`：
 *   搜遍整个 DSH 插件生态（社区精选目录 + GitHub 实时 + npm 实时），
 *   按 相关度 × 可信度 × 新鲜度 × 热度 四维乘积排序，
 *   然后由决策层明确给出「最该装的是这一个」+ 理由 + 少量备选，
 *   而不是甩给 agent 一堆榜单。
 *
 * 设计边界（刻意为之）：
 *   - 只读：绝不安装 / 启停 / 改 profile / 写 cordis.patch.yml；
 *   - 不自带离线快照（把陈旧数据冒充实时比没有更糟）；
 *   - 不自己调模型（调用方 agent 就是模型）；
 *   - 不感知任何桌面外壳，任何 DSH 实例都能用；
 *   - 单源挂掉自动降级并在结果里如实标注，绝不把「源挂了」伪装成「没有」。
 *
 * 真正的检索管线在 search.js（不依赖宿主模块，可离线端到端单测）。
 *
 * @module dsh-find-right-plugin
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { prewarmCatalogs } from './sources.js'
import { runSearch } from './search.js'
import { renderText } from './render.js'

export const name = 'dsh-find-right-plugin'
export const inject = ['tools']

const PREWARM_DELAY_MS = 5_000

export function apply (ctx) {
  const tool = defineTool({
    name: 'find_dsh_plugins',
    description: [
      '在整个 DSH 插件生态里查找「最该装的那一个」插件，而不是列一堆。',
      '聚合社区精选目录 + GitHub 实时 + npm 实时，按 相关度 × 可信度 × 新鲜度 × 热度 四维排序，',
      '再给出明确的主推（含理由与安装目标）+ 少量备选。单源不可用会标注、不影响其它源。',
      '适合在用户想装/找某个功能的插件时调用。只读，不会替你安装。',
    ].join(''),
    parameters: {
      query: {
        type: 'string', required: true,
        description: '想找什么插件，用功能词描述（中英文均可），如「跨会话项目记忆」「wechat 通知」「用量统计」。',
      },
      limit: {
        type: 'number',
        description: '返回条目总数上限（1–8，默认 4）：主推 1 个 + 最多 3 个备选。调大只会增加备选，不会铺开成榜单。',
      },
      includeUnvetted: {
        type: 'boolean',
        description: '是否放出「仅被 GitHub topic 收录、零 star」的未验证下限条目（默认 false，隐藏但计数）。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute: async (args, exec) => runSearch(args, exec, ctx),
    // 框架不会强制这个上限，实现内部已用「每源硬超时 + 验证预算」自我约束。
    timeoutMs: 45_000,
  })

  ctx.tools.register(tool)

  // 后台预热大目录：让首次真实查询大概率命中缓存、秒回。fire-and-forget。
  if (process.env.DSH_FIND_RIGHT_PLUGIN_NO_PREWARM !== '1') {
    const timer = setTimeout(() => { prewarmCatalogs().catch(() => {}) }, PREWARM_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
}
