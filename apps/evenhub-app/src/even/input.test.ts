import { describe, expect, it, vi } from 'vitest'
import {
  EventSourceType,
  List_ItemEvent,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

import { subscribeInput, type AppInputEvent } from './input.js'

interface MinimalBridge {
  onEvenHubEvent: ReturnType<typeof vi.fn>
}

function makeBridge(): {
  bridge: MinimalBridge
  emit: (event: EvenHubEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let listener: ((event: EvenHubEvent) => void) | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  const onEvenHubEvent = vi.fn((cb: (event: EvenHubEvent) => void) => {
    listener = cb
    return unsubscribe
  })
  return {
    bridge: { onEvenHubEvent },
    emit: (event) => {
      if (listener) listener(event)
    },
    unsubscribe,
  }
}

function asBridge(b: MinimalBridge): EvenAppBridge {
  return b as unknown as EvenAppBridge
}

describe('subscribeInput', () => {
  it('returns the SDK unsubscribe function', () => {
    const { bridge, unsubscribe } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()

    const off = subscribeInput(asBridge(bridge), handler)
    expect(bridge.onEvenHubEvent).toHaveBeenCalledTimes(1)

    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('maps CLICK_EVENT to singlePress', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    const sysEvent = new Sys_ItemEvent({
      eventType: OsEventTypeList.CLICK_EVENT,
      eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    })
    emit({ sysEvent })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0].kind).toBe('singlePress')
  })

  it('maps DOUBLE_CLICK_EVENT to doublePress', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }),
    })

    expect(handler.mock.calls[0]?.[0].kind).toBe('doublePress')
  })

  it('maps SCROLL_TOP_EVENT to swipeUp', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }) })

    expect(handler.mock.calls[0]?.[0].kind).toBe('swipeUp')
  })

  it('maps SCROLL_BOTTOM_EVENT to swipeDown', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT }) })

    expect(handler.mock.calls[0]?.[0].kind).toBe('swipeDown')
  })

  it('also derives press kinds from textEvent payloads', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({
      textEvent: new Text_ItemEvent({
        containerID: 1,
        eventType: OsEventTypeList.CLICK_EVENT,
      }),
    })

    expect(handler.mock.calls[0]?.[0].kind).toBe('singlePress')
  })

  it('preserves the original event on the AppInputEvent.raw field', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    const raw: EvenHubEvent = {
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }),
    }
    emit(raw)

    expect(handler.mock.calls[0]?.[0].raw).toBe(raw)
  })

  it('infers CLICK_EVENT when sysEvent has touch eventSource but no eventType (simulator quirk)', () => {
    // Regression for evenhub-simulator 0.7.3 + at least some firmware builds:
    // they omit `eventType` when it equals 0 (`CLICK_EVENT`) because the proto
    // JSON serializer drops fields that match the enum default. Confirmed via
    // the simulator's /api/console: a Click button press emits
    //   {"sysEvent":{"eventSource":1}}
    // with no eventType field at all.
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({
      sysEvent: new Sys_ItemEvent({
        eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
      }),
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0].kind).toBe('singlePress')
  })

  it('does NOT infer CLICK for a sysEvent without touch eventSource (lifecycle path)', () => {
    // A sysEvent lacking both eventType and a touch source should be dropped,
    // not treated as a click. This guards against forwarding lifecycle / IMU
    // events into the input handler when the simulator quirk fires.
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({ sysEvent: new Sys_ItemEvent({}) })

    expect(handler).not.toHaveBeenCalled()
  })

  it('drops lifecycle event types (forwarded by subscribeLifecycle instead)', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
    })
    emit({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.IMU_DATA_REPORT }),
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('falls back to "unknown" for an OS event type the SDK adds in the future', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    // Fabricate a numeric eventType outside the known enum range to exercise
    // the default branch. Cast through unknown because TS narrows to the enum.
    emit({
      sysEvent: new Sys_ItemEvent({ eventType: 99 as unknown as OsEventTypeList }),
    })

    expect(handler.mock.calls[0]?.[0].kind).toBe('unknown')
  })

  it('maps listEvent.eventType via mapEventType (real-device input path)', () => {
    // SDK README places isEventCapture=1 on a list container; real firmware
    // delivers CLICK / DOUBLE_CLICK / SCROLL_* through listEvent. The earlier
    // text-container layout never reached production hardware because the
    // host rejected createStartUpPageContainer with StartUpPageCreateResult.
    // invalid.
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({
      listEvent: new List_ItemEvent({
        containerID: 2,
        containerName: 'input',
        eventType: OsEventTypeList.CLICK_EVENT,
      }),
    })

    expect(handler.mock.calls[0]?.[0].kind).toBe('singlePress')
  })

  it('ignores audioEvent and other non-input payloads', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    subscribeInput(asBridge(bridge), handler)

    emit({ audioEvent: { audioPcm: new Uint8Array() } })
    emit({ jsonData: { foo: 'bar' } })
    emit({})

    expect(handler).not.toHaveBeenCalled()
  })

  it('does not re-fire after unsubscribe', () => {
    const { bridge, emit } = makeBridge()
    const handler = vi.fn<(e: AppInputEvent) => void>()
    const off = subscribeInput(asBridge(bridge), handler)
    off()

    emit({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }) })
    expect(handler).not.toHaveBeenCalled()
  })
})
