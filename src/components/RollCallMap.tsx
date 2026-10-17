import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PIN_COLORS, rollCallPins, type PinPerson } from '../lib/rollCallPins.mjs';

// Map tiles come from OpenStreetMap by default. A customer network that blocks it can point VITE_MAP_TILE_URL at an
// approved tile server; with no tiles the pins and the list still work.
const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined) || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || '&copy; OpenStreetMap contributors';

export default function RollCallMap({ people }: { people: PinPerson[] }) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const { pins, withoutLocation, counts } = useMemo(() => rollCallPins(people), [people]);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { worldCopyJump: true }).setView([39.5, -98.35], 4);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; layer.current = null; fitted.current = false; };
  }, []);

  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    for (const p of pins) {
      const m = L.circleMarker([p.lat, p.lng], { radius: p.status === 'sos' ? 11 : 9, color: '#ffffff', weight: 2, fillColor: p.color, fillOpacity: 0.95 });
      const tip = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = p.name; tip.appendChild(name);
      const line = document.createElement('div'); line.textContent = `${p.label}${p.at ? ` · ${new Date(p.at).toLocaleTimeString()}` : ''}`; tip.appendChild(line);
      if (p.gpsUrl) { const a = document.createElement('a'); a.href = p.gpsUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open in maps'; tip.appendChild(a); }
      m.bindPopup(tip);
      m.addTo(layer.current);
    }
    // Fit once so a live refresh never moves the map under someone who is looking at it.
    if (pins.length > 0 && !fitted.current) {
      map.current.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [pins]);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 14 }}>
        <strong>Map</strong>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: PIN_COLORS.sos, marginRight: 5 }} />Needs help (SOS): {counts.sos}</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: PIN_COLORS.safe, marginRight: 5 }} />Safe: {counts.safe}</span>
        <span style={{ color: 'var(--brand-gray-600)' }}>Pins appear when a person answers from the Active SOS app and shares their location.</span>
      </div>
      <div ref={el} role="region" aria-label="Map of responses" style={{ height: 340, borderRadius: 6, background: '#eef1f5' }} />
      {pins.length === 0 && <p style={{ margin: '8px 0 0', color: 'var(--brand-gray-600)', fontSize: 14 }}>No locations yet.</p>}
      {withoutLocation.length > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 14 }}>
          <strong>Answered without a location ({withoutLocation.length}):</strong>{' '}
          {withoutLocation.map((p) => `${p.name} (${p.status === 'sos' ? 'SOS' : 'safe'})`).join(', ')}
        </p>
      )}
    </div>
  );
}
