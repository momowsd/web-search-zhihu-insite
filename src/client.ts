/**
 * HTTP client for Zhihu OpenAPI `GET /api/v1/content/zhihu_search`.
 * Maps `Url`/`Title`/`ContentText`/`EditTime` into the tool's `ZhihuSearchResult`.
 * @module @wangshaodan/web-search-zhihu-insite/client
 */

import type { ZhihuError, ZhihuSearchItem, ZhihuSearchResponse, ZhihuSearchResult, ZhihuSearchSource } from './types.ts'

/** Default OpenAPI origin; `/api/v1/content/zhihu_search` is appended. */
export const ZHIHU_DEFAULT_BASE_URL = 'https://developer.zhihu.com'

/** Default result count when config omits `searchMaxResults`. Matches the API default. */
export const ZHIHU_DEFAULT_NUM_RESULTS = 10

/** Zhihu in-site `Count` upper bound (skill script clamp, free-tier API cap). */
export const ZHIHU_MAX_NUM_RESULTS = 10

/** Default request timeout in milliseconds. */
export const ZHIHU_DEFAULT_TIMEOUT_MS = 30_000

/** Path appended to {@link ZHIHU_DEFAULT_BASE_URL} when no full endpoint is set. */
export const ZHIHU_SEARCH_PATH = '/api/v1/content/zhihu_search'

/** Model-facing tool name registered by this plugin. */
export const ZHIHU_SEARCH_TOOL_NAME = 'zhihu_search'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = '@wangshaodan/web-search-zhihu-insite/0.2.0'

export type ZhihuSearchErrorCode =
  | 'ZHIHU_SEARCH_CREDENTIAL_MISSING'
  | 'ZHIHU_SEARCH_ERROR'
  | 'ZHIHU_SEARCH_ABORTED'

/** Typed failure thrown by {@link ZhihuSearchClient}; `ToolRuntime` surfaces `message` to the model. */
export class ZhihuSearchError extends Error {
  readonly code: ZhihuSearchErrorCode

  constructor(message: string, code: ZhihuSearchErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZhihuSearchError'
    this.code = code
  }
}

/** Resolved client options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ZhihuSearchClientOptions {
  /**
   * Literal Bearer token. Prefer {@link resolveApiKey} so `$DSH_HOME/.credentials.yaml`
   * and the launching environment can supply the value per search.
   */
  apiKey?: string
  /**
   * Resolve the Bearer token for one search. Used when {@link apiKey} is empty:
   * `ctx.credentials` (including `$DSH_HOME/.credentials.yaml`) then the process env.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference name, used in the missing-key error. Defaults to `ZHIHU_ACCESS_SECRET`. */
  apiKeyEnv?: string
  /** OpenAPI origin; {@link ZHIHU_SEARCH_PATH} is appended when `endpoint` is omitted. */
  baseURL: string
  /** Full search URL. When set, it wins over `baseURL` + path. */
  endpoint?: string
  /** Abort the HTTP request after this many milliseconds. */
  timeoutMs: number
}

/**
 * Build the request URL. An explicit `endpoint` wins; otherwise `baseURL` + path.
 */
export function resolveSearchUrl(options: Pick<ZhihuSearchClientOptions, 'baseURL' | 'endpoint'>): string {
  if (options.endpoint !== undefined && options.endpoint.length > 0) return options.endpoint
  return `${options.baseURL.replace(/\/+$/, '')}${ZHIHU_SEARCH_PATH}`
}

/**
 * Clamp a requested count to Zhihu in-site `Count` range `[1, 10]`.
 */
export function clampCount(value: number): number {
  if (!Number.isFinite(value)) return ZHIHU_DEFAULT_NUM_RESULTS
  return Math.max(1, Math.min(ZHIHU_MAX_NUM_RESULTS, Math.trunc(value)))
}

/**
 * Strip Zhihu highlight markup (`<em>…</em>`) from a snippet.
 */
export function stripHighlightTags(text: string): string {
  return text.replace(/<\/?em>/gi, '').trim()
}

/**
 * Convert a Zhihu unix-seconds `EditTime` to ISO-8601, or `undefined` when unusable.
 */
export function editTimeToIso(editTime: number | null | undefined): string | undefined {
  if (editTime == null || !Number.isFinite(editTime) || editTime <= 0) return undefined
  const date = new Date(editTime * 1000)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

/**
 * Map one Zhihu item to a normalized source, or `undefined` when it has no URL.
 */
export function mapZhihuItem(item: ZhihuSearchItem): ZhihuSearchSource | undefined {
  const url = item.Url?.trim()
  if (url === undefined || url.length === 0) return undefined
  const title = item.Title?.trim()
  const snippet = item.ContentText != null ? stripHighlightTags(item.ContentText) : ''
  const publishedAt = editTimeToIso(item.EditTime)
  return {
    url,
    ...title !== undefined && title.length > 0 ? { title } : {},
    ...snippet.length > 0 ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a Zhihu success envelope to a normalized search result.
 * Business `Code !== 0` and a missing/non-array `Items` are caller errors, not this mapper.
 */
export function mapZhihuResponse(response: ZhihuSearchResponse): ZhihuSearchResult {
  const items = response.Data?.Items ?? []
  const sources = items
    .map(mapZhihuItem)
    .filter((source): source is ZhihuSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** HTTP client for one Zhihu in-site search. Redirects fail as `ZHIHU_SEARCH_ERROR`. */
export class ZhihuSearchClient {
  constructor(private readonly options: ZhihuSearchClientOptions) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<ZhihuSearchResult> {
    const apiKey = await this.loadApiKey(signal)
    const count = clampCount(maxResults)
    const endpoint = resolveSearchUrl(this.options)
    const url = new URL(endpoint)
    url.searchParams.set('Query', query)
    url.searchParams.set('Count', String(count))

    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
          'content-type': 'application/json',
          'x-request-timestamp': String(Math.floor(Date.now() / 1000)),
          'user-agent': USER_AGENT,
        },
        signal: combined,
      })
    } catch (error: unknown) {
      throw mapFetchFailure(error, signal, this.options.timeoutMs)
    }

    if (!response.ok) {
      throw await mapHttpError(response, signal)
    }

    let payload: ZhihuSearchResponse
    try {
      payload = await response.json() as ZhihuSearchResponse
    } catch (error: unknown) {
      if (isAbortError(error)) throw abortError(signal)
      throw new ZhihuSearchError(`Zhihu returned an unprocessable response body: ${String(error)}`, 'ZHIHU_SEARCH_ERROR', { cause: error })
    }

    if (payload.Code !== 0) {
      const detail = payload.Message?.trim()
      throw new ZhihuSearchError(
        detail !== undefined && detail.length > 0
          ? detail
          : `Zhihu API error (Code ${String(payload.Code)})`,
        'ZHIHU_SEARCH_ERROR',
      )
    }
    if (payload.Data != null && payload.Data.Items !== undefined && !Array.isArray(payload.Data.Items)) {
      throw new ZhihuSearchError('Zhihu returned an unprocessable response body: Data.Items is not an array', 'ZHIHU_SEARCH_ERROR')
    }

    const mapped = mapZhihuResponse(payload)
    if (mapped.sources.length <= count) return mapped
    return { sources: mapped.sources.slice(0, count), truncated: true }
  }

  private async loadApiKey(signal?: AbortSignal): Promise<string> {
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) return this.options.apiKey
    let resolved: string | undefined
    try {
      resolved = await this.options.resolveApiKey?.()
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw abortError(signal)
      throw new ZhihuSearchError(`Zhihu search credential resolution failed: ${String(error)}`, 'ZHIHU_SEARCH_ERROR', { cause: error })
    }
    if (signal?.aborted === true) throw abortError(signal)
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = this.options.apiKeyEnv ?? 'ZHIHU_ACCESS_SECRET'
    throw new ZhihuSearchError(
      `Zhihu search has no access secret for "${ref}"; export ${ref}, store it in $DSH_HOME/.credentials.yaml, or set a literal "apiKey" in the web-search-zhihu-insite config`,
      'ZHIHU_SEARCH_CREDENTIAL_MISSING',
    )
  }
}

function mapFetchFailure(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): ZhihuSearchError {
  if (isAbortError(error)) {
    if (signal?.aborted) return abortError(signal)
    return new ZhihuSearchError(`Zhihu search timed out after ${String(timeoutMs)}ms`, 'ZHIHU_SEARCH_ERROR', { cause: error })
  }
  return new ZhihuSearchError(`Zhihu search request failed: ${String(error)}`, 'ZHIHU_SEARCH_ERROR', { cause: error })
}

async function mapHttpError(response: Response, signal: AbortSignal | undefined): Promise<ZhihuSearchError> {
  const status = response.status
  let message = `Zhihu API error (HTTP ${String(status)})`
  try {
    const parsed = await response.json() as ZhihuError
    const detail = parsed.Message ?? parsed.message ?? parsed.error
    if (detail !== undefined && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError(signal)
  }
  return new ZhihuSearchError(message, 'ZHIHU_SEARCH_ERROR')
}

function abortError(signal: AbortSignal | undefined): ZhihuSearchError {
  return new ZhihuSearchError('Zhihu search aborted', 'ZHIHU_SEARCH_ABORTED', { cause: signal?.reason })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
