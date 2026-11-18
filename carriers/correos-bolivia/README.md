# Correos de Bolivia

Reads the official TrackingBO app's public guest history over HTTP. Select Correos de Bolivia
explicitly for international postal items; postal detection remains with the international-mail
carrier. No HTTP recognition claims ownership from imported events alone.

## Retrieval

The APK published on the [official applications page](https://correos.gob.bo/misaplicaciones)
calls `/api/public/tracking/eventos?codigo={number}` on `trackingbo.correos.gob.bo`.
Its optional API authorization is absent from the distributed configuration and is unnecessary
for this guest operation. The adapter neither signs in nor subscribes to notifications.

The response must identify the whole item in its filter, unique shipment and every event.
Event counts must match. Only a structured, identity-bound explicit absence is not found;
a removed endpoint, verification page, rate limit or malformed reply remains a separate failure.
A network failure can retry once within the lookup budget.

Event wording, codes, offices and service names are retained. `created_at` is the facility event
clock. `sort_at` and its UTC capture label describe ingestion, so they cannot supply the event's
instant or zone. Consecutive events at one office are ordered by its local clock. Office changes keep their source order. Payment notices,
internal user identifiers and other administrative fields are discarded.

## Scope and limitations

The national post is run by the Agencia Boliviana de Correos, which replaced ECOBOL.
The guest API includes imported postal EDI history, so a result does not itself prove a completed
Bolivian delivery. Numeric domestic references and other formats are outside the adapter's
confirmed S10 scope. No number-rule or cheap recognition expansion is implied.

The ordinary web search uses a separate text-verification flow. It is not needed by the mobile
operation. Enabled universal providers remain available when native retrieval fails.

## Testing

Supply private controls outside Git with `CORREOS_BOLIVIA_TRACKING_NUMBER` and
`CORREOS_BOLIVIA_UNKNOWN_NUMBER`, then run
`npm run test:carriers:live -- carriers/correos-bolivia`.
