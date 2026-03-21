import type { PagesFunction } from '@cloudflare/workers-types'

export interface Env {
  BLOG_DB: D1Database
  TURNSTILE_SECRET_KEY?: string
  COMMENT_HASH_SALT?: string
}

export interface Comment {
  id: number
  slug: string
  path: string
  parent_id?: number
  author_name: string
  author_email_hash?: string
  author_url?: string
  content: string
  status: 'pending' | 'approved' | 'spam' | 'deleted'
  created_at: string
}

// Hash IP for privacy
async function hashIP(ip: string, salt: string): Promise<string> {
  const text = new TextEncoder().encode(ip + salt)
  const hashBuffer = await crypto.subtle.digest('SHA-256', text)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
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

  const outcome = await result.json()
  return outcome.success === true
}

// GET /api/comments?slug=xxx - List approved comments
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const url = new URL(request.url)
  const slug = url.searchParams.get('slug')

  if (!slug) {
    return new Response(JSON.stringify({ error: 'Missing slug parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const { results } = await env.BLOG_DB.prepare(
      `SELECT id, slug, path, parent_id, author_name, author_url, content, created_at
       FROM comments 
       WHERE slug = ? AND status = 'approved'
       ORDER BY parent_id NULLS FIRST, created_at ASC`
    ).bind(slug).all<Comment>()

    return new Response(JSON.stringify({ comments: results || [] }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('Database error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// POST /api/comments - Create new comment
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  
  // Parse request body
  let body: {
    slug: string
    path: string
    parent_id?: number
    author_name: string
    author_email?: string
    author_url?: string
    content: string
    turnstile_token?: string
  }

  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Validate required fields
  if (!body.slug || !body.path || !body.author_name || !body.content) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Sanitize inputs
  const slug = body.slug.slice(0, 255)
  const path = body.path.slice(0, 512)
  const author_name = body.author_name.slice(0, 50)
  const author_url = body.author_url?.slice(0, 255) || null
  const content = body.content.slice(0, 5000)

  // Verify Turnstile if configured
  let turnstileOk = 0
  if (env.TURNSTILE_SECRET_KEY && body.turnstile_token) {
    const verified = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET_KEY)
    if (!verified) {
      return new Response(JSON.stringify({ error: 'Turnstile verification failed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    turnstileOk = 1
  }

  // Get client IP and hash it
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
  const ipHash = await hashIP(clientIP, env.COMMENT_HASH_SALT || 'default-salt')

  try {
    // Check rate limit
    const rateWindow = 60 // seconds
    const rateLimit = 3
    
    const { results: rateResults } = await env.BLOG_DB.prepare(
      `SELECT COUNT(*) as count FROM comment_rate_limits 
       WHERE ip_hash = ? AND path = ? AND created_at > datetime('now', '-${rateWindow} seconds')`
    ).bind(ipHash, path).all<{ count: number }>()

    if (rateResults && rateResults[0]?.count >= rateLimit) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Insert rate limit record
    await env.BLOG_DB.prepare(
      `INSERT INTO comment_rate_limits (ip_hash, path) VALUES (?, ?)`
    ).bind(ipHash, path).run()

    // Insert comment
    const { meta } = await env.BLOG_DB.prepare(
      `INSERT INTO comments 
       (slug, path, parent_id, author_name, author_email_hash, author_url, content, ip_hash, turnstile_ok, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      slug,
      path,
      body.parent_id || null,
      author_name,
      body.author_email ? await hashIP(body.author_email, env.COMMENT_HASH_SALT || 'default-salt') : null,
      author_url,
      content,
      ipHash,
      turnstileOk,
      request.headers.get('User-Agent')?.slice(0, 255) || null
    ).run()

    return new Response(JSON.stringify({ 
      success: true, 
      id: meta.last_row_id,
      message: 'Comment submitted and pending approval'
    }), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Database error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
