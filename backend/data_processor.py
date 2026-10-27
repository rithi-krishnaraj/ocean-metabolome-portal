"""
data_processor.py
Data parsing, cleaning, feature indexing, and combined-table creation.
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

# GNPS/MZmine feature-table columns that describe the feature, not a sample.
FEATURE_DESCRIPTOR_COLUMNS = {
    "row ID",
    "row m/z",
    "row retention time",
    "row ion mobility",
    "row ion mobility unit",
    "row CCS",
    "correlation group ID",
    "annotation network number",
    "best ion",
    "auto MS2 verify",
    "identified by n=",
    "partners",
    "neutral M mass",
}


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
            try:
                # pyarrow's multithreaded parser is ~3× faster on large feature tables
                df = pd.read_csv(io.BytesIO(content), sep=sep, engine="pyarrow")
            except ValueError:  # malformed rows: fall back to the tolerant C parser
                df = pd.read_csv(io.BytesIO(content), sep=sep, on_bad_lines="skip")

        if "Unnamed: 0" in df.columns:
            df = df.drop(columns=["Unnamed: 0"])

        return df
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Feature index  (rowID_mz_rt, as produced by FBMN-STATS)
# ---------------------------------------------------------------------------

_MZ_PATTERNS = ["m/z", "mz", "mass over charge"]
_RT_PATTERNS = ["rt", "retention time", "retention-time", "retention_time"]


def _mz_rt_columns(ft: pd.DataFrame) -> tuple[Optional[str], Optional[str]]:
    """First m/z-like and RT-like column names (FBMN-STATS get_new_index patterns)."""
    def first_match(patterns):
        for col in ft.columns:
            c = str(col).lower()
            # sample files (.mzML/.mzXML) contain "mz" but are not descriptors
            if "mzml" not in c and "mzxml" not in c and any(p in c for p in patterns):
                return col
        return None
    return first_match(_MZ_PATTERNS), first_match(_RT_PATTERNS)


def index_feature_table(ft: pd.DataFrame) -> pd.DataFrame:
    """Give an uploaded feature table its metabolite index, as FBMN-STATS load_ft does:

    1. a 'metabolite' column, if present;
    2. GNPS/MZmine 'row ID' + 'row m/z' + 'row retention time' → rowID_mz_rt
       (the same IDs a GNPS task load produces);
    3. otherwise the first m/z-like and RT-like columns → [rowID_]mz@rt.
    Must run before clean_feature_table(), which drops those columns.
    """
    if "metabolite" in ft.columns:
        ft.index = ft["metabolite"].astype(str)
        ft.index.name = "metabolite"
        return ft
    if {"row ID", "row m/z", "row retention time"} <= set(ft.columns):
        return add_metabolite_index(ft)

    mz_col, rt_col = _mz_rt_columns(ft)
    if mz_col is None or rt_col is None:
        return ft
    try:
        key = ft[mz_col].astype(float).round(5).astype(str) + "@" + ft[rt_col].astype(float).round(2).astype(str)
    except (TypeError, ValueError):
        return ft
    if "row ID" in ft.columns:
        key = ft["row ID"].astype(str) + "_" + key
    ft.index = key
    ft.index.name = "metabolite"
    return ft


def _clean_sample_name(name: object) -> str:
    return str(name).strip().replace(".mzXML", "").replace(".mzML", "").replace(" Peak area", "")


def set_metadata_index(md: pd.DataFrame, sample_names) -> pd.DataFrame:
    """Index metadata by sample filename, as FBMN-STATS load_md does.

    Uses the 'filename' column; without one, picks the unique-valued column whose
    values best match the feature table's (cleaned) sample names.
    """
    if "filename" in md.columns:
        return md.set_index("filename")

    targets = {_clean_sample_name(s) for s in sample_names}
    best_col, best_hits = None, 0
    for col in md.columns:
        values = md[col].dropna().astype(str)
        if len(values) != len(md) or not values.is_unique:
            continue
        hits = sum(_clean_sample_name(v) in targets for v in values)
        if hits > best_hits:
            best_col, best_hits = col, hits
    if best_col is None:
        raise ValueError(
            "Metadata needs a 'filename' column whose values match the feature table's sample columns."
        )
    return md.set_index(best_col).rename_axis("filename")


def add_metabolite_index(ft: pd.DataFrame) -> pd.DataFrame:
    """Index a GNPS/MZmine feature table by ``rowID_mz_rt``.

    Must run before clean_feature_table(), which drops the row ID / m/z / RT
    columns. Tables without those columns are returned unchanged.
    """
    try:
        row_ids = ft["row ID"].map(
            lambda v: str(int(v)) if isinstance(v, (int, float, np.number)) and float(v).is_integer() else str(v)
        )
        mz = ft["row m/z"].map(lambda v: str(round(float(v), 4)))
        rt = ft["row retention time"].map(lambda v: str(round(float(v), 2)))
    except (KeyError, TypeError, ValueError):
        return ft
    ft.index = row_ids + "_" + mz + "_" + rt
    ft.index.name = "metabolite"
    return ft


# ---------------------------------------------------------------------------
# Feature table cleaning  (from FBMN-STATS cleanup.py)
# ---------------------------------------------------------------------------

def clean_feature_table(ft: pd.DataFrame) -> pd.DataFrame:
    """Remove non-sample columns and normalise column names."""
    # Drop only completely empty rows/columns; a sample with a few empty cells must not be lost.
    ft = ft.copy().dropna(how="all").dropna(axis=1, how="all")

    sample_cols = [c for c in ft.columns if ".mzML" in str(c) or ".mzXML" in str(c)]

    if sample_cols:
        ft = ft[sample_cols]
        ft.rename(
            columns={
                c: re.sub(r"\s*Peak area$", "", str(c))
                    .replace(".mzXML", "")
                    .replace(".mzML", "")
                    .strip()
                for c in ft.columns
            },
            inplace=True,
        )
    else:
        # No standard extensions: treat numeric columns as samples, except the
        # feature descriptors (row ID, m/z, RT, ...), which are numeric too.
        descriptors = FEATURE_DESCRIPTOR_COLUMNS | {str(c) for c in _mz_rt_columns(ft) if c is not None}
        numeric_cols = [
            c for c in ft.select_dtypes(include="number").columns
            if str(c) not in descriptors
        ]
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
# Combined table  (admin preview only)
# ---------------------------------------------------------------------------

def create_combined_table(
    ft: Optional[pd.DataFrame],
    md: Optional[pd.DataFrame],
) -> Optional[pd.DataFrame]:
    """
    Transpose ft so rows = samples, then join with md.
    Result: each row is a sample, columns = metadata + feature intensities.
    """
    if ft is None or md is None or ft.empty or md.empty:
        return None

    try:
        ft_t = ft.T  # samples × features
        common = [s for s in md.index if s in ft_t.index]
        if not common:
            return None
        return pd.concat([md.loc[common], ft_t.loc[common]], axis=1)
    except Exception:
        return None
