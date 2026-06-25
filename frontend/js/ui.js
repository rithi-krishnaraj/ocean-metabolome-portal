/**
 * ui.js – all DOM manipulation and UI state.
 * Consumes data from api.js and globe.js; owns no fetch/WebGL calls itself.
 */

// ─────────────────────────────────────────────────────────────────────────────

export class UIController {
  /**
   * @param {{ onFilterChange: Function, onColorModeChange: Function, onMapModeChange: Function }} handlers
   */
  constructor({ onFilterChange, onColorModeChange, onMapModeChange }) {
    this._onFilterChange     = onFilterChange;
    this._onColorModeChange  = onColorModeChange;
    this._onMapModeChange    = onMapModeChange;
    this._currentFilters     = {};
    this._filterOptions      = {};
    this._metadataValues     = {};

    this._bindTopbar();
    this._bindFilterPanel();
    this._bindInfoPanel();
    this._bindColorMode();
    this._makeDraggable(document.getElementById('legend'));
    this._bindLegendToggle();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Populate filter dropdowns from /api/filters response. */
  populateFilters(options) {
    this._filterOptions = options;
    this._metadataValues = options.metadata_values || {};

    this._fillSelect('filter-region',       options.regions,       'All Regions');
    this._fillSelect('filter-year',         options.years,         'All Years');
    this._fillSelect('filter-ecosystem',    options.ecosystems,    'All Ecosystems');
    this._fillSelect('filter-depth-bucket', options.depth_buckets, 'All Depths');

    // Dataset filter
    const dsEl = document.getElementById('filter-dataset');
    dsEl.innerHTML = '<option value="">All Datasets</option>';
    (options.datasets || []).forEach(ds => {
      const opt = document.createElement('option');
      opt.value       = ds.id;
      opt.textContent = ds.name;
      dsEl.appendChild(opt);
    });

    this._fillSelect('filter-metadata-key', options.metadata_categories, 'All Metadata Categories');
    this._fillSelect('filter-metadata-value', [], 'All Values');
  }

  populateColorModes(options) {
    const el = document.getElementById('color-mode');
    if (!el) return;
    const current = el.value;
    const base = [
      { value: 'ecosystem', label: 'Ecosystem' },
      { value: 'year', label: 'Year' },
      { value: 'region', label: 'Region' },
    ];
    const meta = (options?.metadata_categories || []).map(c => ({ value: c, label: c }));
    el.innerHTML = '';
    [...base, ...meta].forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      el.appendChild(opt);
    });
    el.value = [...base, ...meta].some(i => i.value === current) ? current : 'ecosystem';
  }

  /** Update the topbar global stats. */
  updateStats(stats) {
    this._set('gstat-samples',   stats.total_samples   ?? '—');
    this._set('gstat-locations', stats.total_locations ?? '—');
    this._set('gstat-datasets',  stats.total_datasets  ?? '—');
  }

  /** Update the small count indicator at the bottom of the filter panel. */
  updateResultCount(locationCount, sampleCount, mapMode = 'location') {
    const el = document.getElementById('result-count');
    if (el) {
      if (mapMode === 'metabolite') {
        el.innerHTML = `<strong>${locationCount}</strong> metabolite points · <strong>${sampleCount}</strong> intensity records`;
      } else {
        el.innerHTML = `<strong>${locationCount}</strong> locations · <strong>${sampleCount}</strong> samples`;
      }
    }
  }

  /** Show the tooltip near the mouse. */
  showTooltip(loc, x, y) {
    const el = document.getElementById('tooltip');
    el.classList.add('show');
    if (loc.metabolite_name) {
      el.textContent = `${loc.metabolite_name} · intensity ${Number(loc.intensity || 0).toExponential(2)}`;
    } else {
      el.textContent = `${loc.descriptors?.[0] || loc.regions?.[0] || 'Location'} · ${loc.count} samples`;
    }
    // Position slightly above the cursor
    el.style.left = `${x + 12}px`;
    el.style.top  = `${y - 28}px`;
  }

  hideTooltip() {
    document.getElementById('tooltip').classList.remove('show');
  }

  /** Populate the right-hand info panel and slide it open. */
  openInfoPanel(loc) {
    const panel = document.getElementById('info-panel');

    if (loc.metabolite_name) {
      this._set('info-title', 'Metabolite Observation');
      this._renderKV('info-kv', [
        ['Metabolite', loc.metabolite_name],
        ['Intensity', Number(loc.intensity || 0).toExponential(4), true],
        ['Dataset', loc.dataset_name || '—'],
        ['Sample', loc.sample_name || '—'],
        ['Coordinates', `${Number(loc.lat).toFixed(4)}°, ${Number(loc.lon).toFixed(4)}°`],
        ['Region', loc.region || '—'],
        ['Ecosystem', loc.ecosystem || '—'],
        ['Year', loc.year || '—'],
        ['Depth bucket', loc.depth_bucket || '—'],
        ['Color category', loc.color_value || '—'],
      ]);
      this._renderTags('info-batches', []);
      this._renderLinks('info-links', []);
      panel.classList.add('open');
      return;
    }

    this._set('info-title', loc.descriptors?.[0] || loc.regions?.[0] || 'Sample Location');

    // Key-value rows
    this._renderKV('info-kv', [
      ['Coordinates',   `${loc.lat.toFixed(4)}°, ${loc.lon.toFixed(4)}°`],
      ['Samples',        loc.count, true],
      ['Region',         (loc.regions || []).join(', ')     || '—'],
      ['Ecosystem',      (loc.ecosystems || []).join(', ')  || '—'],
      ['Years',          (loc.years || []).join(', ')       || '—'],
      ['Depth bucket',   (loc.depth_buckets || []).join(', ') || '—'],
      ...(loc.depth_mean != null ? [['Depth (mean)', `${loc.depth_mean} m`]] : []),
      ...(loc.depth_min  != null ? [['Depth range',  `${loc.depth_min}–${loc.depth_max} m`]] : []),
      ['Dataset(s)',     (loc.datasets || []).join(', ')    || '—'],
    ]);

    // Batch tags
    this._renderTags('info-batches', loc.batches);

    // MassIVE / GNPS links
    this._renderLinks('info-links', loc.massive_ids);

    panel.classList.add('open');
  }

  closeInfoPanel() {
    document.getElementById('info-panel').classList.remove('open');
  }

  /** Build the colour legend at the bottom from globe.getLegend(). */
  updateLegend(entries) {
    const legend = document.getElementById('legend');
    const items  = legend.querySelector('.leg-items');
    if (!items) return;

    items.innerHTML = '';
    entries.forEach(({ label, color }) => {
      const div = document.createElement('div');
      div.className = 'leg-item';
      div.innerHTML = `<span class="leg-dot" style="background:${color};color:${color}"></span>
                       <span>${label}</span>`;
      items.appendChild(div);
    });
  }

  /** Hide the loading overlay. */
  hideLoading() {
    const el = document.getElementById('loading');
    if (el) {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 700);
    }
  }

  /** Update loading message. */
  setLoadingMessage(msg) {
    const el = document.getElementById('loader-msg');
    if (el) el.textContent = msg;
  }

  /** Fade out and remove the drag hint after first interaction. */
  hideDragHint() {
    const el = document.getElementById('drag-hint');
    if (el) {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 1200);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _bindTopbar() {
    // The toggle for the filter panel
    const toggle = document.getElementById('panel-toggle');
    const panel  = document.getElementById('filter-panel');
    if (toggle && panel) {
      toggle.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        toggle.style.left = panel.classList.contains('collapsed') ? '0px' : '240px';
        toggle.title      = panel.classList.contains('collapsed') ? 'Show filters' : 'Hide filters';
        toggle.textContent = panel.classList.contains('collapsed') ? '›' : '‹';
      });
    }
  }

  _bindFilterPanel() {
    const metadataKeyEl = document.getElementById('filter-metadata-key');
    metadataKeyEl?.addEventListener('change', () => {
      const selected = metadataKeyEl.value;
      const vals = selected ? (this._metadataValues[selected] || []) : [];
      this._fillSelect('filter-metadata-value', vals, 'All Values');
    });

    document.getElementById('apply-filters')?.addEventListener('click', () => {
      this._currentFilters = {
        region:       this._val('filter-region'),
        year:         this._val('filter-year'),
        ecosystem:    this._val('filter-ecosystem'),
        depth_bucket: this._val('filter-depth-bucket'),
        dataset_id:   this._val('filter-dataset'),
        metadata_key: this._val('filter-metadata-key'),
        metadata_value: this._val('filter-metadata-value'),
      };
      this._onFilterChange(this._currentFilters);
    });

    document.getElementById('reset-filters')?.addEventListener('click', () => {
      ['filter-region','filter-year','filter-ecosystem','filter-depth-bucket','filter-dataset','filter-metadata-key','filter-metadata-value']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      this._fillSelect('filter-metadata-value', [], 'All Values');
      this._currentFilters = {};
      this._onFilterChange({});
    });
  }

  _bindInfoPanel() {
    document.getElementById('close-info')?.addEventListener('click', () => {
      this.closeInfoPanel();
    });
  }

  _bindColorMode() {
    document.getElementById('color-mode')?.addEventListener('change', e => {
      this._onColorModeChange(e.target.value);
    });
    document.getElementById('map-mode')?.addEventListener('change', e => {
      this._onMapModeChange(e.target.value);
    });
  }

  _fillSelect(id, values, placeholder) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${placeholder}</option>`;
    (values || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = v;
      el.appendChild(opt);
    });
  }

  _renderKV(id, rows) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    rows.forEach(([k, v, highlight]) => {
      const kEl = document.createElement('div');
      kEl.className = 'k';
      kEl.textContent = k;
      const vEl = document.createElement('div');
      vEl.className = `v${highlight ? ' highlight' : ''}`;
      vEl.textContent = v ?? '—';
      el.appendChild(kEl);
      el.appendChild(vEl);
    });
  }

  _renderTags(id, items) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    if (!items?.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'tag-list';
    items.forEach(t => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      wrap.appendChild(span);
    });
    el.appendChild(wrap);
  }

  _renderLinks(id, massiveIds) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    (massiveIds || []).forEach(mid => {
      if (!mid || mid === 'nan') return;
      const a = document.createElement('a');
      a.className = 'gnps-link';
      a.href = `https://gnps2.org/datasetsummary?task=${encodeURIComponent(mid)}`;
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      a.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg> ${mid}`;
      el.appendChild(a);
    });
  }

  _set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  _val(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  _bindLegendToggle() {
    const btn = document.querySelector('#legend .leg-toggle');
    if (!btn) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('legend').classList.toggle('collapsed');
    });
  }

  /** Make any fixed-position element draggable, constrained to the map area. */
  _makeDraggable(el) {
    if (!el) return;
    let startX, startY, startLeft, startTop, zoomRect, mapBounds;

    el.addEventListener('pointerdown', e => {
      // Don't intercept scroll list or the collapse toggle button
      if (e.target.closest('.leg-items') || e.target.closest('.leg-toggle')) return;

      // Convert current position to top/left so we can freely drag
      const rect = el.getBoundingClientRect();
      el.style.left   = `${rect.left}px`;
      el.style.top    = `${rect.top}px`;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';

      startX    = e.clientX;
      startY    = e.clientY;
      startLeft = rect.left;
      startTop  = rect.top;

      // Snapshot zoom control bounds for collision avoidance
      const zoomEl = document.querySelector('.leaflet-control-zoom');
      zoomRect = zoomEl ? zoomEl.getBoundingClientRect() : null;

      // Snapshot map-area bounds (legend must stay inside these)
      const topbarEl = document.getElementById('topbar');
      const filterEl = document.getElementById('filter-panel');
      const infoEl   = document.getElementById('info-panel');
      mapBounds = {
        top:    topbarEl ? topbarEl.getBoundingClientRect().bottom : 56,
        left:   (filterEl && !filterEl.classList.contains('collapsed'))
                  ? filterEl.getBoundingClientRect().right : 0,
        right:  window.innerWidth  - ((infoEl && infoEl.classList.contains('open'))
                  ? infoEl.getBoundingClientRect().width : 0),
        bottom: window.innerHeight,
      };

      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
      if (!el.classList.contains('dragging')) return;

      const legW = el.offsetWidth;
      const legH = el.offsetHeight;

      // Clamp to map area
      let newLeft = Math.max(mapBounds.left,
                    Math.min(mapBounds.right  - legW, startLeft + e.clientX - startX));
      let newTop  = Math.max(mapBounds.top,
                    Math.min(mapBounds.bottom - legH, startTop  + e.clientY - startY));

      // Collision avoidance: push legend out of zoom-control bounds
      if (zoomRect) {
        const overlapsX = newLeft < zoomRect.right  && newLeft + legW > zoomRect.left;
        const overlapsY = newTop  < zoomRect.bottom && newTop  + legH > zoomRect.top;
        if (overlapsX && overlapsY) {
          const pushUp    = newTop  + legH - zoomRect.top;
          const pushDown  = zoomRect.bottom - newTop;
          const pushLeft  = newLeft + legW  - zoomRect.left;
          const pushRight = zoomRect.right  - newLeft;
          const min = Math.min(pushUp, pushDown, pushLeft, pushRight);
          if      (min === pushUp)   newTop  = zoomRect.top    - legH;
          else if (min === pushDown) newTop  = zoomRect.bottom;
          else if (min === pushLeft) newLeft = zoomRect.left   - legW;
          else                       newLeft = zoomRect.right;
        }
      }

      el.style.left = `${newLeft}px`;
      el.style.top  = `${newTop}px`;
    });

    el.addEventListener('pointerup',    () => el.classList.remove('dragging'));
    el.addEventListener('pointercancel',() => el.classList.remove('dragging'));
  }
}
