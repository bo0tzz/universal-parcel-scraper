import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { orderComparableScans } from '../../core/result/order.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { correosBoliviaStage } from './status.js';

export const PROVIDER = 'Correos de Bolivia';
export function normalizeCorreosBoliviaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Correos de Bolivia requires a postal S10 number');
  return number;
}
function field(value: unknown, required = false): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > 500 || (required && !value.trim())) throw new SchemaError(PROVIDER, 'Correos de Bolivia returned an invalid event field');
  return value.trim();
}
function clock(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new SchemaError(PROVIDER, 'Correos de Bolivia returned an invalid event clock');
  const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd HH:mm:ss') !== value) throw new SchemaError(PROVIDER, 'Correos de Bolivia returned an invalid event clock');
  return value.replace(' ', 'T');
}

export function parseCorreosBolivia(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCorreosBoliviaNumber(raw);
  if (!isRecord(payload) || payload.tipo !== 'tracking_eventos' || !isRecord(payload.filtro)
    || typeof payload.filtro.codigo !== 'string' || payload.filtro.codigo.trim().toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Correos de Bolivia did not identify the requested item');
  }
  if (payload.existe_paquete === false && payload.total_registros === 0 && Array.isArray(payload.resultado)
    && payload.resultado.length === 0 && payload.message === 'No existe dicho paquete') throw new NotFoundError(PROVIDER);
  if (payload.existe_paquete !== true || !Array.isArray(payload.resultado) || payload.resultado.length !== 1) {
    throw new SchemaError(PROVIDER, 'Correos de Bolivia returned no unique shipment');
  }
  const shipment: unknown = payload.resultado[0];
  if (!isRecord(shipment) || typeof shipment.codigo !== 'string' || shipment.codigo.trim().toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Correos de Bolivia returned a different item');
  }
  if (!Array.isArray(shipment.eventos) || shipment.eventos.length > 500 || shipment.total_eventos !== shipment.eventos.length
    || payload.total_registros !== shipment.eventos.length) throw new SchemaError(PROVIDER, 'Correos de Bolivia returned an incomplete history');
  if (!shipment.eventos.length) throw new NoHistoryError(PROVIDER);
  const services = new Set<string>();
  const listed = shipment.eventos.map((row: unknown) => {
    if (!isRecord(row) || typeof row.codigo !== 'string' || row.codigo.trim().toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'Correos de Bolivia mixed shipment histories');
    }
    const description = field(row.nombre_evento, true), location = field(row.office), service = field(row.servicio);
    if (service) services.add(service);
    if (!Number.isSafeInteger(row.codigo_evento) || (row.codigo_evento as number) < 0) throw new SchemaError(PROVIDER, 'Correos de Bolivia returned an invalid event code');
    const classified = correosBoliviaStage(description);
    // sort_at and timezone_label describe capture, not the facility's event clock.
    return { local_time: clock(row.created_at), description, provider_code: String(row.codigo_evento),
      ...(location ? { location } : {}), ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
  });
  const events = orderComparableScans(listed, event => event.location);
  const newest = events[0]!, classified = correosBoliviaStage(newest.description);
  return { status: classified ? languageStageStatus(classified.stage) : 'unknown',
    ...(classified ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    provider_code: newest.provider_code, last_status_text: newest.description, last_update: null,
    last_update_local: newest.local_time, expected_delivery: null, events: events.slice(0, 100),
    ...(services.size === 1 ? { service_name: [...services][0]! } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}
