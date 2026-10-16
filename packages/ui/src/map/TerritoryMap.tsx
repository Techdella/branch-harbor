'use client';

/**
 * Territory map on MapLibre GL (dashboard Sales → Territories and the public "Available territories" map).
 *
 * Basemap from the API's map config (MAP_TILES_URL): a MapLibre style URL, a raster XYZ template, or — when nothing
 * is configured — a plain styled background with a latitude / longitude graticule (no third-party requests).
 * Territory names and location pins are HTML markers, so they render without a glyph server.
 *
 * MapLibre and its worker are loaded on demand: each app copies the worker to `/vendor/maplibre/` at build time
 * (scripts/vendor-maplibre.mjs), so bundlers never have to handle the worker file.
 */
import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, Marker as MlMarker, StyleSpecification } from 'maplibre-gl';
import type { Position, TerritoryGeometry } from '@bh/shared';

export interface MapConfig { tilesUrl: string | null; kind: 'style' | 'raster' | 'outline'; attribution: string | null }
export interface MapTerritory { id: string; name: string; status: string; geometry: TerritoryGeometry | null; centroid: { lat: number; lng: number } | null }
export interface MapPoint { id: string; name: string; lat: number; lng: number }

export const STATUS_COLORS: Record<string, string> = {
  available: '#2E9E5B', reserved: '#D9A400', sold: '#5B6CD9', under_development: '#B061C9', open: '#1F2937', unavailable: '#9CA3AF', taken: '#9CA3AF',
};

const VENDOR = '/vendor/maplibre';

function graticule() {
  const features: Array<{ type: 'Feature'; properties: Record<string, never>; geometry: { type: 'LineString'; coordinates: Position[] } }> = [];
  for (let lng = -180; lng <= 180; lng += 10) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: 33 }, (_, i) => [lng, -80 + i * 5] as Position) } });
  for (let lat = -80; lat <= 80; lat += 10) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat] as Position) } });
  return { type: 'FeatureCollection' as const, features };
}

function baseStyle(cfg: MapConfig): StyleSpecification | string {
  if (cfg.kind === 'style' && cfg.tilesUrl) return cfg.tilesUrl;
  if (cfg.kind === 'raster' && cfg.tilesUrl) {
    return { version: 8, sources: { base: { type: 'raster', tiles: [cfg.tilesUrl], tileSize: 256, attribution: cfg.attribution ?? '' } }, layers: [{ id: 'base', type: 'raster', source: 'base' }] };
  }
  return {
    version: 8,
    sources: { grid: { type: 'geojson', data: graticule() } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#EEF1EC' } },
      { id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#D5DCD3', 'line-width': 1 } },
    ],
  };
}

const bboxOf = (ts: MapTerritory[], pts: MapPoint[]): [[number, number], [number, number]] | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of ts) {
    if (t.geometry) for (const poly of t.geometry.type === 'Polygon' ? [t.geometry.coordinates] : t.geometry.coordinates) for (const [x, y] of poly[0] ?? []) { xs.push(x); ys.push(y); }
    else if (t.centroid) { xs.push(t.centroid.lng); ys.push(t.centroid.lat); }
  }
  for (const p of pts) { xs.push(p.lng); ys.push(p.lat); }
  if (!xs.length) return null;
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
};

/** Zoomed out, territories are coloured dots (names would pile up); from city level they are name labels. */
const LABEL_ZOOM = 5;
function styleLabel(node: HTMLElement, zoom: number) {
  const sel = node.dataset.selected === '1';
  const color = node.dataset.color ?? '#6B7280';
  if (zoom < LABEL_ZOOM && !sel) {
    node.style.cssText = `width: 14px; height: 14px; padding: 0; border-radius: 999px; border: 2px solid #fff; background: ${color}; color: transparent; font-size: 0; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.3);`;
    return;
  }
  node.style.cssText = `font: 700 11px/1.2 system-ui, sans-serif; padding: 2px 6px; border-radius: 999px; border: 2px solid ${color}; background: ${sel ? '#141414' : 'rgba(255,255,255,0.92)'}; color: ${sel ? '#fff' : '#141414'}; white-space: nowrap; cursor: pointer; max-width: 160px; overflow: hidden; text-overflow: ellipsis;`;
}

export function TerritoryMap({
  config, territories, points = [], selectedId = null, onSelect, drawing = false, draft = [], onDraftChange, fitKey, label, outlineNote, className, colors = STATUS_COLORS, labelStatuses, fitStatuses,
}: {
  config: MapConfig;
  territories: MapTerritory[];
  points?: MapPoint[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  drawing?: boolean;
  draft?: Position[];
  onDraftChange?: (pts: Position[]) => void;
  /** Change it to fit the map to the territories again (e.g. after a filter). */
  fitKey?: string;
  label: string;
  /** Shown on the outline basemap ("No street map configured"). */
  outlineNote?: string;
  className?: string;
  colors?: Record<string, string>;
  /** Only territories in these statuses get a name label (all when omitted). */
  labelStatuses?: string[];
  /** Fit the view to territories in these statuses (all when omitted), e.g. the available ones on the public map. */
  fitStatuses?: string[];
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<MlMarker[]>([]);
  const lib = useRef<typeof import('maplibre-gl') | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const cb = useRef({ onSelect, onDraftChange, drawing, draft });
  cb.current = { onSelect, onDraftChange, drawing, draft };

  useEffect(() => {
    let cancelled = false;
    if (!document.querySelector(`link[data-maplibre]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${VENDOR}/maplibre-gl.css`;
      link.dataset.maplibre = '1';
      document.head.appendChild(link);
    }
    (async () => {
      try {
        const ml = await import('maplibre-gl');
        if (cancelled || !el.current) return;
        ml.setWorkerUrl(`${window.location.origin}${VENDOR}/maplibre-gl-worker.mjs`);
        lib.current = ml;
        const m = new ml.Map({ container: el.current, style: baseStyle(config), center: [0, 20], zoom: 1, attributionControl: config.attribution ? { compact: true } : false, dragRotate: false, pitchWithRotate: false });
        m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        m.on('load', () => {
          m.addSource('territories', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          m.addLayer({ id: 't-fill', type: 'fill', source: 'territories', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'selected'], 0.45, 0.25] } });
          m.addLayer({ id: 't-line', type: 'line', source: 'territories', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'selected'], 3.5, 1.6] } });
          m.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          m.addLayer({ id: 'd-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#D9A400', 'fill-opacity': 0.2 } });
          m.addLayer({ id: 'd-line', type: 'line', source: 'draft', paint: { 'line-color': '#B45309', 'line-width': 2, 'line-dasharray': [2, 1] } });
          m.addLayer({ id: 'd-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#B45309', 'circle-stroke-width': 2 } });
          m.on('click', 't-fill', (e) => {
            if (cb.current.drawing) return;
            const id = e.features?.[0]?.properties?.id as string | undefined;
            if (id) cb.current.onSelect?.(id);
          });
          m.on('mouseenter', 't-fill', () => { if (!cb.current.drawing) m.getCanvas().style.cursor = 'pointer'; });
          m.on('mouseleave', 't-fill', () => { m.getCanvas().style.cursor = cb.current.drawing ? 'crosshair' : ''; });
          m.on('click', (e) => {
            if (!cb.current.drawing) return;
            cb.current.onDraftChange?.([...cb.current.draft, [Math.round(e.lngLat.lng * 1e6) / 1e6, Math.round(e.lngLat.lat * 1e6) / 1e6]]);
          });
          m.on('zoomend', () => { for (const x of markers.current) { const el = x.getElement(); if (el.dataset.color) styleLabel(el, m.getZoom()); } });
          setReady(true);
        });
        map.current = m;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      markers.current.forEach((x) => x.remove());
      map.current?.remove();
      map.current = null;
    };
    // The basemap is fixed for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tilesUrl, config.kind]);

  // Territories, labels and pins.
  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!ready || !m || !ml) return;
    (m.getSource('territories') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: territories.filter((t) => t.geometry).map((t) => ({ type: 'Feature', id: t.id, geometry: t.geometry!, properties: { id: t.id, name: t.name, color: colors[t.status] ?? '#6B7280', selected: t.id === selectedId } })),
    });
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    for (const t of territories) {
      if (!t.centroid || (labelStatuses && !labelStatuses.includes(t.status) && t.id !== selectedId)) continue;
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = t.name;
      node.setAttribute('aria-label', t.name);
      node.dataset.selected = t.id === selectedId ? '1' : '';
      node.dataset.color = colors[t.status] ?? '#6B7280';
      styleLabel(node, m.getZoom());
      node.addEventListener('click', (ev) => { ev.stopPropagation(); if (!cb.current.drawing) cb.current.onSelect?.(t.id); });
      markers.current.push(new ml.Marker({ element: node }).setLngLat([t.centroid.lng, t.centroid.lat]).addTo(m));
    }
    for (const p of points) {
      const node = document.createElement('div');
      node.title = p.name;
      node.setAttribute('role', 'img');
      node.setAttribute('aria-label', p.name);
      node.style.cssText = 'width: 14px; height: 14px; border-radius: 999px; background: #141414; border: 3px solid #E2F5A6; box-shadow: 0 1px 3px rgba(0,0,0,.35);';
      markers.current.push(new ml.Marker({ element: node }).setLngLat([p.lng, p.lat]).addTo(m));
    }
  }, [ready, territories, points, selectedId, colors, labelStatuses]);

  // Fit to the territories when they first arrive (and when fitKey changes).
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const key = fitKey ?? 'initial';
    if (fitted.current === key) return;
    const sel = selectedId ? territories.filter((t) => t.id === selectedId) : [];
    const pool = fitStatuses ? territories.filter((t) => fitStatuses.includes(t.status)) : territories;
    const b = bboxOf(sel.length && fitKey?.startsWith('sel:') ? sel : pool.length ? pool : territories, sel.length && fitKey?.startsWith('sel:') ? [] : points);
    if (!b) return;
    fitted.current = key;
    // Extra side padding keeps the name labels (HTML markers centred on each territory) inside the frame.
    m.fitBounds(b, { padding: { top: 48, bottom: 48, left: 90, right: 90 }, maxZoom: 11, duration: 0 });
  }, [ready, territories, points, fitKey, selectedId]);

  // The polygon being drawn.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    const closed = draft.length >= 3 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...draft, draft[0]!]] } }] : [];
    const line = draft.length >= 2 && draft.length < 3 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: draft } }] : [];
    (m.getSource('draft') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [...closed, ...line, ...draft.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: p } }))] });
  }, [ready, draft, drawing]);

  return (
    <div className={className} style={{ position: 'relative' }}>
      <div ref={el} role="region" aria-label={label} style={{ position: 'absolute', inset: 0, borderRadius: 12, overflow: 'hidden', background: '#EEF1EC' }} />
      {config.kind === 'outline' && outlineNote && !failed && (
        <span style={{ position: 'absolute', left: 8, bottom: 8, background: 'rgba(255,255,255,.9)', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600, color: '#57534E' }}>{outlineNote}</span>
      )}
    </div>
  );
}
