/**
 * main.js - entry point for the Ocean Metabolome Portal.
 * Wires together MapRenderer (Leaflet 2D), UIController (DOM) and the API client.
 * No rendering logic and no direct fetch calls belong here.
 */

import { MapRenderer }  from './map.js';
import { UIController } from './ui.js';
import { fetchMetabolitePoints } from './api.js';

async function main() {
  // 1. Instantiate the UI controller (pure DOM, no data yet)
  const ui = new UIController({
    onFilterChange:    filters => applyFilters(filters),
    onColorModeChange: mode    => applyColorMode(mode),
    onMapModeChange:   mode    => applyMapMode(mode),
  });

  let currentMode = 'metabolite';
  let currentFilters = {};
  let currentColorMode = '';

  ui.setLoadingMessage('Initialising map...');

  // 2. Instantiate the 2D Leaflet map
  const container = document.getElementById('globe-wrap');
  const map       = new MapRenderer(container);

  // Wire up interaction callbacks
  map.onHover = (loc, x, y) => {
    if (loc) {
      ui.showTooltip(loc, x, y);
    } else {
      ui.hideTooltip();
    }
  };

  map.onClick = loc => {
    ui.openInfoPanel(loc);
    ui.hideDragHint();
  };

  // 3. Fetch data from the backend
  ui.setLoadingMessage('Loading sample data...');
  try {
    const points = await fetchMetabolitePoints();
    map.setMapMode(currentMode);
    map.updateMetabolites(points);
    ui.updateLegend(map.getLegend());
    ui.updateResultCount(points.length, points.length, currentMode);
  } catch (err) {
    console.error('Failed to load data from backend:', err);
    ui.setLoadingMessage('Could not connect to backend - showing empty map.');
    await delay(2000);
  }

  ui.hideLoading();

  // Fade out hint after 4 s
  setTimeout(() => ui.hideDragHint(), 4000);

  // Filter handler - re-fetches from backend with active filters
  async function applyFilters(filters) {
    currentFilters = filters;
    await reloadMapData();
  }

  async function applyMapMode(mode) {
    currentMode = (mode === 'location') ? 'location' : 'metabolite';
    map.setMapMode(currentMode);
    await reloadMapData();
  }

  async function reloadMapData() {
    try {
      const query = { ...currentFilters };
      query.color_by = currentColorMode;
      const points = await fetchMetabolitePoints(query);
      map.updateMetabolites(points);
      ui.updateLegend(map.getLegend());
      ui.updateResultCount(points.length, points.length, currentMode);
      ui.closeInfoPanel();
    } catch (err) {
      console.error('Filter error:', err);
    }
  }

  // Colour mode handler - re-colours existing markers, no new fetch needed
  function applyColorMode(mode) {
    currentColorMode = mode;
    map.setColorMode(mode);
    reloadMapData();
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main();
