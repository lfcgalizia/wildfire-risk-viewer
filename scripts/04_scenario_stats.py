"""Precompute per-scenario hazard, exposure and risk metrics for the viewer.

Structured around the usual decomposition:

*   hazard    — annual burn probability, from the scenario rasters. A property
                of the landscape, independent of what is standing on it.
*   exposure  — what is at risk: building count and replacement cost, planted
                forest area and value. Identical across scenarios; treatment
                changes the hazard, not the assets.
*   risk      — hazard applied to exposure, as an annual expectation:
                  buildings affected /yr   = sum of per-building burn probability
                  forest area burned /yr   = sum of stand probability x stand area
                  expected annual loss /yr = sum of probability x value

"Buildings affected per year" is an expected count, so it is fractional and is
not a headcount of distinct buildings — over a long run it is the average
number burning in a year.

Reading the COGs and 26k exposure features in the browser would mean pulling
every scenario at full resolution on load, so it is computed once here into
data/web/scenario_stats.json.

Run from the project root:  python scripts/04_scenario_stats.py
"""

import json
from datetime import date
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parent.parent
# The native EPSG:3763 model output, not the EPSG:4326 COGs in data/rasters/.
# Those are bilinear-resampled for web display only; see the note in
# 02_compute_ael.py. Metres-square cells also make the "% of area" figures
# below area-weighted, which they would not be on a lon/lat grid.
RASTER_DIR = ROOT.parent.parent / "Publication" / "Data" / "Output" / "Calibrated2"
# Read the full exposure files, not the slimmed web ones: the browser copies
# have the per-feature bp_* columns stripped out, and the counts below are
# built from them.
VECTOR_DIR = ROOT / "data" / "vectors"
WEB_DIR = ROOT / "data" / "web"
OUT = WEB_DIR / "scenario_stats.json"

BASELINE = "bau"

# Must stay in step with SCENARIOS in js/app.js.
SCENARIOS = {
    "bau": "aBP_bau.tif",
    "primary_full": "aBP_pfb.tif",
    "primary_partial": "aBP_pfb_partial.tif",
    "secondary_full": "aBP_sfb.tif",
    "secondary_partial": "aBP_sfb_partial.tif",
    "combined_full": "aBP_pfb_sfb.tif",
    "combined_partial": "aBP_pfb_sfb_partial.tif",
}

# A cell has "materially changed" if it moves by at least this much burn
# probability. 0.1 pp is about the noise floor of the simulation.
MATERIAL_CHANGE = 0.001

# Cells at or above this annual burn probability are reported as high hazard.
# 5%/yr is roughly a 1-in-20 year return period and coincides with a class
# break in the viewer's legend.
HIGH_HAZARD = 0.05


def read_raster(name):
    with rasterio.open(RASTER_DIR / name) as src:
        return src.read(1, masked=True)


def read_features(layer):
    path = VECTOR_DIR / f"{layer}.geojson"
    if not path.exists():
        raise SystemExit(f"{path} missing — run 02_compute_ael.py first")
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def column(features, key, default=0.0):
    return np.array([f["properties"].get(key) or default for f in features], dtype="float64")


def main():
    buildings = read_features("buildings_risk")
    forest = read_features("forest_risk")

    if f"bp_{BASELINE}" not in buildings[0]["properties"]:
        raise SystemExit("exposure files have no bp_* columns — re-run 02_compute_ael.py")

    if f"burned_ha_{BASELINE}" not in forest[0]["properties"]:
        raise SystemExit("forest file has no burned_ha_* columns — re-run 02_compute_ael.py")

    b_value = column(buildings, "value_eur")
    f_area = column(forest, "area_ha")
    f_value_ha = column(forest, "value_per_ha")

    # Whether a unit value actually varies decides how the viewer may draw it:
    # the current inputs give every building one replacement cost and every
    # hectare one stand value, so a value-shaded exposure map would encode
    # nothing but polygon size. Recorded rather than assumed.
    def unit_value(values):
        distinct = np.unique(np.round(values, 6))
        return {
            "uniform": bool(distinct.size == 1),
            "distinct": int(distinct.size),
            "value": round(float(distinct[0]), 2) if distinct.size == 1 else None,
        }

    exposure = {
        "buildings": {
            "count": len(buildings),
            "value_eur": round(float(b_value.sum()), 2),
            "unit_value_eur": unit_value(b_value),
        },
        "forest": {
            "stands": len(forest),
            "area_ha": round(float(f_area.sum()), 2),
            "value_eur": round(float((f_value_ha * f_area).sum()), 2),
            "unit_value_eur_per_ha": unit_value(f_value_ha),
        },
    }

    baseline_raster = read_raster(SCENARIOS[BASELINE])
    scenarios = {}

    for sid, raster_name in SCENARIOS.items():
        arr = read_raster(raster_name)
        delta = arr - baseline_raster
        valid = ~delta.mask if np.ma.isMaskedArray(delta) else np.ones(delta.shape, bool)
        d = np.asarray(delta[valid])

        b_bp = column(buildings, f"bp_{sid}")
        # Summed rather than rebuilt from bp x area: the cells a stand covers
        # are not the stand's own area, so the two are not interchangeable.
        f_burned_ha = column(forest, f"burned_ha_{sid}")

        ael_buildings = float(column(buildings, f"ael_{sid}").sum())
        ael_forest = float(column(forest, f"ael_{sid}").sum())

        scenarios[sid] = {
            "hazard": {
                "mean_bp": float(arr.mean()),
                "max_bp": float(arr.max()),
                "area_high_hazard_pct": float((arr >= HIGH_HAZARD).mean() * 100),
                "mean_delta": float(d.mean()),
                "area_reduced_pct": float((d <= -MATERIAL_CHANGE).mean() * 100),
                "area_increased_pct": float((d >= MATERIAL_CHANGE).mean() * 100),
                "max_reduction": float(-d.min()),
            },
            "risk": {
                "buildings_affected": round(float(b_bp.sum()), 2),
                "forest_area_burned_ha": round(float(f_burned_ha.sum()), 2),
                "ael_buildings_eur": round(ael_buildings, 2),
                "ael_forest_eur": round(ael_forest, 2),
                "ael_total_eur": round(ael_buildings + ael_forest, 2),
            },
        }

    base = scenarios[BASELINE]["risk"]
    for sid, s in scenarios.items():
        r = s["risk"]
        # Positive = avoided relative to business as usual.
        s["vs_baseline"] = {
            "buildings_affected": round(base["buildings_affected"] - r["buildings_affected"], 2),
            "forest_area_burned_ha": round(base["forest_area_burned_ha"] - r["forest_area_burned_ha"], 2),
            "ael_total_eur": round(base["ael_total_eur"] - r["ael_total_eur"], 2),
            "ael_total_pct": round(
                (base["ael_total_eur"] - r["ael_total_eur"]) / base["ael_total_eur"] * 100, 2
            ) if base["ael_total_eur"] else 0.0,
        }

    payload = {
        "meta": {
            "baseline": BASELINE,
            "generated": date.today().isoformat(),
            "currency": "EUR",
            "high_hazard_threshold": HIGH_HAZARD,
            "material_change": MATERIAL_CHANGE,
        },
        "exposure": exposure,
        "scenarios": scenarios,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"  exposure: {exposure['buildings']['count']} buildings "
          f"(EUR {exposure['buildings']['value_eur'] / 1e6:.0f}M), "
          f"{exposure['forest']['area_ha']:.0f} ha forest "
          f"(EUR {exposure['forest']['value_eur'] / 1e6:.1f}M)")
    print(f"  {'scenario':20s} {'meanBP':>7s} {'bldgs/yr':>9s} {'ha/yr':>8s} "
          f"{'AEL EURm':>9s} {'saved':>7s}")
    for sid, s in scenarios.items():
        print(f"  {sid:20s} {s['hazard']['mean_bp'] * 100:6.2f}% "
              f"{s['risk']['buildings_affected']:9.1f} "
              f"{s['risk']['forest_area_burned_ha']:8.1f} "
              f"{s['risk']['ael_total_eur'] / 1e6:9.2f} "
              f"{s['vs_baseline']['ael_total_pct']:6.1f}%")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
