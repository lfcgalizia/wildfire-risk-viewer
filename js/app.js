// Printed on load so it is possible to tell from the console whether the
// browser is running the current file or a cached older copy.
const BUILD = "2026-09-29 ael-reconciled";
console.info(`[wildfire-viewer] build ${BUILD}`);

const SCENARIOS = [
  // aBP_bau, not aBP_bau2 — aBP_bau is the calibrated baseline the published
  // loss figures are built on. Must stay in step with scripts/02_compute_ael.py.
  { id: "bau",               label: "Business as usual",                          raster: "data/rasters/aBP_bau.tif" },
  { id: "primary_full",      label: "Primary fuel breaks — full removal",         raster: "data/rasters/aBP_pfb.tif" },
  { id: "primary_partial",   label: "Primary fuel breaks — partial removal",      raster: "data/rasters/aBP_pfb_partial.tif" },
  { id: "secondary_full",    label: "Secondary fuel breaks — full removal",       raster: "data/rasters/aBP_sfb.tif" },
  { id: "secondary_partial", label: "Secondary fuel breaks — partial removal",    raster: "data/rasters/aBP_sfb_partial.tif" },
  { id: "combined_full",     label: "Primary + secondary — full removal",         raster: "data/rasters/aBP_pfb_sfb.tif" },
  { id: "combined_partial",  label: "Primary + secondary — partial removal",      raster: "data/rasters/aBP_pfb_sfb_partial.tif" },
];

// Short forms for the scenario chart, where the full labels do not fit.
const SHORT_LABEL = {
  bau: "Business as usual",
  primary_full: "Primary · full",
  primary_partial: "Primary · partial",
  secondary_full: "Secondary · full",
  secondary_partial: "Secondary · partial",
  combined_full: "Combined · full",
  combined_partial: "Combined · partial",
};

const BASELINE_ID = "bau";

// Vectors are served from data/web/, not data/vectors/. The raw QGIS exports in
// data/vectors/ are not loadable as-is — fuel_breaks.geojson in particular
// declares CRS84 but holds EPSG:3763 metres, which puts it off the map.
// scripts/03_prepare_vectors.py reprojects and slims them into data/web/.
const VECTOR_DIR = "data/web";

// Opening view is a placeholder only: it is replaced by fitBounds() once the
// study area (or failing that, the first raster) loads.
const map = L.map("map", { zoomControl: true }).setView([40.6, -8.22], 10);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

// Vector overlays share one canvas renderer: buildings_risk holds ~26k
// polygons, which is far too many for Leaflet's default SVG renderer.
const vectorRenderer = L.canvas({ padding: 0.5 });

// ---------------------------------------------------------------------------
// Modes.
//
// The viewer is organised around the usual decomposition of risk:
//   hazard   — annual burn probability, a property of the landscape
//   exposure — what is standing in it, identical across scenarios
//   risk     — hazard applied to exposure, as an annual expectation
//
// `raster` picks what the grid shows, or null for the vector-led modes; in
// those the raster is taken off the map entirely so it cannot obscure the
// exposure and risk fills. `fill` picks what the exposure polygons encode.
// ---------------------------------------------------------------------------
const MODES = [
  { id: "hazard",       label: "Hazard — burn probability",  raster: "bp",    fill: null },
  { id: "hazard_delta", label: "Hazard — change vs baseline", raster: "delta", fill: null },
  { id: "exposure",     label: "Exposure — assets at risk",  raster: null,    fill: "asset" },
  { id: "risk",         label: "Risk — expected annual loss", raster: null,   fill: "ael" },
];

let currentRasterLayer = null;
let currentScenarioId = SCENARIOS[0].id;
let currentMode = MODES[0].id;
let rasterLoadToken = 0;   // guards against out-of-order scenario loads
let hasFittedBounds = false;
let stats = null;          // parsed data/web/scenario_stats.json

let buildingsLayer = null;
let forestLayer = null;
let studyAreaLayer = null;

// The fuel-break file is one collection covering both networks; its `layer`
// column names which one a polygon belongs to. The viewer splits it into two
// separately toggleable overlays so each network can be read on its own.
const FUEL_BREAK_KINDS = [
  { id: "primary_fuel_breaks",   label: "Primary fuel breaks",   color: "#6a3d9a", fillColor: "#9e6ebd" },
  { id: "secondary_fuel_breaks", label: "Secondary fuel breaks", color: "#00688b", fillColor: "#67c2d4" },
];
const fuelBreakLayers = {}; // kind id -> L.geoJSON, filled by loadVectorLayers

// Toggleable vector overlays. `visible` is the source of truth: the layers
// load asynchronously, so a box can be unticked before its layer exists.
// Order matters — applyOverlayVisibility re-adds in this order, so the study
// area outline ends up on top of the fills.
const OVERLAYS = [
  { id: "buildings",   label: "Buildings",            visible: true,  layer: () => buildingsLayer },
  { id: "forest",      label: "Planted forest",       visible: true,  layer: () => forestLayer },
  ...FUEL_BREAK_KINDS.map(k => ({
    id: k.id, label: k.label, visible: true, swatch: k.fillColor, layer: () => fuelBreakLayers[k.id],
  })),
  { id: "study_area",  label: "Study area perimeter", visible: true,  layer: () => studyAreaLayer },
];

// ---------------------------------------------------------------------------
// Colour scales.
//
// Absolute burn probability: the data runs 0–10.3% with quartiles at 1.5 / 3.2
// / 5.9%. These breaks are absolute (so scenarios stay comparable) but fitted
// to the range that actually occurs.
// ---------------------------------------------------------------------------
const BP_CLASSES = [
  { min: 0.000, max: 0.005, color: "#ffffb2" },
  { min: 0.005, max: 0.015, color: "#fed976" },
  { min: 0.015, max: 0.030, color: "#feb24c" },
  { min: 0.030, max: 0.045, color: "#fd8d3c" },
  { min: 0.045, max: 0.060, color: "#fc4e2a" },
  { min: 0.060, max: 0.075, color: "#e31a1c" },
  { min: 0.075, max: 0.090, color: "#bd0026" },
  { min: 0.090, max: Infinity, color: "#800026" },
];

// Change vs baseline, in burn probability. Deliberately one-sided: fuel breaks
// cut burn probability by up to 10 pp but never raise it by more than ~0.2 pp.
// Anything from -0.1 pp upwards — including the small increases — is therefore
// collapsed into a single transparent "No changes" class, so the map shows only
// where the treatment actually reduces risk.
const DELTA_CLASSES = [
  { min: -Infinity, max: -0.050, color: "#00441b", label: "≥ 5 pp lower" },
  { min: -0.050,    max: -0.020, color: "#238b45", label: "2–5 pp lower" },
  { min: -0.020,    max: -0.010, color: "#66c2a4", label: "1–2 pp lower" },
  { min: -0.010,    max: -0.005, color: "#b2e2e2", label: "0.5–1 pp lower" },
  { min: -0.005,    max: -0.001, color: "#edf8fb", label: "0.1–0.5 pp lower" },
  { min: -0.001,    max: Infinity, color: null,    label: "No changes" },
];

// One sequential ramp for both money scales — five ordered steps of a single
// hue, light to dark. Validated as an ordinal ramp against a white panel:
// monotone lightness, every adjacent gap >= 0.06 L, light end 2.11:1 on white.
// Exposure and risk never appear at once, so they can share it.
const VALUE_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];

// Decade breaks for expected annual loss.
const RISK_BREAKS = [1e2, 1e3, 1e4, 1e5];   // EUR/yr

// Exposure is drawn by asset kind, not by value. The inputs give every
// building one replacement cost and every hectare one stand value (the stats
// file records this), so shading by value would encode nothing but polygon
// size — the map would just be a picture of how big each stand is.
// Identity pair, validated all-pairs on white: protan ΔE 26.5, normal 29.0.
// Tritan is 7.6, inside the warn band, so the legend names both layers and
// each has its own toggle rather than leaving hue to carry it alone.
const ASSET_COLORS = { building: "#2a78d6", forest: "#008300" };

// Emphasis pair for the scenario chart: the selected scenario in the accent
// hue, the rest in a de-emphasis gray. The gray is below 3:1 on white, so
// every bar carries a visible value label rather than relying on the fill.
const CHART_ACCENT = "#2a78d6";
const CHART_MUTED  = "#c3c2b7";

function classify(classes, v) {
  for (const cls of classes) {
    if (v < cls.max) return cls;
  }
  return classes[classes.length - 1];
}

// Index into VALUE_RAMP for a monetary amount. Zero is returned as -1 so the
// caller can draw "nothing at risk" differently from "a little at risk".
function rampIndex(v, breaks) {
  if (!(v > 0)) return -1;
  let i = 0;
  while (i < breaks.length && v >= breaks[i]) i++;
  return i;
}

function isNoData(v, noDataValue) {
  return v === null || v === undefined || isNaN(v) || v === noDataValue;
}

function bpColor(v, noDataValue) {
  if (isNoData(v, noDataValue)) return null;
  if (v <= 0) return null; // non-burnable / zero probability — let the basemap show through
  return classify(BP_CLASSES, v).color;
}

function deltaColor(v, baseline, noDataValue) {
  if (isNoData(v, noDataValue) || isNoData(baseline, noDataValue)) return null;
  return classify(DELTA_CLASSES, v - baseline).color;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPct(v) {
  const pct = v * 100;
  return Number.isInteger(pct) ? `${pct}` : `${pct.toFixed(1)}`;
}

// Compact euros: the numbers on screen span 1e2 to 2e9, so a fixed unit would
// be unreadable at one end or the other.
function eur(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `€${(v / 1e9).toFixed(2)} bn`;
  if (a >= 1e6) return `€${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)} M`;
  if (a >= 1e3) return `€${(v / 1e3).toFixed(0)} k`;
  return `€${v.toFixed(0)}`;
}

function num(v, digits = 0) {
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function scenarioLabel(id) {
  const s = SCENARIOS.find(x => x.id === id);
  return s ? s.label : id;
}

function modeDef(id = currentMode) {
  return MODES.find(m => m.id === id);
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function legendRow(color, label) {
  const swatch = color
    ? `background:${color}`
    : "background:transparent;border:1px dashed #999";
  return `<div class="class">
    <span class="swatch" style="${swatch}"></span>
    <span class="label">${label}</span>
  </div>`;
}

// Labels for a decade break list, e.g. [1e3,1e4] -> "< €1 k", "€1 k–€10 k", "≥ €10 k".
function breakLabels(breaks) {
  const labels = [`< ${eur(breaks[0])}`];
  for (let i = 0; i < breaks.length - 1; i++) {
    labels.push(`${eur(breaks[i])} – ${eur(breaks[i + 1])}`);
  }
  labels.push(`≥ ${eur(breaks[breaks.length - 1])}`);
  return labels;
}

function buildLegend() {
  const el = document.getElementById("legend");
  const mode = modeDef();

  if (mode.id === "hazard_delta") {
    const rows = DELTA_CLASSES.map(cls => legendRow(cls.color, cls.label)).join("");
    el.innerHTML = `
      <strong>Change in burn probability</strong>
      <div class="sub">vs ${scenarioLabel(BASELINE_ID).toLowerCase()}</div>
      <div class="classes">${rows}</div>
      <div class="note">pp = percentage points of annual burn probability.</div>`;
    return;
  }

  if (mode.id === "exposure") {
    const b = unitValueNote("buildings"), f = unitValueNote("forest");
    el.innerHTML = `
      <strong>Assets at risk</strong>
      <div class="sub">present in every scenario</div>
      <div class="classes">
        ${legendRow(ASSET_COLORS.building, "Buildings")}
        ${legendRow(ASSET_COLORS.forest, "Planted forest")}
      </div>
      <div class="note">Shown by asset kind, not by value: the model values every
        building at ${b} and every hectare of forest at ${f}, so a value shading
        would only restate how large each polygon is.</div>`;
    return;
  }

  if (mode.id === "risk") {
    const rows = breakLabels(RISK_BREAKS)
      .map((label, i) => legendRow(VALUE_RAMP[i], label))
      .reverse()
      .join("");
    el.innerHTML = `
      <strong>Expected annual loss</strong>
      <div class="sub">euros per year, per asset</div>
      <div class="classes">${rows}</div>
      <div class="note">Burn probability × value at risk. Assets with zero modelled
        burn probability are drawn as empty outlines.</div>`;
    return;
  }

  // Highest class on top, mirroring a vertical scale bar.
  const rows = [...BP_CLASSES].reverse().map(cls => {
    const label = cls.max === Infinity
      ? `≥ ${formatPct(cls.min)}%`
      : `${formatPct(cls.min)}–${formatPct(cls.max)}%`;
    return legendRow(cls.color, label);
  }).join("");

  el.innerHTML = `
    <strong>Annual burn probability</strong>
    <div class="classes">${rows}</div>
    <div class="note">Unburnable / zero pixels are transparent.</div>`;
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

// ---------------------------------------------------------------------------
// Raster loading
// ---------------------------------------------------------------------------

// Parsed georasters are cached by URL. Each COG is ~2 MB and parsing is the
// slow part of a scenario switch; caching makes every switch after the first
// instant, and delta mode needs the baseline alongside the current scenario
// without refetching it each time.
const georasterCache = new Map();

function getGeoraster(url) {
  if (!georasterCache.has(url)) {
    georasterCache.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return parseGeoraster(await response.arrayBuffer());
    })().catch(err => {
      georasterCache.delete(url); // don't cache a failure — let a retry work
      throw err;
    }));
  }
  return georasterCache.get(url);
}

function removeRasterLayer() {
  if (currentRasterLayer) {
    map.removeLayer(currentRasterLayer);
    currentRasterLayer = null;
  }
}

async function loadScenario(scenarioId) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  if (!scenario) return;

  currentScenarioId = scenarioId;
  restyleExposureLayers(); // vectors update immediately, even if the raster is slow
  renderMetrics();

  // Each load claims a token. Fetching + parsing a 2 MB COG takes long enough
  // that a second click can start before the first finishes; without this guard
  // the slower load would win the race, add its layer last, and leave the
  // faster one orphaned on the map with no reference left to remove it.
  const token = ++rasterLoadToken;

  const wantsRaster = modeDef().raster;
  if (!wantsRaster) {
    // Exposure and risk are told by the vectors; a burn-probability grid
    // underneath them would only compete for the same pixels.
    removeRasterLayer();
    setStatus("");
    await fitOnce();
    return;
  }

  setStatus(`Loading ${scenario.label}…`);
  const baselineUrl = SCENARIOS.find(s => s.id === BASELINE_ID).raster;
  const wantsDelta = wantsRaster === "delta";

  try {
    // In delta mode both grids are needed; they are identical in size,
    // transform and CRS, so GeoRasterLayer can read them as one stack.
    const [georaster, baselineRaster] = await Promise.all([
      getGeoraster(scenario.raster),
      wantsDelta ? getGeoraster(baselineUrl) : Promise.resolve(null),
    ]);

    if (token !== rasterLoadToken) return; // a newer selection superseded this one

    const noData = georaster.noDataValue;
    const layer = new GeoRasterLayer({
      georasters: wantsDelta ? [georaster, baselineRaster] : [georaster],
      opacity: 0.85,
      resolution: 256,
      // georaster-layer-for-leaflet 4.1.2 declares its tile cache as `cache: {}`
      // on the prototype, keyed only by tile coords + resolution — so every
      // GeoRasterLayer shares one cache. A new scenario layer was handed the
      // previous scenario's canvases, and the map stayed frozen on the first
      // scenario. The georasters themselves are still cached above.
      caching: false,
      pixelValuesToColorFn: wantsDelta
        ? values => deltaColor(values[0], values[1], noData)
        : values => bpColor(values[0], noData),
    });
    layer.cache = {}; // belt and braces, in case a build ignores `caching`

    // Swap with no await in between, so exactly one raster layer is ever on the map.
    removeRasterLayer();
    currentRasterLayer = layer;
    // No bringToBack() here: GeoRasterLayer is a GridLayer in the tile pane, so
    // that call sends it *behind the OSM basemap* and the raster vanishes.
    // Vectors already sit above it in the overlay pane.
    layer.addTo(map);

    if (!hasFittedBounds) {
      map.fitBounds(layer.getBounds());
      hasFittedBounds = true;
    }

    setStatus(wantsDelta && scenarioId === BASELINE_ID
      ? "Business as usual is the baseline — no change to show."
      : "");
  } catch (err) {
    console.error("[loadScenario]", scenarioId, err);
    if (token === rasterLoadToken) setStatus(`Could not load ${scenario.label} — see console.`);
  }
}

async function fitOnce() {
  if (hasFittedBounds) return;
  const fallback = studyAreaLayer || buildingsLayer;
  if (fallback) {
    map.fitBounds(fallback.getBounds());
    hasFittedBounds = true;
  }
}

// ---------------------------------------------------------------------------
// Exposure vectors
//
// Each feature carries value_eur (buildings) or value_per_ha + area_ha
// (forest stands), plus one ael_<scenario> column per scenario.
// ---------------------------------------------------------------------------

// Buildings carry value_eur; forest stands carry value_per_ha + area_ha.
function assetKind(feature) {
  return (feature.properties || {}).value_per_ha != null ? "forest" : "building";
}

function valueAtRisk(feature) {
  const p = feature.properties || {};
  if (p.value_eur != null) return p.value_eur;
  if (p.value_per_ha != null) return p.value_per_ha * (p.area_ha ?? 0);
  return 0;
}

function ael(feature) {
  return (feature.properties || {})[`ael_${currentScenarioId}`] ?? 0;
}

// Styles for the two vector-led modes, plus a recessive style for the hazard
// modes where the raster is the subject and these are context only.
function exposureStyle(feature) {
  const mode = modeDef();
  if (!mode.fill) {
    return { color: "#5b5b57", weight: 0.6, opacity: 0.7, fill: false };
  }
  // A building footprint is ~10 m across; at the opening zoom a pixel covers
  // ~75 m, so a fill alone leaves the 26k buildings sub-pixel and effectively
  // invisible. Stroking them in their own fill colour guarantees each one
  // still marks its location.
  const isBuilding = assetKind(feature) === "building";

  if (mode.fill === "asset") {
    const c = ASSET_COLORS[assetKind(feature)];
    return {
      color: isBuilding ? c : "#333330", opacity: isBuilding ? 0.9 : 0.35,
      weight: isBuilding ? 1.4 : 0.4,
      fill: true, fillColor: c, fillOpacity: 0.8,
    };
  }

  const i = rampIndex(ael(feature), RISK_BREAKS);
  if (i < 0) {
    // Nothing at risk reads as an empty outline rather than the palest fill,
    // so "zero" is never confused with "small".
    return { color: "#9a9a95", weight: 0.5, opacity: 0.8, fill: false };
  }
  // `fill: true` must be set explicitly: Leaflet keeps whatever `fill` was last
  // applied, so a style that only sets fillColor/fillOpacity is silently
  // invisible after the hazard modes have turned fill off.
  return {
    color: isBuilding ? VALUE_RAMP[i] : "#333330", opacity: isBuilding ? 0.9 : 0.4,
    weight: isBuilding ? 1.4 : 0.4,
    fill: true, fillColor: VALUE_RAMP[i], fillOpacity: 0.85,
  };
}

function restyleExposureLayers() {
  [buildingsLayer, forestLayer].forEach(layer => {
    if (!layer) return;
    layer.eachLayer(l => l.setStyle(exposureStyle(l.feature)));
  });
  restyleFuelBreaks();
}

// Fuel breaks cover ~40% of the study area at full opacity, so in the modes
// whose subject is the exposure underneath them they drop to outlines. They
// still show where treatment happens without painting over the assets.
function fuelBreakStyle(kind) {
  const isHazardMode = modeDef().fill === null;
  return isHazardMode
    ? { color: kind.color, weight: 1, opacity: 1, fill: true, fillColor: kind.fillColor, fillOpacity: 0.75 }
    : { color: kind.color, weight: 1.1, opacity: 0.95, fill: false };
}

function restyleFuelBreaks() {
  FUEL_BREAK_KINDS.forEach(kind => {
    const layer = fuelBreakLayers[kind.id];
    if (layer) layer.setStyle(fuelBreakStyle(kind));
  });
}

// Popup content is a function so it reads the scenario and mode at open time;
// binding fresh strings to every feature on each change was the slow path.
function bindExposurePopup(kind) {
  return (feature, layer) => {
    layer.bindPopup(() => {
      const p = feature.properties || {};
      const v = valueAtRisk(feature);
      const a = ael(feature);
      const rows = [
        `<strong>${kind}</strong>`,
        kind === "Forest stand" && p.area_ha != null ? `Area: ${num(p.area_ha, 1)} ha` : null,
        `Value at risk: ${eur(v)}`,
        `Expected annual loss: ${eur(a)}`,
        v > 0 ? `Implied burn probability: ${(a / v * 100).toFixed(2)}%` : null,
        `<span class="pop-sub">${scenarioLabel(currentScenarioId)}</span>`,
      ].filter(Boolean);
      return rows.join("<br/>");
    });
  };
}

async function fetchGeoJSON(name, { optional = false } = {}) {
  const response = await fetch(`${VECTOR_DIR}/${name}.geojson`);
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`HTTP ${response.status} for ${name}.geojson`);
  }
  return response.json();
}

async function loadVectorLayers() {
  // Fetched in parallel: fuel_breaks is the largest file and awaiting it first
  // used to hold up the exposure layers behind it.
  const [fuelBreaks, buildings, forest, studyArea] = await Promise.all([
    fetchGeoJSON("fuel_breaks"),
    fetchGeoJSON("buildings_risk"),
    fetchGeoJSON("forest_risk"),
    fetchGeoJSON("study_area", { optional: true }),
  ]);

  // Fuel breaks are small polygons (~2 ha each) scattered over the whole
  // region. Unfilled hairlines were invisible at region zoom, so they get a
  // solid fill and a darker edge. One L.geoJSON per network, each reading the
  // same source collection through a `layer` filter.
  FUEL_BREAK_KINDS.forEach(kind => {
    fuelBreakLayers[kind.id] = L.geoJSON(fuelBreaks, {
      renderer: vectorRenderer,
      filter: f => (f.properties || {}).layer === kind.id,
      style: fuelBreakStyle(kind),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindPopup(
          `<strong>${kind.label.replace(/s$/, "")}</strong><br/>`
          + `Category: ${p.Categoria ?? "—"}<br/>`
          + `Type: ${p.TIPO_FGC ?? "—"}<br/>`
          + `Area: ${p.Area_ha != null ? `${Number(p.Area_ha).toFixed(2)} ha` : "—"}`
        );
      },
    });
    if (fuelBreakLayers[kind.id].getLayers().length === 0) {
      console.warn(`[vectors] no features matched layer="${kind.id}" in fuel_breaks.geojson`);
    }
  });

  buildingsLayer = L.geoJSON(buildings, {
    renderer: vectorRenderer, onEachFeature: bindExposurePopup("Building"),
  });
  forestLayer = L.geoJSON(forest, {
    renderer: vectorRenderer, onEachFeature: bindExposurePopup("Forest stand"),
  });

  if (studyArea) {
    // Outline only, on the default SVG renderer so it draws above the canvas
    // overlays and stays crisp. `interactive: false` keeps it from swallowing
    // clicks meant for the buildings underneath.
    studyAreaLayer = L.geoJSON(studyArea, {
      style: { color: "#111", weight: 2.5, opacity: 0.9, fill: false, dashArray: "6 4" },
      interactive: false,
    });
    // The perimeter is the subject of the study, so it wins the opening view
    // over the (wider) raster extent.
    map.fitBounds(studyAreaLayer.getBounds());
    hasFittedBounds = true;
  } else {
    console.info(`[vectors] ${VECTOR_DIR}/study_area.geojson not found — perimeter overlay disabled`);
  }

  restyleExposureLayers();
  applyOverlayVisibility();
}

function applyOverlayVisibility() {
  OVERLAYS.forEach(o => {
    const layer = o.layer();
    if (!layer) return;
    if (o.visible && !map.hasLayer(layer)) layer.addTo(map);
    if (!o.visible && map.hasLayer(layer)) map.removeLayer(layer);
  });
}

// ---------------------------------------------------------------------------
// Metrics panel
// ---------------------------------------------------------------------------

function scenarioStats(id = currentScenarioId) {
  return stats && stats.scenarios ? stats.scenarios[id] : null;
}

// 04_scenario_stats.py measures whether a unit value is actually constant
// across the assets, so the wording here follows the data instead of asserting
// uniformity the inputs might not have.
function unitValueNote(which) {
  const ex = stats && stats.exposure && stats.exposure[which];
  const u = ex && (which === "buildings" ? ex.unit_value_eur : ex.unit_value_eur_per_ha);
  const suffix = which === "buildings" ? "" : "/ha";
  if (!u) return "—";
  if (u.uniform) return `${eur(u.value)}${suffix}`;
  const mean = which === "buildings" ? ex.value_eur / ex.count : ex.value_eur / ex.area_ha;
  return `${eur(mean)}${suffix} on average (${u.distinct} distinct values)`;
}

// A signed change, phrased as avoided impact. Positive `saved` is an
// improvement; the sign is always written out so colour is never the only cue.
function deltaLine(saved, format, { pct = null } = {}) {
  if (saved == null || Math.abs(saved) < 1e-9) {
    return `<span class="delta delta-flat">no change vs baseline</span>`;
  }
  const better = saved > 0;
  const sign = better ? "−" : "+";
  const magnitude = format(Math.abs(saved));
  const suffix = pct == null ? "" : ` (${sign}${Math.abs(pct).toFixed(1)}%)`;
  return `<span class="delta ${better ? "delta-good" : "delta-bad"}">`
       + `${sign}${magnitude}${suffix} vs baseline</span>`;
}

// The aggregated numbers are all "one value per scenario", so each is drawn as
// its own small bar chart across the seven scenarios rather than as a lone
// figure: the comparison between scenarios is the result, and a bare number
// hides it. Every metric here is better when lower.
const METRICS = [
  {
    group: "hazard", title: "Mean burn probability", unit: "%/yr",
    get: s => s.hazard.mean_bp * 100, fmt: v => `${v.toFixed(2)}%`,
    // The gap between two percentages is percentage points, not a percentage.
    deltaFmt: v => `${v.toFixed(2)} pp`,
  },
  {
    group: "risk", title: "Buildings affected", unit: "per year",
    get: s => s.risk.buildings_affected, fmt: v => num(v, 0),
  },
  {
    group: "risk", title: "Forest burned", unit: "ha per year",
    get: s => s.risk.forest_area_burned_ha, fmt: v => `${num(v, 0)} ha`,
  },
  {
    group: "risk", title: "Expected annual loss", unit: "euros per year",
    get: s => s.risk.ael_total_eur, fmt: eur,
  },
];

// One small multiple: seven bars, the selected scenario in the accent hue and
// the rest in a de-emphasis gray. The gray sits below 3:1 on white, so every
// bar carries its value as a visible label rather than relying on the fill.
function renderMetricChart(metric) {
  const entries = SCENARIOS.map(sc => ({
    id: sc.id,
    label: SHORT_LABEL[sc.id] || sc.label,
    value: metric.get(stats.scenarios[sc.id]),
  }));
  const max = Math.max(...entries.map(e => e.value));
  const baseValue = metric.get(stats.scenarios[BASELINE_ID]);
  const current = metric.get(scenarioStats());
  const isBaseline = currentScenarioId === BASELINE_ID;

  const rows = entries.map(e => {
    const selected = e.id === currentScenarioId;
    const pct = max > 0 ? (e.value / max) * 100 : 0;
    return `<button class="bar-row${selected ? " is-selected" : ""}" data-scenario="${e.id}"
              title="${e.label} — ${metric.title}: ${metric.fmt(e.value)} ${metric.unit}">
      <span class="bar-label">${e.label}</span>
      <span class="bar-track"><span class="bar-fill"
        style="width:${pct.toFixed(1)}%;background:${selected ? CHART_ACCENT : CHART_MUTED}"></span></span>
      <span class="bar-value">${metric.fmt(e.value)}</span>
    </button>`;
  }).join("");

  const delta = isBaseline
    ? `<span class="delta delta-flat">baseline</span>`
    : deltaLine(baseValue - current, metric.deltaFmt || metric.fmt, {
        pct: baseValue ? ((baseValue - current) / baseValue) * 100 : null,
      });

  return `<div class="metric">
    <div class="metric-head">
      <span class="metric-title">${metric.title}</span>
      <span class="metric-unit">${metric.unit}</span>
    </div>
    <div class="metric-current">${metric.fmt(current)} ${delta}</div>
    <div class="chart">${rows}</div>
  </div>`;
}

// The panel lives in index.html, but a browser holding a cached copy of that
// page would have no #metrics element and the panel would silently never
// appear. Create it on demand rather than leaving the viewer looking broken.
function metricsPanel() {
  let el = document.getElementById("metrics");
  if (!el) {
    el = document.createElement("div");
    el.id = "metrics";
    document.body.appendChild(el);
    console.info("[metrics] #metrics missing from the page — created it; your index.html may be cached");
  }
  return el;
}

function renderMetrics() {
  const el = metricsPanel();

  if (!stats) {
    el.innerHTML = `<div class="panel-note">Loading scenario metrics…</div>`;
    return;
  }

  const s = scenarioStats();
  if (!s) {
    el.innerHTML = `<div class="panel-note">No metrics for this scenario.</div>`;
    return;
  }

  const r = s.risk;
  const ex = stats.exposure;
  const chartsFor = group => METRICS.filter(m => m.group === group).map(renderMetricChart).join("");

  el.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">${scenarioLabel(currentScenarioId)}</div>
      <div class="panel-sub">Annual expectation over the study area ·
        <span class="hint">click any bar to switch scenario</span></div>
    </div>

    <section class="block">
      <h3>Hazard<span class="block-def">burn probability of the landscape</span></h3>
      ${chartsFor("hazard")}
      <div class="split">${s.hazard.area_high_hazard_pct.toFixed(1)}% of the area at ≥ 5%/yr</div>
    </section>

    <section class="block">
      <h3>Exposure<span class="block-def">assets present — identical in every scenario</span></h3>
      <div class="split">
        <span class="asset-key" style="background:${ASSET_COLORS.building}"></span>
        ${num(ex.buildings.count)} buildings · ${eur(ex.buildings.value_eur)}<br/>
        <span class="asset-key" style="background:${ASSET_COLORS.forest}"></span>
        ${num(ex.forest.area_ha)} ha planted forest · ${eur(ex.forest.value_eur)}
      </div>
      <div class="panel-note inline-note">
        Valued at ${unitValueNote("buildings")} per building and
        ${unitValueNote("forest")} of forest, so exposure varies with where the
        assets are, not with what they are individually worth.
      </div>
    </section>

    <section class="block">
      <h3>Risk<span class="block-def">hazard × exposure, per year</span></h3>
      <div class="metric-grid">${chartsFor("risk")}</div>
      <div class="split">
        Loss split — buildings ${eur(r.ael_buildings_eur)} · forest ${eur(r.ael_forest_eur)}
      </div>
    </section>

    <div class="panel-note">
      “Buildings affected” is an expected count — the sum of per-building burn
      probability — not a headcount of distinct buildings.
    </div>`;

  wireChart();
}

function wireChart() {
  document.querySelectorAll(".bar-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.dataset.scenario;
      const input = document.querySelector(`input[name=scenario][value="${id}"]`);
      if (input) { input.checked = true; }
      loadScenario(id);
    });
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function buildControls() {
  const el = document.getElementById("controls");

  const modeRows = MODES.map(m =>
    `<label><input type="radio" name="mode" value="${m.id}" ${m.id === currentMode ? "checked" : ""}/> ${m.label}</label>`
  ).join("");

  const scenarioRows = SCENARIOS.map(s =>
    `<label><input type="radio" name="scenario" value="${s.id}" ${s.id === currentScenarioId ? "checked" : ""}/> ${s.label}</label>`
  ).join("");

  // Overlay order in the panel follows the legend's reading order rather than
  // OVERLAYS' draw order.
  const overlayRows = [...OVERLAYS].reverse().map(o => {
    // Overlays whose colour carries meaning get a swatch; the exposure layers
    // are a graduated ramp, so a single swatch would misrepresent them.
    const swatch = o.swatch ? `<span class="ov-swatch" style="background:${o.swatch}"></span>` : "";
    return `<label><input type="checkbox" name="overlay" value="${o.id}" ${o.visible ? "checked" : ""}/> ${swatch}${o.label}</label>`;
  }).join("");

  el.innerHTML = `
    <strong>View</strong>
    ${modeRows}
    <hr/>
    <strong>Scenario</strong>
    ${scenarioRows}
    <div id="status" class="status"></div>
    <hr/>
    <strong>Layers</strong>
    ${overlayRows}`;

  el.querySelectorAll("input[name=mode]").forEach(input => {
    input.addEventListener("change", e => {
      currentMode = e.target.value;
      buildLegend();
      restyleExposureLayers();
      loadScenario(currentScenarioId);
    });
  });

  el.querySelectorAll("input[name=scenario]").forEach(input => {
    input.addEventListener("change", e => loadScenario(e.target.value));
  });

  el.querySelectorAll("input[name=overlay]").forEach(input => {
    input.addEventListener("change", e => {
      const overlay = OVERLAYS.find(o => o.id === e.target.value);
      if (overlay) overlay.visible = e.target.checked;
      applyOverlayVisibility();
    });
  });
}

async function loadStats() {
  try {
    const response = await fetch(`${VECTOR_DIR}/scenario_stats.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    stats = await response.json();
    renderMetrics();
  } catch (err) {
    console.warn("[stats] scenario_stats.json unavailable", err);
    metricsPanel().innerHTML =
      `<div class="panel-note">Metrics unavailable — run scripts/04_scenario_stats.py.</div>`;
  }
}

(async function init() {
  buildControls();
  buildLegend();
  renderMetrics();
  // Not awaited in sequence: the vectors don't depend on the raster, and
  // loading them in parallel stops a slow COG from holding up the overlays.
  await Promise.all([loadScenario(currentScenarioId), loadVectorLayers(), loadStats()]);
})();
