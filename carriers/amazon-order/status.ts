import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes of a shared tracking page's state: its `shortStatus`, the
 * `exceptionStateIdentifier` that overrides it when set, and the
 * `lastReachedMilestone` of its progress bar. LOST is the page that apologises
 * for a late delivery and gives no date; a parcel the recipient refused is
 * RETURNING to Amazon.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ORDER_PLACED', 'registered'],
  ['SHIPPING_SOON', 'registered'],
  ['SHIPPED', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['OUT_FOR_DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['PICKED_UP', 'delivered'],
  ['RETURNING', 'exception'],
  ['REFUSED_BY_CUSTOMER', 'exception'],
  ['LOST', 'exception'],
]);

export function amazonOrderStage(code: string | undefined): Stage | undefined {
  return code === undefined ? undefined : CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => amazonOrderStage(code ?? undefined),
  gaps: [
    { code: 'NO_INFORMATION_AVAILABLE', note: 'Amazon has no news from the carrier; the progress bar\'s milestone gives the stage.' },
    { code: 'EDD_IN_THE_PAST_PRE_FRD', note: 'The delivery estimate has passed; it says nothing of where the parcel is, so the page\'s status gives the stage.' },
  ],
};
