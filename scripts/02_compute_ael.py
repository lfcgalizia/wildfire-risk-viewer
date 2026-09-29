"""Attach per-scenario annual expected loss (AEL) to each exposure feature.

AEL for a feature is  burn probability x value at risk,  evaluated once per
scenario raster. Two sampling methods, chosen by how the exposure is shaped:

*   buildings — point-sample the raster at the building centroid. A building is
    far smaller than a 100 m cell, so the centroid value is the cell value.
*   planted forest — sum  cell probability x cell area  over the cells the
    stand covers. Stands run to 3500 ha and span many cells, so a single
    centroid would misrepresent them.

Forest value is quoted per hectare, so the stand's own area has to be applied
to turn it into euros; see `value_per_ha` below.

Two conventions here are load-bearing, because the published loss table is
computed this way and the viewer has to agree with it to the euro. That table
comes out of Publication/Scripts/aBP_analysis_v2.ipynb into
Publication/Data/Output/Risk/municipality_ael.csv; summing that CSV by scenario
is the check these numbers have to pass.

*   The rasters are read from the model output directory in their native
    EPSG:3763 grid, NOT from the EPSG:4326 COGs in data/rasters/. Those COGs
    are bilinear-resampled for web display (01_make_cogs.py); resampling
    smooths the probability field and moved expected buildings burned under
    business as usual by +1.0% (863.3 -> 872.1 /yr). The COGs stay the map's
    display layer; every number comes from the native grid.
*   Expected forest area burned is the cell-wise sum above, not
    (zonal mean probability) x (true polygon area). The two differ because the
    cells a stand covers are not exactly the stand: rasterising the 10475 ha of
    stands at 100 m gives 10509 ha. Under business as usual the cell-wise sum
    is 387.4 ha/yr against 384.6 ha/yr for the zonal-mean form, a 0.7% gap.

Run from the project root:  python scripts/02_compute_ael.py
"""

import shutil
import time
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.mask import mask
from rasterio.transform import rowcol
from tqdm.auto import tqdm

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "vectors"
# Model outputs and exposure inputs live beside the model rather than inside
# it, under the PIISA project root two levels up. Kept relative so the script
# is portable.
PUB_DIR = ROOT.parent.parent / "Publication" / "Data"
RASTER_DIR = PUB_DIR / "Output" / "Calibrated2"
EXPO_DIR = PUB_DIR / "Input" / "Expo"

# Areas are measured in ETRS89 / Portugal TM06 — metres, and correct for the
# study area's latitude. Measuring in EPSG:4326 degrees would be meaningless.
AREA_CRS = "EPSG:3763"

# aBP_bau.tif, not aBP_bau2.tif: aBP_bau is the calibrated baseline the
# published loss table is built on. The two differ by ~1.8% in expected
# buildings burned, which is the largest single term in the AEL.
SCENARIOS = {
    "bau": "aBP_bau.tif",
    "primary_full": "aBP_pfb.tif",
    "primary_partial": "aBP_pfb_partial.tif",
    "secondary_full": "aBP_sfb.tif",
    "secondary_partial": "aBP_sfb_partial.tif",
    "combined_full": "aBP_pfb_sfb.tif",
    "combined_partial": "aBP_pfb_sfb_partial.tif",
}


def write_geojson(gdf, out_path):
    """Write `gdf` to `out_path`, overwriting the bytes rather than the file.

    pyogrio unlinks the target and recreates it. On Windows that fails with
    WinError 32 whenever QGIS has the layer loaded — it holds a share-read lock
    that permits writing but not deleting. Writing to a sibling temp file and
    streaming it over the original only needs the write right, so a re-run does
    not depend on which layers happen to be open.
    """
    out_path = Path(out_path)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    gdf.to_file(tmp, driver="GeoJSON")
    try:
        with open(tmp, "rb") as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst)
    finally:
        tmp.unlink(missing_ok=True)


def load_raster_array(path):
    with rasterio.open(path) as src:
        return {
            "array": src.read(1),
            "affine": src.transform,
            "crs": src.crs,
            "nodata": src.nodata,
        }


def sample_points(xs, ys, raster):
    """Vectorized point sampling — no per-point disk reads."""
    rows, cols = rowcol(raster["affine"], xs, ys)
    # rowcol floors to the containing cell but hands back floats on some
    # rasterio versions; numpy will not index with those.
    rows = np.asarray(rows).astype("int64")
    cols = np.asarray(cols).astype("int64")
    h, w = raster["array"].shape

    valid = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
    values = np.zeros(len(xs), dtype="float64")
    values[valid] = raster["array"][rows[valid], cols[valid]]

    # nodata is NaN in these rasters, so compare with isnan rather than ==.
    values[~np.isfinite(values)] = 0
    if raster["nodata"] is not None and np.isfinite(raster["nodata"]):
        values[values == raster["nodata"]] = 0
    return values


def expected_area_burned(gdf, raster_path):
    """Expected area burned per polygon, in hectares: sum of cell probability
    x cell area over the cells each polygon covers.

    A cell counts towards a polygon when its centre falls inside — rasterio's
    default, and the rule the published loss table uses. Returned in hectares
    so it can be multiplied straight by a per-hectare value.
    """
    with rasterio.open(raster_path) as src:
        cell_ha = abs(src.res[0] * src.res[1]) / 1e4
        burned = np.zeros(len(gdf), dtype="float64")
        for i, geom in enumerate(tqdm(gdf.geometry, desc="  cell sums", leave=False)):
            try:
                arr, _ = mask(src, [geom], crop=True, nodata=np.nan)
            except ValueError:
                # Polygon falls outside the raster: nothing exposed.
                continue
            burned[i] = np.nan_to_num(arr[0]).sum() * cell_ha
    return burned


def compute_ael(exposure_path, value_field, out_path, method="point", value_per_ha=False):
    """Write `exposure_path` back out with an ael_<scenario> column per scenario.

    `value_per_ha=True` means `value_field` is euros per hectare, not euros:
    the expected area burned is applied so every ael_* column is in euros.
    Without it the forest AEL came out ~20x too small and was being summed with
    the buildings' euros to make a total that mixed the two units.
    """
    t0 = time.time()
    gdf = gpd.read_file(exposure_path)[["geometry", value_field]].copy()
    gdf["exposure_id"] = range(1, len(gdf) + 1)  # anonymous ID only — no source attributes kept

    if value_per_ha:
        gdf["area_ha"] = gdf.to_crs(AREA_CRS).geometry.area / 1e4

    cache = {}  # crs_key -> reprojected geometry / precomputed centroids, built once

    for scenario_id, raster_name in tqdm(SCENARIOS.items(), desc=f"Scenarios ({Path(out_path).name})"):
        raster_path = RASTER_DIR / raster_name
        raster = load_raster_array(raster_path)
        crs_key = raster["crs"].to_string()

        if crs_key not in cache:
            gdf_r = gdf.to_crs(raster["crs"])
            entry = {"gdf": gdf_r}
            if method == "point":
                entry["xs"] = gdf_r.geometry.centroid.x.values
                entry["ys"] = gdf_r.geometry.centroid.y.values
            cache[crs_key] = entry
        entry = cache[crs_key]

        if method == "point":
            bp = sample_points(entry["xs"], entry["ys"], raster)
            value_eur = gdf[value_field].values
            # Burn probability is kept alongside the loss: the viewer's risk
            # metrics need the expected *count* of assets affected, which is
            # the sum of probabilities and cannot be recovered from euros
            # alone.
            gdf[f"bp_{scenario_id}"] = bp
            gdf[f"ael_{scenario_id}"] = bp * value_eur
        else:
            burned_ha = expected_area_burned(entry["gdf"], raster_path)
            # Expected area burned is the primary quantity for a stand, so it
            # is stored rather than re-derived: 04_scenario_stats.py sums it
            # straight, and dividing it back out of a probability would not be
            # exact (the cells a stand covers are not the stand's own area).
            gdf[f"burned_ha_{scenario_id}"] = burned_ha
            # Effective burn probability over the stand, for the popup only.
            gdf[f"bp_{scenario_id}"] = np.divide(
                burned_ha, gdf["area_ha"].values,
                out=np.zeros_like(burned_ha), where=gdf["area_ha"].values > 0,
            )
            gdf[f"ael_{scenario_id}"] = burned_ha * gdf[value_field].values

    write_geojson(gdf.to_crs("EPSG:4326"), out_path)
    print(f"wrote {out_path} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # buildings: point-sample at centroid, value_eur = replacement cost per building
    compute_ael(
        EXPO_DIR / "buildings.gpkg", "value_eur",
        OUT_DIR / "buildings_risk.geojson", method="point",
    )

    # planted forest: cell-wise expected area burned per stand,
    # value_per_ha = stand value per hectare
    compute_ael(
        EXPO_DIR / "planted_forest_study_area.gpkg", "value_per_ha",
        OUT_DIR / "forest_risk.geojson", method="cells", value_per_ha=True,
    )
