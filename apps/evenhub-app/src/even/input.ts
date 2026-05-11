import {
  EventSourceType,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
  type List_ItemEvent,
  type Sys_ItemEvent,
  type Text_ItemEvent,
} from '@evenrealities/even_hub_sdk'

/**
 * Normalized G2 / R1 input event surfaced by {@link subscribeInput}.
 *
 * `kind` is derived from `OsEventTypeList`:
 * - CLICK_EVENT          -> 'singlePress'
 * - DOUBLE_CLICK_EVENT   -> 'doublePress'
 * - SCROLL_TOP_EVENT     -> 'swipeUp'
 * - SCROLL_BOTTOM_EVENT  -> 'swipeDown'
 * - anything else        -> 'unknown' (raw kept for downstream classification)
 *
 * NOTE: Even Hub SDK v0.0.10 does not expose a `LONG_PRESS` enum value; the
 * 'longPress' kind is reserved in the type union for forward compatibility but
 * is currently never produced.
 */
export type AppInputEventKind =
  | 'singlePress'
  | 'doublePress'
  | 'swipeUp'
  | 'swipeDown'
  | 'longPress'
  | 'unknown'

export interface AppInputEvent {
  kind: AppInputEventKind
  raw: EvenHubEvent
}

function mapEventType(eventType: OsEventTypeList | undefined): AppInputEventKind | null {
  switch (eventType) {
    case OsEventTypeList.CLICK_EVENT:
      return 'singlePress'
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'doublePress'
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'swipeUp'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'swipeDown'
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      // Lifecycle events are surfaced by `subscribeLifecycle`, not here.
      return null
    case OsEventTypeList.IMU_DATA_REPORT:
      return null
    case undefined:
      return null
    default:
      return 'unknown'
  }
}

function isTouchEventSource(source: EventSourceType | undefined): boolean {
  return (
    source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R ||
    source === EventSourceType.TOUCH_EVENT_FROM_RING ||
    source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L
  )
}

/**
 * Resolve the input kind from an EvenHubEvent.
 *
 * - `listEvent`: the canonical path on real hardware. The SDK README puts
 *   `isEventCapture=1` on a list container, so CLICK / DOUBLE_CLICK /
 *   SCROLL_TOP / SCROLL_BOTTOM all arrive here with `eventType` set.
 * - `textEvent`: the simulator (>=0.7.3) also surfaces events on text
 *   containers carrying `isEventCapture=1`. Real firmware rejects that
 *   layout but we keep the branch so the simulator stays diagnosable.
 * - `sysEvent`: touch events from the glasses/ring (and lifecycle/IMU).
 *   The simulator *omits* `eventType` when it equals 0 (`CLICK_EVENT`)
 *   because the proto JSON serializer drops fields that match the enum
 *   default. When `sysEvent.eventType` is undefined AND `eventSource`
 *   indicates a touch path, we infer `CLICK_EVENT` rather than silently
 *   dropping the input. Lifecycle / IMU sys events are intentionally
 *   dropped here (no touch eventSource) and surfaced via
 *   `subscribeLifecycle` instead.
 */
function resolveKind(event: EvenHubEvent): AppInputEventKind | null {
  const list: List_ItemEvent | undefined = event.listEvent
  if (list !== undefined) {
    if (list.eventType !== undefined) {
      return mapEventType(list.eventType)
    }
    // Real-device firmware (and the simulator) drop `eventType` when it
    // equals 0 (CLICK_EVENT) because the proto JSON serializer omits enum
    // defaults. Verified via WebInspector on the G2: a frame-tap delivers
    //   {"listEvent":{"containerID":2,"containerName":"list-1"}}
    // with no eventType at all. Treat the omission as CLICK_EVENT.
    return 'singlePress'
  }

  const sys: Sys_ItemEvent | undefined = event.sysEvent
  if (sys !== undefined) {
    if (sys.eventType === undefined) {
      if (isTouchEventSource(sys.eventSource)) return 'singlePress'
      return null
    }
    return mapEventType(sys.eventType)
  }

  const text: Text_ItemEvent | undefined = event.textEvent
  if (text !== undefined) {
    return mapEventType(text.eventType)
  }

  return null
}

/**
 * Subscribe to G2/R1 input events. Returns an unsubscribe function.
 *
 * The handler is invoked only for events that map to a recognized input
 * (singlePress / doublePress / swipeUp / swipeDown) or that arrive on a
 * sys/text channel with an unknown event type. Lifecycle and IMU events are
 * intentionally dropped here and surfaced via {@link subscribeLifecycle}.
 */
export function subscribeInput(
  bridge: EvenAppBridge,
  handler: (event: AppInputEvent) => void,
): () => void {
  return bridge.onEvenHubEvent((event) => {
    const kind = resolveKind(event)
    if (kind === null) return

    handler({ kind, raw: event })
  })
}
