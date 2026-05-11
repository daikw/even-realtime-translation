import { createHash } from 'node:crypto'

/**
 * Computes the OpenAI `safety_identifier` per §10.3:
 *   safety_identifier = sha256(app_specific_salt + even_user_uid)
 *
 * Returns lowercase hex (64 chars) so the digest can be sent verbatim in the
 * OpenAI session create request body.
 *
 * Implemented with `node:crypto` (zero new deps) so it works in Node test
 * environments and in the Express backend. The frontend will call the backend
 * for session creation, so it does not need to compute the digest itself.
 */
export function computeSafetyIdentifier(salt: string, userId: string): Promise<string> {
  const digest = createHash('sha256').update(salt).update(userId).digest('hex')
  return Promise.resolve(digest)
}
