import glob, os
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles

SRC_DIR = "C:/Users/LuizGALIZIA/OneDrive - AXA CLIMATE/Luiz/Projects/PIISA/Publication/Data/Output/Calibrated2"
DST_DIR = "C:/Users/LuizGALIZIA/OneDrive - AXA CLIMATE/Luiz/Projects/PIISA/Model/wildfire-risk-viewer/data/rasters"
DST_CRS = "EPSG:4326"
os.makedirs(DST_DIR, exist_ok=True)
profile = cog_profiles.get("deflate")

for src_path in glob.glob(os.path.join(SRC_DIR, "*.tif")):
    name = os.path.splitext(os.path.basename(src_path))[0]
    dst_path = os.path.join(DST_DIR, f"{name}.tif")
    with rasterio.open(src_path) as src:
        with WarpedVRT(src, crs=DST_CRS, resampling=Resampling.bilinear) as vrt:
            cog_translate(vrt, dst_path, profile, in_memory=False, quiet=False)
    print("wrote", dst_path)