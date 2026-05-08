import { describe, expect, it } from 'vitest'

import { computeSafetyIdentifier } from './safetyIdentifier.js'

describe('computeSafetyIdentifier', () => {
  it('returns a 64-character hex string (SHA-256)', async () => {
    const hash = await computeSafetyIdentifier('salt', 'user-1')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', async () => {
    const a = await computeSafetyIdentifier('salt', 'user-1')
    const b = await computeSafetyIdentifier('salt', 'user-1')
    expect(a).toBe(b)
  })

  it('changes when the salt differs', async () => {
    const a = await computeSafetyIdentifier('salt-A', 'user-1')
    const b = await computeSafetyIdentifier('salt-B', 'user-1')
    expect(a).not.toBe(b)
  })

  it('changes when the userId differs', async () => {
    const a = await computeSafetyIdentifier('salt', 'user-1')
    const b = await computeSafetyIdentifier('salt', 'user-2')
    expect(a).not.toBe(b)
  })

  it('handles an empty userId', async () => {
    const hash = await computeSafetyIdentifier('salt', '')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles "anonymous" userId', async () => {
    const hash = await computeSafetyIdentifier('salt', 'anonymous')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the canonical SHA-256 of (salt + userId)', async () => {
    const { createHash } = await import('node:crypto')
    const ref = createHash('sha256').update('saltuser-1').digest('hex')
    const hash = await computeSafetyIdentifier('salt', 'user-1')
    expect(hash).toBe(ref)
  })
})
