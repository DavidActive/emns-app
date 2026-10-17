// Turns the roll-call people list into map pins. Pure logic, no browser code, so it can be tested on its own.
// Red = needs help (SOS), green = safe. Anyone who answered without a location is listed separately, never guessed.
export const PIN_COLORS = { sos: '#D64545', safe: '#2E9E6B', other: '#5b6678' };
const LABEL = { sos: 'Needs help (SOS)', safe: 'Safe', replied: 'Replied', unaccounted: 'Unaccounted for', pending: 'Still sending', not_contacted: 'Not contacted' };

const validPoint = (lat, lng) =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export function rollCallPins(people) {
  const pins = [];
  const withoutLocation = [];
  for (const p of people || []) {
    const answered = p.status === 'sos' || p.status === 'safe';
    if (validPoint(p.lat, p.lng)) {
      pins.push({
        id: p.person_id, name: p.full_name, status: p.status, label: LABEL[p.status] || p.status,
        color: p.status === 'sos' ? PIN_COLORS.sos : p.status === 'safe' ? PIN_COLORS.safe : PIN_COLORS.other,
        lat: p.lat, lng: p.lng, at: p.responded_at || null, gpsUrl: typeof p.gps_url === 'string' && /^https?:\/\//.test(p.gps_url) ? p.gps_url : null,
        source: p.last_source || null,
      });
    } else if (answered) {
      withoutLocation.push({ id: p.person_id, name: p.full_name, status: p.status, label: LABEL[p.status] });
    }
  }
  // Red pins draw last so they are never hidden under green ones.
  pins.sort((a, b) => (a.status === 'sos') - (b.status === 'sos'));
  const sos = pins.filter((x) => x.status === 'sos').length;
  return { pins, withoutLocation, counts: { sos, safe: pins.filter((x) => x.status === 'safe').length, located: pins.length } };
}
