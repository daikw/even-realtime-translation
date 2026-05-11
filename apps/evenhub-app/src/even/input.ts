import {
  EventSourceType,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
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
 * - `textEvent`: the event came from an `isEventCapture` text container.
 *   `eventType` is reliably present and maps via `mapEventType`.
 * - `sysEvent`: touch events from the glasses/ring (and lifecycle/IMU).
 *   The official simulator (>=0.7.3) and at least some firmware builds
 *   *omit* `eventType` when it equals 0 (`CLICK_EVENT`) because the proto
 *   JSON serializer drops fields that match the enum default. So when
 *   `sysEvent.eventType` is undefined AND `eventSource` indicates a touch
 *   path, we infer `CLICK_EVENT` rather than silently dropping the input.
 *   Lifecycle / IMU sys events are intentionally dropped here (they have no
 *   touch eventSource) and surfaced via `subscribeLifecycle` instead.
 */
function resolveKind(event: EvenHubEvent): AppInputEventKind | null {
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
