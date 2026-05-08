import { describe, expect, it, vi } from 'vitest'

import { exchangeSdp } from './sdp.js'

const OFFER_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n'
const ANSWER_SDP = 'v=0\r\no=- 1 1 IN IP4 1.2.3.4\r\n'
const SECRET = 'cs_test_secret_value_12345'

function fakeFetch(
  responder: (input: string | URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  const impl: typeof fetch = async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new Error('Request object inputs are not used by exchangeSdp')
    }
    return await responder(input, init)
  }
  return vi.fn<typeof fetch>(impl)
}

describe('exchangeSdp', () => {
  it('POSTs SDP with correct headers and returns the answer text on 200', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null
    const fetchImpl = fakeFetch((url, init) => {
      captured = { url: String(url), init }
      return new Response(ANSWER_SDP, { status: 200, headers: { 'content-type': 'text/plain' } })
    })

    const answer = await exchangeSdp({
      offerSdp: OFFER_SDP,
      clientSecret: SECRET,
      fetchImpl,
    })

    expect(answer).toBe(ANSWER_SDP)
    expect(captured).not.toBeNull()
    if (captured === null) throw new Error('unreachable')
    const cap: { url: string; init: RequestInit | undefined } = captured
    expect(cap.url).toBe(
      'https://api.openai.com/v1/realtime/translations/calls?model=gpt-realtime-translate',
    )
    const headers = new Headers(cap.init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`)
    expect(headers.get('content-type')).toBe('application/sdp')
    expect(cap.init?.method).toBe('POST')
    expect(cap.init?.body).toBe(OFFER_SDP)
  })

  it('honours custom baseUrl and model in the URL', async () => {
    let capturedUrl = ''
    const fetchImpl = fakeFetch((url) => {
      capturedUrl = String(url)
      return new Response(ANSWER_SDP, { status: 200 })
    })

    await exchangeSdp({
      offerSdp: OFFER_SDP,
      clientSecret: SECRET,
      baseUrl: 'https://example.test',
      model: 'gpt-realtime-translate-mini',
      fetchImpl,
    })

    expect(capturedUrl).toBe(
      'https://example.test/v1/realtime/translations/calls?model=gpt-realtime-translate-mini',
    )
  })

  it('strips a trailing slash from baseUrl', async () => {
    let capturedUrl = ''
    const fetchImpl = fakeFetch((url) => {
      capturedUrl = String(url)
      return new Response(ANSWER_SDP, { status: 200 })
    })

    await exchangeSdp({
      offerSdp: OFFER_SDP,
      clientSecret: SECRET,
      baseUrl: 'https://example.test/',
      fetchImpl,
    })

    expect(capturedUrl.startsWith('https://example.test/v1/realtime/')).toBe(true)
  })

  it('throws on non-2xx response with the status code in the message', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response('unauthorized', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
    )

    await expect(
      exchangeSdp({ offerSdp: OFFER_SDP, clientSecret: SECRET, fetchImpl }),
    ).rejects.toThrow(/401/)
  })

  it('does NOT include the client secret in error messages', async () => {
    const fetchImpl = fakeFetch(() => new Response('forbidden', { status: 403 }))

    await expect(
      exchangeSdp({ offerSdp: OFFER_SDP, clientSecret: SECRET, fetchImpl }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(SECRET) as unknown as string,
      }),
    )
  })

  it('treats 5xx as failure too', async () => {
    const fetchImpl = fakeFetch(() => new Response('boom', { status: 500 }))
    await expect(
      exchangeSdp({ offerSdp: OFFER_SDP, clientSecret: SECRET, fetchImpl }),
    ).rejects.toThrow(/500/)
  })

  it('propagates network errors as-is', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('network down')
    })
    await expect(
      exchangeSdp({ offerSdp: OFFER_SDP, clientSecret: SECRET, fetchImpl }),
    ).rejects.toThrow(/network down/)
  })
})
