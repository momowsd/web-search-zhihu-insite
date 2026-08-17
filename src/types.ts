/**
 * Wire types for Zhihu OpenAPI `GET /api/v1/content/zhihu_search`, plus the
 * model-facing search result the `zhihu_search` tool returns.
 * @module @wangshaodan/web-search-zhihu-insite/types
 */

/** One citeable source in a `zhihu_search` result. */
export interface ZhihuSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** Canonical `zhihu_search` output value. */
export interface ZhihuSearchResult {
  sources: ZhihuSearchSource[]
  truncated: boolean
}

/** One entry of Zhihu's `Data.Items[]`. Unused fields are ignored at map time. */
export interface ZhihuSearchItem {
  Title?: string | null
  ContentType?: string | null
  ContentID?: string | null
  ContentText?: string | null
  Url?: string | null
  CommentCount?: number
  VoteUpCount?: number
  AuthorName?: string | null
  AuthorAvatar?: string | null
  EditTime?: number | null
  AuthorityLevel?: string | null
}

/** Zhihu's search response envelope. */
export interface ZhihuSearchResponse {
  Code?: number
  Message?: string | null
  Data?: {
    HasMore?: boolean
    SearchHashId?: string | null
    EmptyReason?: string | null
    Items?: ZhihuSearchItem[]
  } | null
}

/** Zhihu error envelope (best-effort; HTTP and business failures share this shape). */
export interface ZhihuError {
  Code?: number
  Message?: string | null
  error?: string
  message?: string
}
