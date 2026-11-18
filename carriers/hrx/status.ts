import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One event name of the tracker: the wording its page shows in English, and its stage. */
interface HrxEvent {
  readonly wording: string;
  readonly stage?: Stage;
}

// The tracker's event names, with the wording its page's English translations
// give each. `ready` is the sender's order ready for HRX to collect; the
// parcel waiting for its recipient is `notified`.
const EVENTS: ReadonlyMap<string, HrxEvent> = new Map<string, HrxEvent>([
  ['created', { wording: 'Order created', stage: 'registered' }],
  ['not_ready', { wording: 'Not ready', stage: 'registered' }],
  ['ready', { wording: 'Ready', stage: 'registered' }],
  ['hrx_picked_up', { wording: 'Picked up by HRX', stage: 'accepted' }],
  ['hrx_terminal_in', { wording: 'In terminal HRX', stage: 'in_transit' }],
  ['hrx_terminal_out', { wording: 'Out of terminal', stage: 'in_transit' }],
  ['moved', { wording: 'On the move', stage: 'in_transit' }],
  ['delivered_to_partner', { wording: 'Distribution center', stage: 'in_transit' }],
  ['scanned_by_partner', { wording: 'Scanned in distribution center', stage: 'in_transit' }],
  ['notified', { wording: 'Ready for pickup - customer notified', stage: 'ready_for_pickup' }],
  ['delivered', { wording: 'Delivered', stage: 'delivered' }],
  ['customer_returned', { wording: 'Parcel is being returned', stage: 'exception' }],
  ['returned', { wording: 'Returned', stage: 'returned' }],
  ['cancelled', { wording: 'Order is cancelled', stage: 'exception' }],
  ['writeoff', { wording: 'Parcel written off', stage: 'exception' }],
  ['other', { wording: 'Unparsed' }],
]);

/** An event name's wording and stage, or undefined for a name the tracker's page does not list. */
export function hrxEvent(name: string): HrxEvent | undefined {
  return EVENTS.get(name);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? EVENTS.get(code)?.stage : undefined),
  gaps: [{ code: 'other', note: 'An event HRX could not read from its partner; it says nothing about the parcel.' }],
};
