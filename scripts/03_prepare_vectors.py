"""Turn the raw QGIS exports in data/vectors/ into web-ready GeoJSON in data/web/.

Three things go wrong with a plain "Export as GeoJSON" from QGIS and all three
are fixed here:

1.  CRS. fuel_breaks.geojson carries a `"crs": ... CRS84` header but its
    coordinates are ETRS89 / Portugal TM06 metres (EPSG:3763). Leaflet trusts
    the header, reads x=-24958 as a longitude, and silently draws the layer
    nowhere. Anything whose coordinates fall outside the lon/lat envelope is
    treated as TM06 and reprojected.
2.  Attribute bloat. The fuel-break layer ships 70 columns (yearly EXEC_/FIN_/
    FASE_ planning fields) that the viewer never reads; they are ~80% of the
    47 MB payload.
3.  Coordinate precision. 15 decimal places per ordinate is ~1e-9 m of
    "accuracy" on a map whose pixels are 100 m wide.

Run from the project root:  python scripts/03_prepare_vectors.py
"""

from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "data" / "vectors"
OUT_DIR = ROOT / "data" / "web"

# The raw exports are unprojected-looking but actually in metres. Any layer
# whose bounds escape this envelope is assumed to be in FALLBACK_CRS.
LONLAT_ENVELOPE = (-180, -90, 180, 90)
FALLBACK_CRS = "EPSG:3763"  # ETRS89 / Portugal TM06

# 1e-5 degrees is ~1 m at this latitude: well under the 100 m raster cell, so
# simplification is invisible at every zoom the viewer offers.
SIMPLIFY_TOLERANCE = 1e-5
COORD_PRECISION = 6

# Columns to carry through, per layer. Everything else is dropped. Keeping this
# explicit means a new column in a re-export cannot quietly re-bloat the file.
KEEP = {
    # `layer` names the network a polygon belongs to (primary_fuel_breaks /
    # secondary_fuel_breaks); the viewer draws the two as separate overlays.
    "fuel_breaks": ["layer", "Categoria", "TIPO_FGC", "Area_ha"],
    "buildings_risk": None,   # None = keep all (already minimal: value_eur + ael_*)
    "forest_risk": None,
    "study_area": [],         # perimeter is geometry only
}

# Per-feature burn probability and expected area burned are only needed by
# 04_scenario_stats.py, which reads the full files in data/vectors/. Shipping
# them to the browser as well adds ~5 MB to buildings_risk for no use: the
# viewer styles on ael_* and value_eur, and every aggregate it displays is
# precomputed into scenario_stats.json.
DROP_PREFIXES = ("bp_", "burned_ha_")

# Layers the viewer will use if they exist; a missing one is not an error.
OPTIONAL = {"study_area"}


def looks_projected(gdf):
    minx, miny, maxx, maxy = gdf.total_bounds
    w, s, e, n = LONLAT_ENVELOPE
    return not (w <= minx and s <= miny and maxx <= e and maxy <= n)


def prepare(name):
    src = SRC_DIR / f"{name}.geojson"
    if not src.exists():
        if name in OPTIONAL:
            print(f"  {name}: not present, skipped")
        else:
            print(f"  {name}: MISSING at {src}")
        return

    gdf = gpd.read_file(src)
    before = src.stat().st_size

    if looks_projected(gdf):
        # set_crs overrides the bogus CRS84 header rather than trusting it.
        gdf = gdf.set_crs(FALLBACK_CRS, allow_override=True)
        print(f"  {name}: header said lon/lat but coordinates are metres -> reprojected from {FALLBACK_CRS}")
    gdf = gdf.to_crs("EPSG:4326")

    keep = KEEP.get(name)
    if keep is not None:
        keep = [c for c in keep if c in gdf.columns]
        gdf = gdf[keep + ["geometry"]]

    dropped = [c for c in gdf.columns if c.startswith(DROP_PREFIXES)]
    if dropped:
        gdf = gdf.drop(columns=dropped)

    # ael_* come out of the AEL step as full float64 repr (17 significant
    # digits). They are euros: cents are already more precision than the model
    # supports, and the extra digits are pure payload. bp_* are probabilities
    # in 0–0.11, where 1e-6 is already far below the simulation's noise floor.
    for col in gdf.columns:
        if col.startswith("ael_"):
            gdf[col] = gdf[col].round(2)
        elif col.startswith("bp_"):
            gdf[col] = gdf[col].round(6)
        elif col == "area_ha":
            gdf[col] = gdf[col].round(4)

    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{name}.geojson"
    gdf.to_file(out, driver="GeoJSON", coordinate_precision=COORD_PRECISION)

    after = out.stat().st_size
    print(f"  {name}: {len(gdf)} features, {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB, "
          f"bounds {[round(v, 4) for v in gdf.total_bounds]}")


if __name__ == "__main__":
    print(f"Reading {SRC_DIR}")
    for layer in ["fuel_breaks", "buildings_risk", "forest_risk", "study_area"]:
        prepare(layer)
    print(f"Wrote {OUT_DIR}")
