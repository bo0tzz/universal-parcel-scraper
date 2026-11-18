import { describe, expect, it } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseViettelPostHistory } from './history.js';

import { HISTORY_NUMBER, historyFixture } from './fixtures/history.js';

describe('Viettel Post current guest history', () => {
  it('binds every scan, sorts milestone groups by native wall clock and preserves delivery after a neutral edit', () => {
    const result = parseViettelPostHistory(historyFixture(), HISTORY_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      service_name: 'Synthetic express', last_update: null, last_update_local: '2026-04-09T08:23:31', expected_delivery: null });
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toMatchObject({ provider_code: '202', description: 'Sửa phiếu gửi', local_time: '2026-04-09T08:23:31' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events!.find(e => e.provider_code === '103')).not.toHaveProperty('stage');
    expect(result.events!.every(e => !e.time && e.local_time && e.location === 'Synthetic depot, Synthetic province')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires the root and each nested identity, never using group labels as confirmation', () => {
    const wrongRoot = historyFixture(); wrongRoot.data[0]!.MAVANDON += '1';
    const wrongScan = historyFixture(); wrongScan.data[0]!.TRACKING_ORDERS[0]!.TRACKINGS[0]!.MAVANDON += '1';
    for (const value of [wrongRoot, wrongScan]) expect(() => parseViettelPostHistory(value, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps hidden, empty and undated answers inconclusive, even when they echo the query', () => {
    const hidden = historyFixture(); hidden.data[0]!.SHOW_ORDER = false;
    const empty = historyFixture(); empty.data[0]!.TRACKING_ORDERS = [];
    for (const value of [hidden, empty, { status: 200, error: false, data: [] }]) {
      expect(() => parseViettelPostHistory(value, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps verification, rate limits and malformed histories distinct', () => {
    expect(() => parseViettelPostHistory({ status: 201, error: true, message: 'captcha rejected' }, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseViettelPostHistory({ status: 429, error: true }, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    const badClock = historyFixture(); badClock.data[0]!.TRACKING_ORDERS[0]!.TRACKINGS[0]!.THOI_GIAN = '31/02/2026 12:59:58';
    const noSeconds = historyFixture(); noSeconds.data[0]!.TRACKING_ORDERS[0]!.TRACKINGS[0]!.THOI_GIAN = '08/04/2026 12:59';
    for (const value of [badClock, noSeconds, { status: 200, error: false, data: {} }, { changed: true }]) {
      expect(() => parseViettelPostHistory(value, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('caps the total history and preserves unknown codes without guessing their stage', () => {
    const unknown = historyFixture(); unknown.data[0]!.TRACKING_ORDERS[0]!.TRACKINGS[0]!.TRANG_THAI = 999;
    const result = parseViettelPostHistory(unknown, HISTORY_NUMBER);
    expect(result.events!.find(e => e.provider_code === '999')).not.toHaveProperty('stage');
    const huge = historyFixture(); const scan = huge.data[0]!.TRACKING_ORDERS[0]!.TRACKINGS[0]!;
    huge.data[0]!.TRACKING_ORDERS = [{ STATUS_NAME: 'Synthetic', TRACKINGS: Array.from({ length: 501 }, () => ({ ...scan })) }];
    expect(() => parseViettelPostHistory(huge, HISTORY_NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('declares administrative code gaps consistently with the parser', () => {
    expect(statusMapAnswer({ carrier: 'viettel-post', providerCode: '103', description: 'Giao cho bưu cục' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'viettel-post', providerCode: '202', description: 'Sửa phiếu gửi' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'viettel-post', providerCode: '501', description: 'Phát thành công' })).toMatchObject({ stage: 'delivered' });
  });
});

it('withdraws delivery after an unmapped movement', () => {
  const data = historyFixture();
  const row = data.data[0]!.TRACKING_ORDERS.flatMap(group => group.TRACKINGS).find(scan => scan.TRANG_THAI === 202)!;
  Object.assign(row, { TRANG_THAI: 999, GHI_CHU: 'Shipment returned to sender' });
  const result = parseViettelPostHistory(data, HISTORY_NUMBER);
  expect(result.status).toBe('unknown');
  expect(result.delivered_at).toBeUndefined();
});
