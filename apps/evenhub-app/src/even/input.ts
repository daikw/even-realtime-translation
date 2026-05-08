import {
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

function extractInputPayload(event: EvenHubEvent): Sys_ItemEvent | Text_ItemEvent | null {
  // sysEvent carries G2/R1 touch + system events; textEvent carries text
  // container interactions. listEvent is list-specific; we don't currently
  // map it because the M0-M2 HUD has no list containers.
  if (event.sysEvent !== undefined) return event.sysEvent
  if (event.textEvent !== undefined) return event.textEvent
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
    const payload = extractInputPayload(event)
    if (payload === null) return

    const kind = mapEventType(payload.eventType)
    if (kind === null) return

    handler({ kind, raw: event })
  })
}
