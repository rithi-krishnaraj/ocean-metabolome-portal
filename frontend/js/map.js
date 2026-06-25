/**
 * map.js – 2D Leaflet world map renderer.
 * Exposes the same public API as globe.js so main.js needs minimal changes.
 *
 * Leaflet is loaded via CDN <script> tag in index.html and accessed as window.L.
 * No Three.js dependency.
 */

/* global L */

// ── Ecosystem colour palette (shared with ui.js via export) ───────────────
const ECO_COLORS = {
  'Coastal':     '#00b4d8',
  'Open Ocean':  '#0077b6',
  'Estuarine':   '#06d6a0',
  'Coral Reef':  '#f72585',
  'Mangrove':    '#7b2d8b',
  'SAMPLE':      '#ffd60a',
  'default':     '#90e0ef',
};

const YEAR_MIN = 2008;
const YEAR_MAX = 2026;

// ─────────────────────────────────────────────────────────────────────────────

export class MapRenderer {
  /**
   * @param {HTMLElement} container – Leaflet map is initialised inside this element
   */
  constructor(container) {
    this._container  = container;
    this._locations  = [];
    this._metabolites = [];
    this._mapMode = 'metabolite';
    this._colorMode  = 'ecosystem';
    this._layerGroup = null;

    // Set by main.js after construction
    this.onHover = null;   // (location | null, clientX, clientY) => void
    this.onClick = null;   // (location) => void

    this._build();
  }

  // ── Public API (mirrors GlobeRenderer) ────────────────────────────────────

  /** Replace all markers with new location data from the API. */
  updateData(locations) {
    this._locations = locations;
    this._mapMode = 'location';
    this._renderMarkers();
  }

  /** Replace all markers with new metabolite point data from the API. */
  updateMetabolites(points) {
    this._metabolites = points;
    this._mapMode = 'metabolite';
    this._renderMarkers();
  }

  setMapMode(mode) {
    this._mapMode = (mode === 'location') ? 'location' : 'metabolite';
    this._renderMarkers();
  }

  /** Recolour all markers without re-fetching data. */
  setColorMode(mode) {
    this._colorMode = mode;
    this._renderMarkers();
  }

  /** Return entries for the legend panel. */
  getLegend() {
    if (this._mapMode === 'metabolite') {
      if (this._colorMode === 'year') {
        const years = [...new Set(this._metabolites.map(p => Number(p.year)))].filter(y => !isNaN(y)).sort((a, b) => a - b);
        return years.map(y => ({ label: String(y), color: this._yearColor(y) }));
      }
      const values = [...new Set(this._metabolites.map(p => p.color_value || 'Unknown'))]
        .filter(Boolean)
        .slice(0, 40)
        .sort((a, b) => a.localeCompare(b));
      return values.map(v => ({
        label: v,
        color: this._colorMode === 'ecosystem'
          ? (ECO_COLORS[v] || ECO_COLORS['default'])
          : this._strToHue(v),
      }));
    }

    if (this._colorMode === 'ecosystem') {
      const seen = new Set(this._locations.flatMap(l => l.ecosystems || []));
      return [...seen].filter(Boolean).sort().map(eco => ({
        label: eco,
        color: ECO_COLORS[eco] || ECO_COLORS['default'],
      }));
    }
    if (this._colorMode === 'year') {
      // All actual years present in the current data, sorted ascending
      const years = [...new Set(
        this._locations.flatMap(l => l.years || [])
      )].filter(Boolean).map(Number).filter(y => !isNaN(y)).sort((a, b) => a - b);
      return years.map(y => ({ label: String(y), color: this._yearColor(y) }));
    }
    if (this._colorMode === 'region') {
      const seen = new Set(this._locations.flatMap(l => l.regions || []));
      return [...seen].filter(Boolean).sort().map(r => ({
        label: r,
        color: this._strToHue(r),
      }));
    }
    return [];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _build() {
    const L = window.L;

    this._map = L.map(this._container, {
      center:        [20, 0],
      zoom:          2,
      minZoom:       1,
      maxZoom:       19,
      zoomControl:   false,
      worldCopyJump: true,
      // Canvas renderer is faster for many circle markers
      preferCanvas:  true,
    });

    // Zoom control bottom-right, legend is stacked above it
    L.control.zoom({ position: 'bottomright' }).addTo(this._map);

    // Esri Ocean basemap – bathymetric blue water, natural green/brown land
    // maxNativeZoom:13 tells Leaflet the server's tile limit; it upscales beyond that
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles &copy; <a href="https://www.esri.com" target="_blank">Esri</a>'
          + ', Esri, DeLorme, GEBCO, NOAA NGDC, and other contributors',
        maxNativeZoom: 13,
        maxZoom:       19,
      }
    ).addTo(this._map);

    // Label overlay – country, ocean, continent and city names; no depth soundings
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '',
        maxZoom:     19,
        pane: 'shadowPane',   // renders above basemap, below markers
      }
    ).addTo(this._map);

    // High-detail overlay: Esri World Topo Map (zoom 14+)
    // Replaces the upscaled ocean tiles with crisp coastlines, terrain, cities
    // while keeping blue water and natural land colours at all zoom levels.
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Detail tiles &copy; <a href="https://www.esri.com" target="_blank">Esri</a>',
        minZoom: 14,
        maxZoom: 19,
      }
    ).addTo(this._map);

    this._layerGroup = L.layerGroup().addTo(this._map);
  }

  _renderMarkers() {
    if (this._mapMode === 'metabolite') {
      this._renderMetaboliteMarkers();
      return;
    }

    this._renderLocationMarkers();
  }

  _renderLocationMarkers() {
    const L = window.L;
    this._layerGroup.clearLayers();

    this._locations.forEach(loc => {
      const color  = this._getColor(loc);
      // Radius scales logarithmically with sample count (min 5 px, max ~20 px)
      const radius = 5 + Math.log10(loc.count + 1) * 5;

      const marker = L.circleMarker([loc.lat, loc.lon], {
        radius,
        fillColor:   color,
        fillOpacity: 0.88,
        color:       'rgba(0,0,0,0.55)',  // dark outline – readable on light basemap
        weight:      1.5,
      });

      marker.on('mouseover', e => {
        marker.setStyle({ fillOpacity: 1, weight: 2.5, color: '#ffffff' });
        marker.bringToFront();
        if (this.onHover) {
          this.onHover(loc, e.originalEvent.clientX, e.originalEvent.clientY);
        }
      });

      marker.on('mouseout', () => {
        marker.setStyle({ fillOpacity: 0.88, weight: 1.5, color: 'rgba(0,0,0,0.55)' });
        if (this.onHover) this.onHover(null);
      });

      marker.on('click', () => {
        if (this.onClick) this.onClick(loc);
      });

      this._layerGroup.addLayer(marker);
    });
  }

  _renderMetaboliteMarkers() {
    const L = window.L;
    this._layerGroup.clearLayers();

    if (!this._metabolites.length) return;

    const intensities = this._metabolites
      .map(p => Number(p.intensity))
      .filter(v => !isNaN(v) && v > 0);
    const minI = intensities.length ? Math.min(...intensities) : 1;
    const maxI = intensities.length ? Math.max(...intensities) : 1;
    const span = Math.max(1e-9, Math.log10(maxI + 1) - Math.log10(minI + 1));

    this._metabolites.forEach(point => {
      const intensity = Number(point.intensity) || 0;
      const t = (Math.log10(intensity + 1) - Math.log10(minI + 1)) / span;
      const radius = 3 + Math.max(0, Math.min(1, t)) * 9;
      const color = this._getColor(point);

      const marker = L.circleMarker([point.lat, point.lon], {
        radius,
        fillColor: color,
        fillOpacity: 0.84,
        color: 'rgba(0,0,0,0.52)',
        weight: 1.1,
      });

      marker.on('mouseover', e => {
        marker.setStyle({ fillOpacity: 1, weight: 2.2, color: '#ffffff' });
        marker.bringToFront();
        if (this.onHover) {
          this.onHover(point, e.originalEvent.clientX, e.originalEvent.clientY);
        }
      });

      marker.on('mouseout', () => {
        marker.setStyle({ fillOpacity: 0.84, weight: 1.1, color: 'rgba(0,0,0,0.52)' });
        if (this.onHover) this.onHover(null);
      });

      marker.on('click', () => {
        if (this.onClick) this.onClick(point);
      });

      this._layerGroup.addLayer(marker);
    });
  }

  // ── Colour helpers ────────────────────────────────────────────────────────

  _getColor(loc) {
    if (this._mapMode === 'metabolite') {
      if (this._colorMode === 'year') {
        const y = parseInt(loc.year);
        return this._yearColor(isNaN(y) ? YEAR_MIN : y);
      }
      const val = loc.color_value || 'Unknown';
      if (this._colorMode === 'ecosystem') {
        return ECO_COLORS[val] || ECO_COLORS['default'];
      }
      return this._strToHue(val);
    }

    if (this._colorMode === 'year') {
      return this._yearColor(parseInt(loc.years?.[0]) || YEAR_MIN);
    }
    if (this._colorMode === 'region') {
      return this._strToHue(loc.regions?.[0] || '');
    }
    const eco = loc.ecosystems?.[0] || 'default';
    return ECO_COLORS[eco] || ECO_COLORS['default'];
  }

  _yearColor(year) {
    const t = Math.max(0, Math.min(1, (year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)));
    return `rgb(${Math.round(30 + t * 220)},${Math.round(120 - t * 80)},${Math.round(220 - t * 200)})`;
  }

  _strToHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return `hsl(${Math.abs(h) % 360}, 70%, 60%)`;
  }
}

export { ECO_COLORS };
