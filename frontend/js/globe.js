/**
 * globe.js – WebGL globe renderer built on Three.js.
 *
 * Responsibilities:
 *   • Create and manage the Three.js scene, camera, renderer
 *   • Render the Earth globe with textures + atmospheric glow
 *   • Render sample locations as glowing instanced point clouds
 *   • Handle mouse interaction (hover tooltip, click selection)
 *   • Expose a clean API for the rest of the app (updateData, setColorMode, …)
 *
 * No backend calls, no UI string-building lives here.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── CDN texture URLs (NASA Blue Marble via unpkg/three-globe) ──────────────
const TEX = {
  day:   'https://unpkg.com/three-globe@2.31.1/example/img/earth-blue-marble.jpg',
  bump:  'https://unpkg.com/three-globe@2.31.1/example/img/earth-topology.png',
  water: 'https://unpkg.com/three-globe@2.31.1/example/img/earth-water.png',
};

const GLOBE_R = 1.0;

// ── Ecosystem colour palette ───────────────────────────────────────────────
const ECO_COLORS = {
  'Coastal':     '#00b4d8',
  'Open Ocean':  '#0077b6',
  'Estuarine':   '#06d6a0',
  'Coral Reef':  '#f72585',
  'Mangrove':    '#7b2d8b',
  'SAMPLE':      '#ffd60a',
  'default':     '#90e0ef',
};

// Year range used for colour gradient
const YEAR_MIN = 2008;
const YEAR_MAX = 2026;

// ── Atmosphere shaders ─────────────────────────────────────────────────────
const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ATMO_FRAG = /* glsl */ `
  uniform vec3 glowColor;
  varying vec3 vNormal;
  void main() {
    float intensity = pow(0.70 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.8);
    gl_FragColor = vec4(glowColor * intensity, intensity * 0.9);
  }
`;


// ─────────────────────────────────────────────────────────────────────────────

export class GlobeRenderer {
  /**
   * @param {HTMLElement} container  – the canvas will be appended here
   */
  constructor(container) {
    this._container = container;
    this._locations = [];
    this._colorMode = 'ecosystem';  // 'ecosystem' | 'year' | 'region'
    this._clock = new THREE.Clock();
    this._mouse = new THREE.Vector2(-9999, -9999);
    this._raycaster = new THREE.Raycaster();
    this._dummy = new THREE.Object3D();

    // Meshes holding sample points
    this._innerMesh = null;
    this._glowMesh  = null;
    this._hitMesh   = null;

    // Callbacks set by ui.js
    this.onHover  = null;   // (location | null, mouseX, mouseY) => void
    this.onClick  = null;   // (location) => void

    this._build();
    this._animate();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Replace all rendered sample points with *locations* (from the API). */
  updateData(locations) {
    this._locations = locations;
    this._rebuildPoints();
  }

  /** Change the colour-coding mode and re-colour existing points. */
  setColorMode(mode) {
    this._colorMode = mode;
    this._rebuildPoints();
  }

  /** Returns a plain array describing the current legend entries. */
  getLegend() {
    if (this._colorMode === 'ecosystem') {
      const seen = new Set(this._locations.flatMap(l => l.ecosystems));
      return [...seen].map(eco => ({
        label: eco || 'Unknown',
        color: this._ecoColor(eco),
      }));
    }
    if (this._colorMode === 'year') {
      return [
        { label: String(YEAR_MIN), color: this._yearColor(YEAR_MIN) },
        { label: '↓', color: '#ffffff' },
        { label: String(YEAR_MAX), color: this._yearColor(YEAR_MAX) },
      ];
    }
    return [];
  }

  // ── Scene construction ────────────────────────────────────────────────────

  _build() {
    const W = this._container.clientWidth;
    const H = this._container.clientHeight;

    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(W, H);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._container.appendChild(this._renderer.domElement);
    this._renderer.domElement.id = 'globe-canvas';

    // Scene
    this._scene = new THREE.Scene();

    // Camera
    this._camera = new THREE.PerspectiveCamera(45, W / H, 0.05, 200);
    this._camera.position.set(0, 0, 2.8);

    // Lighting
    this._scene.add(new THREE.AmbientLight(0x111122, 2.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(5, 3, 5);
    this._scene.add(sun);

    // Build scene objects
    this._addStars();
    this._addGlobe();
    this._addAtmosphere();

    // Controls
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping  = true;
    this._controls.dampingFactor  = 0.06;
    this._controls.minDistance    = 1.25;
    this._controls.maxDistance    = 6.0;
    this._controls.rotateSpeed    = 0.45;
    this._controls.autoRotate     = true;
    this._controls.autoRotateSpeed = 0.4;

    // Pause auto-rotate while user drags
    this._controls.addEventListener('start', () => {
      this._controls.autoRotate = false;
    });

    // Resize handler
    window.addEventListener('resize', () => this._onResize());

    // Mouse tracking
    this._renderer.domElement.addEventListener('mousemove', e => this._onMouseMove(e));
    this._renderer.domElement.addEventListener('click',     e => this._onMouseClick(e));
  }

  _addStars() {
    const positions = [];
    for (let i = 0; i < 7000; i++) {
      const r     = 50 + Math.random() * 50;
      const phi   = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      positions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this._scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.07,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
    })));
  }

  _addGlobe() {
    const loader  = new THREE.TextureLoader();
    const earthGeo = new THREE.SphereGeometry(GLOBE_R, 72, 72);

    this._earthMat = new THREE.MeshPhongMaterial({
      map:         loader.load(TEX.day),
      bumpMap:     loader.load(TEX.bump),
      bumpScale:   0.012,
      specularMap: loader.load(TEX.water),
      specular:    new THREE.Color(0x1a3355),
      shininess:   18,
    });

    this._globeGroup = new THREE.Group();
    this._globeGroup.add(new THREE.Mesh(earthGeo, this._earthMat));
    this._scene.add(this._globeGroup);
  }

  _addAtmosphere() {
    const geo = new THREE.SphereGeometry(GLOBE_R * 1.09, 64, 64);
    const mat = new THREE.ShaderMaterial({
      vertexShader:   ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: { glowColor: { value: new THREE.Color(0x0088cc) } },
      blending:    THREE.AdditiveBlending,
      side:        THREE.BackSide,
      transparent: true,
      depthWrite:  false,
    });
    this._scene.add(new THREE.Mesh(geo, mat));
  }

  // ── Point cloud ───────────────────────────────────────────────────────────

  _rebuildPoints() {
    // Dispose previous meshes
    for (const m of [this._innerMesh, this._glowMesh, this._hitMesh]) {
      if (m) {
        this._globeGroup.remove(m);
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach(x => x.dispose());
        else m.material.dispose();
      }
    }
    this._innerMesh = this._glowMesh = this._hitMesh = null;

    const locs = this._locations;
    if (!locs.length) return;

    const count = locs.length;

    // MeshBasicMaterial with vertexColors:true is the correct way to use
    // InstancedMesh.setColorAt() – Three.js injects instanceColor automatically.
    const innerMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    // Outer glow layer – opacity is animated each frame for the pulse effect.
    const glowMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent:  true,
      opacity:      0.35,
      blending:     THREE.AdditiveBlending,
      depthWrite:   false,
    });
    // Invisible hit-detection mesh (larger spheres for easier clicking)
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });

    const innerGeo = new THREE.SphereGeometry(0.013, 7, 7);
    const glowGeo  = new THREE.SphereGeometry(0.028, 7, 7);
    const hitGeo   = new THREE.SphereGeometry(0.040, 4, 4);

    this._innerMesh = new THREE.InstancedMesh(innerGeo, innerMat, count);
    this._glowMesh  = new THREE.InstancedMesh(glowGeo,  glowMat,  count);
    this._hitMesh   = new THREE.InstancedMesh(hitGeo,   hitMat,   count);

    this._innerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    locs.forEach((loc, i) => {
      const pos   = this._latLonToVec3(loc.lat, loc.lon, GLOBE_R + 0.012);
      const scale = 0.55 + Math.log10(loc.count + 1) * 0.6;
      const color = new THREE.Color(this._getColor(loc));

      this._dummy.position.copy(pos);
      this._dummy.lookAt(0, 0, 0);
      this._dummy.scale.setScalar(scale);
      this._dummy.updateMatrix();

      this._innerMesh.setMatrixAt(i, this._dummy.matrix);
      this._glowMesh.setMatrixAt(i, this._dummy.matrix);
      this._hitMesh.setMatrixAt(i, this._dummy.matrix);

      this._innerMesh.setColorAt(i, color);
      this._glowMesh.setColorAt(i, color);
    });

    this._innerMesh.instanceMatrix.needsUpdate = true;
    this._glowMesh.instanceMatrix.needsUpdate  = true;
    this._hitMesh.instanceMatrix.needsUpdate   = true;
    this._innerMesh.instanceColor.needsUpdate  = true;
    this._glowMesh.instanceColor.needsUpdate   = true;

    this._globeGroup.add(this._innerMesh, this._glowMesh, this._hitMesh);
  }

  // ── Colour helpers ────────────────────────────────────────────────────────

  _getColor(loc) {
    if (this._colorMode === 'year') {
      const yr = parseInt(loc.years?.[0]) || YEAR_MIN;
      return this._yearColor(yr);
    }
    if (this._colorMode === 'region') {
      return this._strToHue(loc.regions?.[0] || '');
    }
    // default: ecosystem
    const eco = loc.ecosystems?.[0] || 'default';
    return this._ecoColor(eco);
  }

  _ecoColor(eco) {
    return ECO_COLORS[eco] || ECO_COLORS['default'];
  }

  _yearColor(year) {
    const t = Math.max(0, Math.min(1, (year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)));
    // Cold blue → warm orange-red
    const r = Math.round(30  + t * 220);
    const g = Math.round(120 - t * 80);
    const b = Math.round(220 - t * 200);
    return `rgb(${r},${g},${b})`;
  }

  _strToHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    return `hsl(${Math.abs(h) % 360}, 70%, 60%)`;
  }

  // ── Coordinate conversion ─────────────────────────────────────────────────

  _latLonToVec3(lat, lon, r = GLOBE_R) {
    const phi   = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta),
    );
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  _toNDC(e) {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._mouse.set(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );
  }

  _onMouseMove(e) {
    this._toNDC(e);
    if (!this._hitMesh) {
      if (this.onHover) this.onHover(null, e.clientX, e.clientY);
      return;
    }
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const hits = this._raycaster.intersectObject(this._hitMesh);
    if (hits.length > 0) {
      const loc = this._locations[hits[0].instanceId];
      if (this.onHover) this.onHover(loc, e.clientX, e.clientY);
    } else {
      if (this.onHover) this.onHover(null, e.clientX, e.clientY);
    }
  }

  _onMouseClick(e) {
    if (!this._hitMesh) return;
    this._toNDC(e);
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const hits = this._raycaster.intersectObject(this._hitMesh);
    if (hits.length > 0) {
      const loc = this._locations[hits[0].instanceId];
      if (loc && this.onClick) this.onClick(loc);
    }
  }

  _onResize() {
    const W = this._container.clientWidth;
    const H = this._container.clientHeight;
    this._camera.aspect = W / H;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(W, H);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _animate() {
    requestAnimationFrame(() => this._animate());
    const t = this._clock.getElapsedTime();
    // Pulse the outer glow opacity
    if (this._glowMesh) {
      this._glowMesh.material.opacity = 0.20 + Math.sin(t * 2.2) * 0.14;
    }
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }
}

// Export the colour palette so ui.js can build the legend without coupling.
export { ECO_COLORS };
