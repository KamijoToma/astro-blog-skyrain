import type {
  D1Database,
  PagesFunction,
  Response as WorkerResponse
} from '@cloudflare/workers-types'

export interface Env {
  BLOG_DB: D1Database
  TURNSTILE_SECRET_KEY?: string
  COMMENT_HASH_SALT?: string
  COMMENT_STATUS_DEFAULT?: string
  COMMENT_RATE_LIMIT_WINDOW?: string
  COMMENT_RATE_LIMIT_MAX?: string
}

type CommentStatus = 'pending' | 'approved' | 'spam' | 'deleted'

export interface Comment {
  id: number
  slug: string
  path: string
  parent_id: number | null
  author_name: string
  author_email_hash?: string | null
  author_url: string | null
  content: string
  status: CommentStatus
  created_at: string
}

interface CreateCommentRequest {
  slug?: unknown
  path?: unknown
  parent_id?: unknown
  author_name?: unknown
  author_email?: unknown
  author_url?: unknown
  content?: unknown
  turnstile_token?: unknown
}

interface CountResult {
  count: number | string
}

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=UTF-8'
}

const DEFAULT_HASH_SALT = 'default-salt'
const DEFAULT_RATE_LIMIT_WINDOW = 60
const DEFAULT_RATE_LIMIT_MAX = 3
const DEFAULT_COMMENT_STATUS: CommentStatus = 'pending'

function json(data: unknown, init?: ResponseInit): WorkerResponse {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init?.headers
    }
  }) as unknown as WorkerResponse
}

function isCommentStatus(value: string | undefined): value is CommentStatus {
  return value === 'pending' || value === 'approved' || value === 'spam' || value === 'deleted'
}

function getCommentStatus(env: Env): CommentStatus {
  return isCommentStatus(env.COMMENT_STATUS_DEFAULT)
    ? env.COMMENT_STATUS_DEFAULT
    : DEFAULT_COMMENT_STATUS
}

function getPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getHashSalt(env: Env): string {
  return env.COMMENT_HASH_SALT?.trim() || DEFAULT_HASH_SALT
}

function getOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : undefined
}

function getRequiredString(value: unknown, maxLength: number): string | null {
  return getOptionalString(value, maxLength) ?? null
}

function getOptionalParentId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }

  return Number.NaN
}

function normalizeAuthorUrl(value: unknown): string | null {
  const url = getOptionalString(value, 255)
  if (!url) {
    return null
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    return parsed.toString().slice(0, 255)
  } catch {
    return null
  }
}

// Hash IP for privacy
async function hashIP(ip: string, salt: string): Promise<string> {
  const text = new TextEncoder().encode(ip + salt)
  const hashBuffer = await crypto.subtle.digest('SHA-256', text)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Verify Turnstile token
async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  const formData = new FormData()
  formData.append('secret', secret)
  formData.append('response', token)

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData
  })

  const outcome = (await result.json()) as { success?: boolean }
  return outcome.success === true
}

// GET /api/comments?slug=xxx - List approved comments
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const slug = url.searchParams.get('slug')

  if (!slug) {
    return json({ error: 'Missing slug parameter' }, { status: 400 })
  }

  try {
    const { results } = await env.BLOG_DB.prepare(
      `SELECT id, slug, path, parent_id, author_name, author_url, content, created_at
       FROM comments
       WHERE slug = ? AND status = 'approved'
       ORDER BY parent_id IS NOT NULL, parent_id ASC, created_at ASC`
    )
      .bind(slug)
      .all<Comment>()

    return json({ comments: results || [] })
  } catch (error) {
    console.error('Database error:', error)
    return json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/comments - Create new comment
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: CreateCommentRequest

  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const slug = getRequiredString(body.slug, 255)
  const path = getRequiredString(body.path, 512)
  const authorName = getRequiredString(body.author_name, 50)
  const content = getRequiredString(body.content, 5000)
  const authorEmail = getOptionalString(body.author_email, 100)
  const authorUrlInput = getOptionalString(body.author_url, 255)
  const authorUrl = normalizeAuthorUrl(body.author_url)
  const turnstileToken = getOptionalString(body.turnstile_token, 2048)
  const parentId = getOptionalParentId(body.parent_id)

  if (!slug || !path || !authorName || !content) {
    return json({ error: 'Missing required fields' }, { status: 400 })
  }

  if (Number.isNaN(parentId)) {
    return json({ error: 'Invalid parent comment ID' }, { status: 400 })
  }

  if (authorUrlInput && !authorUrl) {
    return json({ error: 'Invalid author URL' }, { status: 400 })
  }

  // Verify Turnstile if configured
  let turnstileOk = 0
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return json({ error: 'Turnstile token is required' }, { status: 400 })
    }

    const verified = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY)
    if (!verified) {
      return json({ error: 'Turnstile verification failed' }, { status: 403 })
    }
    turnstileOk = 1
  }

  // Get client IP and hash it
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
  const hashSalt = getHashSalt(env)
  const ipHash = await hashIP(clientIP, hashSalt)

  try {
    const rateWindow = getPositiveInt(env.COMMENT_RATE_LIMIT_WINDOW, DEFAULT_RATE_LIMIT_WINDOW)
    const rateLimit = getPositiveInt(env.COMMENT_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX)
    const status = getCommentStatus(env)

    const { results: rateResults } = await env.BLOG_DB.prepare(
      `SELECT COUNT(*) AS count FROM comment_rate_limits
       WHERE ip_hash = ? AND path = ? AND created_at > datetime('now', ?)`
    )
      .bind(ipHash, path, `-${rateWindow} seconds`)
      .all<CountResult>()

    const recentRequests = Number(rateResults?.[0]?.count ?? 0)

    if (recentRequests >= rateLimit) {
      return json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    // Insert rate limit record
    await env.BLOG_DB.prepare(`INSERT INTO comment_rate_limits (ip_hash, path) VALUES (?, ?)`)
      .bind(ipHash, path)
      .run()

    // Insert comment
    const { meta } = await env.BLOG_DB.prepare(
      `INSERT INTO comments
       (slug, path, parent_id, author_name, author_email_hash, author_url, content, status, ip_hash, turnstile_ok, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        path,
        parentId,
        authorName,
        authorEmail ? await hashIP(authorEmail, hashSalt) : null,
        authorUrl,
        content,
        status,
        ipHash,
        turnstileOk,
        request.headers.get('User-Agent')?.slice(0, 255) || null
      )
      .run()

    return json({
      success: true,
      id: meta.last_row_id,
      message:
        status === 'approved' ? 'Comment submitted' : 'Comment submitted and pending approval'
    })
  } catch (error) {
    console.error('Database error:', error)
    return json({ error: 'Internal server error' }, { status: 500 })
  }
}
