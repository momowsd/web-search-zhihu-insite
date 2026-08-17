/**
 * The model-facing `zhihu_search` tool: search Zhihu in-site content.
 * Execution goes through {@link ZhihuSearchClient} — this module owns the
 * schema, argument validation, result-count bound, formatting, and presentation.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult, WebSearchResultView, WebSource } from '@deepseek-ai/dsh-tools'
import type { ZhihuSearchClient } from './client.ts'
import { ZHIHU_SEARCH_TOOL_NAME, clampCount } from './client.ts'
import type { ZhihuSearchResult, ZhihuSearchSource } from './types.ts'

/**
 * Default upper bound on returned sources (the `searchMaxResults` config).
 * Owned by the consumer, not the model. Capped further to Zhihu's Count max of 10.
 */
export const ZHIHU_SEARCH_MAX_RESULTS = 8

/**
 * Validate value constraints the schema DSL can't express: a non-blank `query`.
 */
export function parseSearchArgs(args: { query: string }): { query: string } {
  if (args.query.trim().length === 0) throw new Error('query must be a non-empty string')
  return { query: args.query }
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Format a search result as one model-facing text block.
 */
export function formatSearchOutput(result: ZhihuSearchResult): string {
  const parts: string[] = []

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/** Pending-call presentation: a search card titled by the query. */
export function presentSearchCall(args: { query: string }): GenericCallView {
  return { card: 'generic', title: args.query, kind: 'search', rawInput: args.query }
}

/** Replayable `tool/result` meta: structured sources plus truncation. */
export interface ZhihuSearchMeta {
  sources: WebSource[]
  truncated: boolean
}

function projectSource(source: ZhihuSearchSource): WebSource {
  return {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
  }
}

export function searchMetaFromValue(value: ZhihuSearchResult): JsonValue {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
  } as unknown as JsonValue
}

function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

export function searchMetaFromResult(meta: unknown): ZhihuSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  return { sources, truncated }
}

export function presentSearchResult(args: { query: string }, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.query,
    sources: meta.sources,
    truncated: meta.truncated,
  }
}

/**
 * Register the `zhihu_search` tool and its system-prompt guidance.
 */
export function applyZhihuSearchTool(
  ctx: Context,
  client: ZhihuSearchClient,
  maxResults: number,
  timeoutMs: number,
): void {
  const bound = clampCount(maxResults)
  ctx.systemPrompt.section({
    name: 'tool:zhihu_search',
    order: 111,
    text: 'Use the zhihu_search tool to search Zhihu (zhihu.com) for questions, answers, and articles. It returns a list of source URLs with titles and snippets. This is Zhihu in-site content, not a general web search — use web_search for the open web. Cite the relevant URLs as markdown links.',
  })

  ctx.tools.register(defineTool({
    name: ZHIHU_SEARCH_TOOL_NAME,
    description: 'Search Zhihu (zhihu.com) for questions, answers, and articles. Returns a list of source URLs with titles and snippets. Use web_search for the open web.',
    parameters: {
      query: { type: 'string', required: true, description: 'The Zhihu in-site search query.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseSearchArgs(args)
      const result = await client.search(input.query, bound, exec.signal)
      return {
        sources: result.sources.map(projectSource),
        truncated: result.truncated,
      }
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))
}
