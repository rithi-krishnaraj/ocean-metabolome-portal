"""
data_processor.py
Data parsing, cleaning, blank removal, imputation, and combined-table creation.
Adapted from FBMN-STATS-Webapp/src/cleanup.py and the existing portal logic.
"""
from __future__ import annotations

import io
import re
from typing import Optional

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Coordinate column aliases (checked in order, first match wins)
# ---------------------------------------------------------------------------

LAT_ALIASES = ["ATTRIBUTE_Latitude", "Latitude", "latitude", "lat", "LAT"]
LON_ALIASES = ["ATTRIBUTE_Longitude", "Longitude", "longitude", "lon", "long", "LON"]


def _find_coord_column(columns: list[str], aliases: list[str], kind: str) -> Optional[str]:
    """Find coordinate column by exact alias first, then relaxed ATTRIBUTE_* matching."""
    col_map = {str(c).strip(): str(c) for c in columns}
    lower_map = {k.lower(): v for k, v in col_map.items()}

    for alias in aliases:
        found = lower_map.get(str(alias).strip().lower())
        if found is not None:
            return found

    # Accept common variants like ATTRIBUTE_Latitude_WGS84 or ATTRIBUTE_GPS_Longitude.
    token = "latitude" if kind == "lat" else "longitude"
    short_token = "lat" if kind == "lat" else "lon"
    for original in columns:
        c = str(original).strip().lower()
        if c.startswith("attribute_") and (token in c or short_token in c):
            return str(original)

    # Final fallback: any column mentioning latitude/longitude tokens.
    for original in columns:
        c = str(original).strip().lower()
        if token in c:
            return str(original)
    for original in columns:
        c = str(original).strip().lower()
        if short_token in c:
            return str(original)

    return None


# ---------------------------------------------------------------------------
# File parsing
# ---------------------------------------------------------------------------

def parse_file(content: bytes, filename: str) -> Optional[pd.DataFrame]:
    """Parse uploaded file bytes into a DataFrame."""
    ext = filename.rsplit(".", 1)[-1].lower()
    try:
        if ext == "xlsx":
            df = pd.read_excel(io.BytesIO(content))
        else:
            sep = "\t" if ext in ("tsv", "txt") else ","
            df = pd.read_csv(io.BytesIO(content), sep=sep, on_bad_lines="skip")

        if "Unnamed: 0" in df.columns:
            df = df.drop(columns=["Unnamed: 0"])

        return df
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Feature table cleaning  (from FBMN-STATS cleanup.py)
# ---------------------------------------------------------------------------

def clean_feature_table(ft: pd.DataFrame) -> pd.DataFrame:
    """Remove non-sample columns and normalise column names."""
    ft = ft.copy().dropna(how="all")

    sample_cols = [c for c in ft.columns if ".mzML" in c or ".mzXML" in c]

    if sample_cols:
        ft = ft[sample_cols]
        ft.rename(
            columns={
                c: re.sub(r"\s*Peak area$", "", c)
                    .replace(".mzXML", "")
                    .replace(".mzML", "")
                    .strip()
                for c in ft.columns
            },
            inplace=True,
        )
    else:
        # Accept numeric columns if no standard extensions found
        numeric_cols = ft.select_dtypes(include="number").columns.tolist()
        if numeric_cols:
            ft = ft[numeric_cols]

    return ft.dropna(how="all")


# ---------------------------------------------------------------------------
# Metadata cleaning  (from FBMN-STATS cleanup.py)
# ---------------------------------------------------------------------------

def clean_metadata_table(md: pd.DataFrame) -> pd.DataFrame:
    """Strip whitespace from index and string columns."""
    md = md.copy().dropna(how="all")
    md.index = [
        str(i).strip().replace(".mzXML", "").replace(".mzML", "").replace(" Peak area", "")
        for i in md.index
    ]
    for col in md.columns:
        if md[col].dtype == object:
            md[col] = md[col].astype(str).str.strip()
    return md


# ---------------------------------------------------------------------------
# Coordinate validation
# ---------------------------------------------------------------------------

def validate_coordinates(md: pd.DataFrame) -> tuple[bool, Optional[str], Optional[str]]:
    """Return (has_coords, lat_col_name, lon_col_name)."""
    if md is None or md.empty:
        return False, None, None

    cols = [str(c) for c in md.columns]
    lat_col = _find_coord_column(cols, LAT_ALIASES, "lat")
    lon_col = _find_coord_column(cols, LON_ALIASES, "lon")

    return (lat_col is not None and lon_col is not None), lat_col, lon_col


# ---------------------------------------------------------------------------
# Metadata column info  (for blank-removal UI)
# ---------------------------------------------------------------------------

def get_md_column_info(md: pd.DataFrame) -> list[dict]:
    """Return per-column value counts for the blank-removal selectors."""
    if md is None or md.empty:
        return []
    result = []
    for col in md.columns:
        vc = md[col].dropna().astype(str).value_counts()
        result.append({
            "column": col,
            "levels": list(vc.index[:30]),
            "counts": [int(v) for v in vc.values[:30]],
        })
    return result


# ---------------------------------------------------------------------------
# Blank removal  (from FBMN-STATS cleanup.py)
# ---------------------------------------------------------------------------

def remove_blank_features(
    blanks: pd.DataFrame,
    samples: pd.DataFrame,
    cutoff: float = 0.3,
) -> tuple[pd.DataFrame, int, int]:
    """
    Remove features whose blank/sample intensity ratio exceeds *cutoff*.
    Returns (cleaned_samples_ft, n_background_features, n_real_features).
    """
    avg_blank = blanks.mean(axis=1, skipna=False)
    avg_samples = samples.mean(axis=1, skipna=False)
    ratio = (avg_blank + 1) / (avg_samples + 1)
    is_real = ratio < cutoff

    cleaned = samples[is_real.values]
    n_bg = int(len(samples) - is_real.sum())
    n_real = int(is_real.sum())
    return cleaned, n_bg, n_real


# ---------------------------------------------------------------------------
# Imputation  (from FBMN-STATS cleanup.py)
# ---------------------------------------------------------------------------

def impute_missing_values(
    ft: pd.DataFrame,
    cutoff_lod: Optional[float] = None,
) -> pd.DataFrame:
    """Replace zeros with random values between 1 and the limit of detection."""
    if cutoff_lod is None:
        min_val = ft.replace(0, np.nan).min(numeric_only=True).min()
        cutoff_lod = round(float(min_val)) if not pd.isna(min_val) else 1

    if cutoff_lod <= 1:
        return ft

    return ft.apply(
        lambda col: [np.random.randint(1, int(cutoff_lod)) if v == 0 else v for v in col]
    )


# ---------------------------------------------------------------------------
# Combined annotated table
# ---------------------------------------------------------------------------

def create_combined_table(
    ft: Optional[pd.DataFrame],
    md: Optional[pd.DataFrame],
    an: Optional[pd.DataFrame] = None,
) -> Optional[pd.DataFrame]:
    """
    Transpose ft so rows = samples, then join with md (and optionally an).
    Result: each row is a sample, columns = metadata + feature intensities.
    """
    if ft is None or md is None or ft.empty or md.empty:
        return None

    try:
        ft_t = ft.T  # samples × features
        common = [s for s in md.index if s in ft_t.index]
        if not common:
            return None

        combined = pd.concat([md.loc[common], ft_t.loc[common]], axis=1)

        if an is not None and not an.empty:
            if "row ID" in ft.columns and "#Scan#" in an.columns:
                an_m = an.copy()
                an_m["#Scan#"] = an_m["#Scan#"].astype(str)
                an_cols = [c for c in an_m.columns if c not in combined.columns]
                if an_cols:
                    combined = combined.merge(
                        an_m[["#Scan#"] + an_cols],
                        left_on="row ID",
                        right_on="#Scan#",
                        how="left",
                    )

        return combined
    except Exception:
        return None
