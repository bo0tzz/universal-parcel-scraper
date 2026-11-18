import { countryCode, countryTimeZone, mislabeledLocalTime } from '../../core/time/index.js';

/**
 * Correos de México's clocks. Its offices on central time write Mexico City's.
 * A foreign post's scan comes through as that post's data gives it, and some
 * posts' data gives their offices' wall clocks as UTC times, which the tracker
 * shows on Mexico City's clock, six hours early: 4-72's arrival of an item in
 * Colombia and the start of its customs inspection came six hours before UPU's
 * copies of them, which carry 4-72's own digits.
 */
export const CORREOS_DE_MEXICO_ZONE = 'America/Mexico_City';

// Countries whose post's data gives its offices' wall clocks as UTC times.
const WALL_CLOCK_AS_UTC: ReadonlySet<string> = new Set(['CO']);
// A UPU office code, as the tracker names a foreign post's office: two letters for its country,
// three for its place and one more.
const POSTAL_OFFICE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;
// Mexican places of that shape.
const MEXICAN_PLACES: ReadonlySet<string> = new Set(['COLIMA', 'COCULA']);

/** The country abroad a scan's place names, by its name ("COLOMBIA") or its UPU office code. */
function foreignCountry(location: string, colombianRoute: boolean): string | null {
  const place = location.trim();
  const office = !MEXICAN_PLACES.has(place.toUpperCase()) && (colombianRoute || place === 'COBOGC')
    ? POSTAL_OFFICE.exec(place)?.[1] : undefined;
  const country = countryCode(place) ?? (office ? countryCode(office) : null);
  return country && country !== 'MX' ? country : null;
}

/**
 * The clock of a foreign post's scan that the tracker shows from that post's
 * wall clock read as UTC: the post's zone and its wall clock, as offset-less
 * digits. Null for any other scan.
 */
export function correosDeMexicoForeignClock(location: string, shown: unknown, colombianRoute = false): { zone: string; wall: string } | null {
  const country = foreignCountry(location, colombianRoute);
  const zone = country && WALL_CLOCK_AS_UTC.has(country) ? countryTimeZone(country) : null;
  const read = zone ? mislabeledLocalTime(shown, CORREOS_DE_MEXICO_ZONE) : null;
  return zone && read ? { zone, wall: new Date(read.timestamp).toISOString().slice(0, 19) } : null;
}
