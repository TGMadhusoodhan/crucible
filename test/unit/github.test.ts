import { describe, expect, it } from 'vitest'
import { scrubToken } from '@/lib/workspace/github'

describe('scrubToken', () => {
  it('replaces the token with [REDACTED]', () => {
    const token = 'ghp_abc123SECRET'
    const msg   = `fatal: Authentication failed for 'https://x-access-token:${token}@github.com/owner/repo.git'`
    expect(scrubToken(msg, token)).toBe(
      `fatal: Authentication failed for 'https://x-access-token:[REDACTED]@github.com/owner/repo.git'`,
    )
  })

  it('scrubs all occurrences of the token', () => {
    const token = 'ghp_MULTI'
    const msg   = `token ${token} repeated ${token} again`
    expect(scrubToken(msg, token)).toBe('token [REDACTED] repeated [REDACTED] again')
  })

  it('returns the message unchanged when token is empty', () => {
    const msg = 'some error without a token'
    expect(scrubToken(msg, '')).toBe(msg)
  })

  it('handles tokens with regex special characters', () => {
    const token = 'abc.def+ghi*jkl'
    const msg   = `error: ${token} rejected`
    expect(scrubToken(msg, token)).toBe('error: [REDACTED] rejected')
  })

  it('does not match substrings — only exact token occurrences', () => {
    const token = 'ghp_SECRET'
    const msg   = 'ghp_SECRETEXTENDED is not the same'
    // 'ghp_SECRET' appears at the start of 'ghp_SECRETEXTENDED' — regex replaces it
    const result = scrubToken(msg, token)
    expect(result).not.toContain(token)
  })

  it('handles a token that looks like a URL segment', () => {
    const token = 'fine_grained_pat_xyz789'
    const input = `https://x-access-token:${token}@github.com/user/repo.git`
    const output = scrubToken(input, token)
    expect(output).toBe('https://x-access-token:[REDACTED]@github.com/user/repo.git')
    expect(output).not.toContain(token)
  })
})
