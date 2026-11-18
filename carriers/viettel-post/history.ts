import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { isViettelCaptchaError, normalizeViettelPostNumber, PROVIDER } from './parser.js';
import { statusMap, viettelPostHistoryStage } from './status.js';

/** The current guest tracker groups dated scans by milestone, rather than by time. */
export function parseViettelPostHistory(payload: unknown, raw: string): CarrierResult {
  const number = normalizeViettelPostNumber(raw);
  if (!isRecord(payload) || typeof payload.error !== 'boolean' || typeof payload.status !== 'number') {
    throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid history envelope');
  }
  if (payload.status === 429) throw new RateLimitedError(PROVIDER);
  if (isViettelCaptchaError(payload) || [401, 403].includes(payload.status)) {
    throw new ChallengeError(PROVIDER, 'Viettel Post refused history verification');
  }
  if (payload.error || payload.status !== 200) throw new IndeterminateError(PROVIDER, 'Viettel Post could not answer the history request');
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Viettel Post returned no history list');
  // The guest service can also echo an unknown/hidden number with SHOW_ORDER false.
  // Neither that echo nor an empty list establishes absence or carrier ownership.
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, 'Viettel Post returned no visible history');
  if (payload.data.length !== 1 || !isRecord(payload.data[0])) throw new SchemaError(PROVIDER, 'Viettel Post returned several histories');
  const shipment = payload.data[0];
  const matches = (value: unknown) => typeof value === 'string' && value.trim().toUpperCase() === number;
  if (!matches(shipment.MAVANDON)) throw new SchemaError(PROVIDER, 'Viettel Post answered for another waybill');
  if (typeof shipment.SHOW_ORDER !== 'boolean') throw new SchemaError(PROVIDER, 'Viettel Post changed its history visibility flag');
  if (!shipment.SHOW_ORDER) throw new IndeterminateError(PROVIDER, 'Viettel Post has not exposed this waybill history');
  if (!Array.isArray(shipment.TRACKING_ORDERS) || shipment.TRACKING_ORDERS.length > 30) {
    throw new SchemaError(PROVIDER, 'Viettel Post changed its milestone groups');
  }
  const events: CarrierEvent[] = [];
  for (const group of shipment.TRACKING_ORDERS) {
    if (!isRecord(group) || !Array.isArray(group.TRACKINGS) || group.TRACKINGS.length > 500) {
      throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid scan group');
    }
    for (const scan of group.TRACKINGS) {
      if (!isRecord(scan) || !matches(scan.MAVANDON)) throw new SchemaError(PROVIDER, 'Viettel Post returned a scan for another waybill');
      if (events.length >= 500) throw new SchemaError(PROVIDER, 'Viettel Post returned too many scans');
      if (typeof scan.THOI_GIAN !== 'string' || !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(scan.THOI_GIAN)) {
        throw new SchemaError(PROVIDER, 'Viettel Post returned no scan clock');
      }
      const clock = DateTime.fromFormat(scan.THOI_GIAN, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' });
      if (!clock.isValid || clock.toFormat('dd/MM/yyyy HH:mm:ss') !== scan.THOI_GIAN) {
        throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid scan clock');
      }
      const code = cleanScalar(scan.TRANG_THAI, 16);
      if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid scan code');
      if (typeof scan.STATUS_NAME !== 'string' || typeof scan.GHI_CHU !== 'string') {
        throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid scan wording');
      }
      // NOI_DUNG carries recipient/staff prose and transport internals. The carrier's
      // dedicated scan wording supplies the event without those unrelated fields.
      const description = clean(scan.GHI_CHU || scan.STATUS_NAME, 500);
      if (!description) throw new SchemaError(PROVIDER, 'Viettel Post returned an empty scan wording');
      const places = [scan.TEN_BUUCUC_DI, scan.TINH].filter((value): value is string => typeof value === 'string' && !!value.trim());
      const location = [...new Set(places.map(value => clean(value, 160)))].join(', ');
      const stage = viettelPostHistoryStage(code);
      events.push({ local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description, provider_code: code,
        ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
    }
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Viettel Post lists no dated history');
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!, staged = leadingScan(events, statusMap);
  const stage = staged?.provider_code ? viettelPostHistoryStage(staged.provider_code) : undefined;
  const service = typeof shipment.DICH_VU === 'string' ? clean(shipment.DICH_VU, 80) : '';
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' as const } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, provider_code: newest.provider_code, ...(service ? { service_name: service } : {}), events };
}
