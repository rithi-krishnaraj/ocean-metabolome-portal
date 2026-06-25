/**
 * api.js – thin wrapper around the backend REST API.
 * All fetch calls live here; the rest of the app never touches URLs directly.
 */

const BASE = '';   // same-origin: Flask serves both the API and this file

export async function fetchLocations(filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const resp = await fetch(`${BASE}/api/locations${qs ? '?' + qs : ''}`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

export async function fetchStats() {
  const resp = await fetch(`${BASE}/api/stats`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

export async function fetchFilterOptions() {
  const resp = await fetch(`${BASE}/api/filters`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

export async function fetchMetabolitePoints(filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const resp = await fetch(`${BASE}/api/metabolite-points${qs ? '?' + qs : ''}`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}
