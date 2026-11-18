import type { Stage } from '../../core/status/index.js';
import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Rastreaê's scan titles (`descricao`), mapped whole. Mandaê words a partner carrier's scans in
 * its own short titles and puts the partner's detail, when it keeps one, in a sentence beside
 * them; the replies carry no event code.
 */
export const MANDAE_EVENTS: Readonly<Record<string, Stage>> = {
  'Recebida na Mandaê': 'accepted',
  // "Sua encomenda foi postada via <partner> com o código <code>": handed to the partner carrier.
  'Encomenda encaminhada': 'in_transit',
  'Encomenda processada': 'in_transit',
  'Recebida na unidade da transportadora': 'in_transit',
  'Encomenda recebida na unidade da transportadora': 'in_transit',
  'Encomenda em rota': 'in_transit',
  'Encomenda em rota final': 'out_for_delivery',
  'Entrega realizada': 'delivered',
};

/**
 * The order's state (`situacaoEncomenda`), from the tracker's script. States it shows as a problem
 * or as finished stage the parcel; `Pendente`, `EmProcessamento` and `Expirada` say too little,
 * so the scans decide.
 */
export const MANDAE_ORDER_STATES: Readonly<Record<string, Stage>> = {
  Nova: 'registered',
  AguardandoPostagem: 'registered',
  Coletada: 'accepted',
  Enviada: 'in_transit',
  AguardandoRetiradaDestinatario: 'ready_for_pickup',
  Entregue: 'delivered',
  EmDevolucao: 'exception',
  Devolvida: 'returned',
  DevolvidaParaRemetente: 'returned',
  NaoColetada: 'exception',
  Extraviada: 'exception',
  Cancelada: 'exception',
  Bloqueada: 'exception',
};

/** The page's labels for the states whose name is not already Portuguese as shown. */
export const MANDAE_ORDER_LABELS: Readonly<Record<string, string>> = {
  EmProcessamento: 'Em Processamento',
  AguardandoPostagem: 'Aguardando postagem',
  DevolvidaParaRemetente: 'Devolvida para remetente',
  EmDevolucao: 'Em devolução',
  AguardandoRetiradaDestinatario: 'Aguardando retirada',
  NaoColetada: 'Não coletada',
};

const EVENTS = new Map(Object.entries(MANDAE_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const STATES = new Map(Object.entries(MANDAE_ORDER_STATES));

/** The stage the map gives a scan title, if it knows it. */
export function mandaeEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording));
}

/** The stage of the order's state, if it names one. */
export function mandaeOrderStage(state: string): Stage | undefined {
  return STATES.get(state);
}

/** A scan's stage from its title, else the shared wording rules, else nothing, which keeps it visible for review. */
export function mandaeStage(wording: string): ClassifiedWording | null {
  const mapped = mandaeEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The title sets a scan's stage; the order state reaches the result, never a scan. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mandaeEventStage(wording),
  gaps: [],
};
