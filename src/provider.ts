/**
 * `ZhihuSearchProvider`: a `WebSearchProvider` backed by Zhihu OpenAPI
 * `GET /api/v1/content/zhihu_search`. Maps `Url`/`Title`/`ContentText`/`EditTime`
 * into the seam's normalized `WebSearchResult`.
 * @module @wangshaodan/web-search-zhihu-insite/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ZhihuError, ZhihuSearchItem, ZhihuSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const ZHIHU_PROVIDER_ID = 'zhihu-insite-search'

/** Default OpenAPI origin; `/api/v1/content/zhihu_search` is appended. */
export const ZHIHU_DEFAULT_BASE_URL = 'https://developer.zhihu.com'

/** Default result count when a request carries no `maxResults`. Matches the API default. */
export const ZHIHU_DEFAULT_NUM_RESULTS = 10

/** Zhihu in-site `Count` upper bound (skill script clamp, free-tier API cap). */
export const ZHIHU_MAX_NUM_RESULTS = 10

/** Default request timeout in milliseconds. */
export const ZHIHU_DEFAULT_TIMEOUT_MS = 30_000

/** Path appended to {@link ZHIHU_DEFAULT_BASE_URL} when no full endpoint is set. */
export const ZHIHU_SEARCH_PATH = '/api/v1/content/zhihu_search'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = '@wangshaodan/web-search-zhihu-insite/0.1.0'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ZhihuSearchProviderOptions {
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
  /** Default result count when a request carries no `maxResults`. */
  numResults: number
  /** Abort the HTTP request after this many milliseconds. */
  timeoutMs: number
}

/**
 * Build the request URL. An explicit `endpoint` wins; otherwise `baseURL` + path.
 */
export function resolveSearchUrl(options: Pick<ZhihuSearchProviderOptions, 'baseURL' | 'endpoint'>): string {
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
export function mapZhihuItem(item: ZhihuSearchItem): WebSearchSource | undefined {
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
export function mapZhihuResponse(response: ZhihuSearchResponse): WebSearchResult {
  const items = response.Data?.Items ?? []
  const sources = items
    .map(mapZhihuItem)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** The Zhihu in-site search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ZhihuSearchProvider implements WebSearchProvider {
  readonly id = ZHIHU_PROVIDER_ID

  constructor(private readonly options: ZhihuSearchProviderOptions) {}

  available(): boolean {
    return ((this.options.apiKey?.length ?? 0) > 0 || this.options.resolveApiKey !== undefined)
      && URL.canParse(resolveSearchUrl(this.options))
      && isPositiveInteger(this.options.numResults)
      && isPositiveInteger(this.options.timeoutMs)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await this.loadApiKey(signal)
    const count = clampCount(request.maxResults ?? this.options.numResults)
    const endpoint = resolveSearchUrl(this.options)
    const url = new URL(endpoint)
    url.searchParams.set('Query', request.query)
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
      throw new WebError(`Zhihu returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (payload.Code !== 0) {
      const detail = payload.Message?.trim()
      throw new WebError(
        detail !== undefined && detail.length > 0
          ? detail
          : `Zhihu API error (Code ${String(payload.Code)})`,
        'WEB_PROVIDER_ERROR',
      )
    }
    if (payload.Data != null && payload.Data.Items !== undefined && !Array.isArray(payload.Data.Items)) {
      throw new WebError('Zhihu returned an unprocessable response body: Data.Items is not an array', 'WEB_PROVIDER_ERROR')
    }
    return mapZhihuResponse(payload)
  }

  private async loadApiKey(signal?: AbortSignal): Promise<string> {
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) return this.options.apiKey
    let resolved: string | undefined
    try {
      resolved = await this.options.resolveApiKey?.()
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw abortError(signal)
      throw new WebError(`Zhihu search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (signal?.aborted === true) throw abortError(signal)
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = this.options.apiKeyEnv ?? 'ZHIHU_ACCESS_SECRET'
    throw new WebError(
      `Zhihu search has no access secret for "${ref}"; export ${ref}, store it in $DSH_HOME/.credentials.yaml, or set a literal "apiKey" in the web-search-zhihu-insite config`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

function mapFetchFailure(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): WebError {
  if (isAbortError(error)) {
    if (signal?.aborted) return abortError(signal)
    return new WebError(`Zhihu search timed out after ${String(timeoutMs)}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return new WebError(`Zhihu search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

async function mapHttpError(response: Response, signal: AbortSignal | undefined): Promise<WebError> {
  const status = response.status
  let message = `Zhihu API error (HTTP ${String(status)})`
  try {
    const parsed = await response.json() as ZhihuError
    const detail = parsed.Message ?? parsed.message ?? parsed.error
    if (detail !== undefined && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError(signal)
  }
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

function abortError(signal: AbortSignal | undefined): WebError {
  return new WebError('Zhihu search aborted', 'WEB_ABORTED', { cause: signal?.reason })
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
