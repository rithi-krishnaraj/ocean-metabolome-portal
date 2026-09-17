"""
Ocean Metabolome Portal – FastAPI Backend
Routes for manual upload, GNPS task loading, dataset management, and map data.
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Optional
import skbio
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from data_processor import (
    clean_feature_table,
    clean_metadata_table,
    create_combined_table,
    get_md_column_info,
    impute_missing_values,
    parse_file,
    remove_blank_features,
    validate_coordinates,
)
from gnps_client import load_fbmn

# Optional RDKit — enables SMILES → molecular formula fallback for Van Krevelen plots
try:
    from rdkit import Chem as _rd_Chem
    from rdkit.Chem import rdMolDescriptors as _rd_md
    _RDKIT_AVAILABLE = True
except ImportError:
    _RDKIT_AVAILABLE = False

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Ocean Metabolome Portal API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATASETS_DIR = Path(__file__).parent / "datasets"
DATASETS_DIR.mkdir(exist_ok=True)

# In-memory sessions: session_id → { ft, md, an, meta }
sessions: dict = {}

# In-memory caches for blazingly fast performance
DATASET_DF_CACHE = {}  # dataset_safe -> {"md": DataFrame, "ft": DataFrame, "mtime_md": float, "mtime_ft": float}
PCOA_CACHE = {}        # (dataset_safe, distance_metric, sample_cols_tuple) -> {"evals": ndarray, "evecs": ndarray, "proportion_explained": list}

def parse_feature_labels(columns):
    """Parse feature labels formatted as ID_mz@RT.

    Returns two lists (mz_values, rt_values) aligned with the input columns.
    Entries that don't match the expected format are returned as None.
    """
    mz_values, rt_values = [], []
    for col in columns:
        try:
            at_idx = col.index("@")
            rt = float(col[at_idx + 1:])
            mz = float(col[:at_idx].rsplit("_", 1)[1])
            mz_values.append(mz)
            rt_values.append(rt)
        except (ValueError, IndexError):
            mz_values.append(None)
            rt_values.append(None)
    return mz_values, rt_values


def get_cached_dataset(dataset_safe: str, dataset_dir: Path):
    md_path = dataset_dir / "md.parquet"
    ft_path = dataset_dir / "ft.parquet"

    if not md_path.exists() or not ft_path.exists():
        return None, None

    mtime_md = md_path.stat().st_mtime
    mtime_ft = ft_path.stat().st_mtime

    cached = DATASET_DF_CACHE.get(dataset_safe)
    if cached and cached["mtime_md"] == mtime_md and cached["mtime_ft"] == mtime_ft:
        return cached["md"].copy(), cached["ft"].copy()

    md = pd.read_parquet(md_path)
    ft = pd.read_parquet(ft_path)
    DATASET_DF_CACHE[dataset_safe] = {
        "md": md,
        "ft": ft,
        "mtime_md": mtime_md,
        "mtime_ft": mtime_ft
    }
    return md.copy(), ft.copy()


def _dataset_mtimes(dataset_dir: Path) -> tuple[float, float]:
    """(md_mtime, ft_mtime) for cache invalidation — cheap stat() calls."""
    md_path = dataset_dir / "md.parquet"
    ft_path = dataset_dir / "ft.parquet"
    return (
        md_path.stat().st_mtime if md_path.exists() else 0.0,
        ft_path.stat().st_mtime if ft_path.exists() else 0.0,
    )


def _df_records(df: Optional[pd.DataFrame], max_rows: int = 200) -> list:
    if df is None or df.empty:
        return []
    df = df.head(max_rows).copy()
    df = df.reset_index()
    # Replace NaN with None for JSON serialisation
    return json.loads(df.to_json(orient="records", default_handler=str))


def _df_columns(df: Optional[pd.DataFrame]) -> list:
    if df is None or df.empty:
        return []
    return list(df.reset_index().columns)


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)


def _find_column_case_insensitive(df: pd.DataFrame, target: Optional[str]) -> Optional[str]:
    if not target:
        return None
    if target in df.columns:
        return target
    target_lower = str(target).strip().lower()
    for col in df.columns:
        if str(col).strip().lower() == target_lower:
            return str(col)
    return None


def _normalise_sample_key(value: object) -> str:
    s = str(value or "").strip().lower()
    if not s:
        return ""
    # Trim common MS file suffixes and punctuation differences.
    s = re.sub(r"\.(mzml|mzxml|raw|cdf)$", "", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def _resolve_ft_sample_column(ft: pd.DataFrame, candidates: list[str]) -> Optional[str]:
    # Pass 1: exact match
    for candidate in candidates:
        if candidate and candidate in ft.columns:
            return candidate

    # Build normalised lookup once
    norm_to_col: dict[str, str] = {}
    for col in ft.columns:
        key = _normalise_sample_key(col)
        if key and key not in norm_to_col:
            norm_to_col[key] = str(col)

    # Pass 2: normalised match (strips .mzML/.mzXML, punctuation, case)
    for candidate in candidates:
        key = _normalise_sample_key(candidate)
        if key and key in norm_to_col:
            return norm_to_col[key]

    # Pass 3: substring match — candidate is contained in a column name or vice versa
    for candidate in candidates:
        if not candidate:
            continue
        cand_lower = candidate.lower()
        for col in ft.columns:
            col_lower = col.lower()
            if cand_lower in col_lower or col_lower in cand_lower:
                return col

    return None


def _parse_feature_parts(feature_key: str) -> tuple[str, Optional[float], Optional[float]]:
    key = str(feature_key).strip()
    parts = key.split("_")
    row_id = parts[0] if parts else key
    mz = None
    rt = None

    # Format support: rowID_mz@RT
    if "_" in key and "@" in key:
        try:
            _, mz_rt_part = key.split("_", 1)
            mz_part, rt_part = mz_rt_part.split("@", 1)
            mz = float(mz_part)
            rt = float(rt_part)
        except Exception:
            mz = None
            rt = None

    # Format support: rowID_mz_rt
    if mz is None and rt is None and len(parts) >= 3:
        try:
            mz = float(parts[-2])
        except Exception:
            mz = None
        try:
            rt = float(parts[-1])
        except Exception:
            rt = None

    # Final fallback: extract last two numeric tokens if present.
    if mz is None and rt is None:
        nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", key)
        if len(nums) >= 2:
            try:
                mz = float(nums[-2])
                rt = float(nums[-1])
            except Exception:
                mz = None
                rt = None

    return row_id, mz, rt


# ---------------------------------------------------------------------------
# Upload – manual files
# ---------------------------------------------------------------------------

@app.post("/api/upload/manual")
async def upload_manual(
    ft_file: UploadFile = File(...),
    md_file: UploadFile = File(...),
    an_file: Optional[UploadFile] = File(None),
):
    ft = parse_file(await ft_file.read(), ft_file.filename)
    md = parse_file(await md_file.read(), md_file.filename)

    if ft is None or ft.empty:
        raise HTTPException(400, "Feature table is empty or unreadable.")
    if md is None or md.empty:
        raise HTTPException(400, "Metadata table is empty or unreadable.")

    # Set metadata index
    if "filename" in md.columns:
        md = md.set_index("filename")

    ft = clean_feature_table(ft)
    md = clean_metadata_table(md)

    an: Optional[pd.DataFrame] = None
    if an_file and an_file.filename:
        an = parse_file(await an_file.read(), an_file.filename)

    has_coords, lat_col, lon_col = validate_coordinates(md)
    combined = create_combined_table(ft, md, an)

    session_id = str(uuid.uuid4())
    sessions[session_id] = dict(
        ft=ft,
        md=md,
        an=an,
        combined=combined,
        has_coords=has_coords,
        lat_col=lat_col,
        lon_col=lon_col,
        source_task_id=None,
    )

    return {
        "session_id": session_id,
        "default_name": "",
        "has_coords": has_coords,
        "lat_col": lat_col,
        "lon_col": lon_col,
        "ft_shape": list(ft.shape),
        "md_shape": list(md.shape),
        "an_shape": list(an.shape) if an is not None else [0, 0],
        "ft_columns": _df_columns(ft),
        "md_columns": _df_columns(md),
        "ft_preview": _df_records(ft),
        "md_preview": _df_records(md),
        "an_preview": _df_records(an),
        "combined_preview": _df_records(combined),
    }


# ---------------------------------------------------------------------------
# Upload – GNPS task ID
# ---------------------------------------------------------------------------

@app.post("/api/upload/gnps")
async def upload_gnps(body: dict):
    task_id = body.get("task_id", "").strip()
    workflow = body.get("workflow", "fbmn")

    if not task_id:
        raise HTTPException(400, "task_id is required.")

    try:
        if workflow == "fbmn":
            ft, md, an = load_fbmn(task_id)
    except Exception as exc:
        raise HTTPException(400, f"Failed to load from GNPS: {exc}")

    if ft is None or ft.empty:
        raise HTTPException(400, "GNPS returned an empty feature table. Check the task ID.")

    ft = clean_feature_table(ft)
    md = clean_metadata_table(md) if md is not None and not md.empty else md or pd.DataFrame()

    has_coords, lat_col, lon_col = validate_coordinates(md)
    combined = create_combined_table(ft, md, an)

    session_id = str(uuid.uuid4())
    sessions[session_id] = dict(
        ft=ft,
        md=md,
        an=an,
        combined=combined,
        has_coords=has_coords,
        lat_col=lat_col,
        lon_col=lon_col,
        source_task_id=task_id,
    )

    return {
        "session_id": session_id,
        "default_name": task_id,
        "source_task_id": task_id,
        "has_coords": has_coords,
        "lat_col": lat_col,
        "lon_col": lon_col,
        "ft_shape": list(ft.shape),
        "md_shape": list(md.shape) if md is not None else [0, 0],
        "an_shape": list(an.shape) if an is not None else [0, 0],
        "ft_columns": _df_columns(ft),
        "md_columns": _df_columns(md),
        "ft_preview": _df_records(ft),
        "md_preview": _df_records(md),
        "an_preview": _df_records(an),
        "combined_preview": _df_records(combined),
    }


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

@app.get("/api/session/{session_id}/md-info")
async def session_md_info(session_id: str):
    sess = sessions.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    return {"columns_info": get_md_column_info(sess["md"])}


@app.post("/api/session/{session_id}/blank-removal-preview")
async def blank_removal_preview(session_id: str, body: dict):
    sess = sessions.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")

    ft = sess["ft"]
    md = sess["md"]
    sample_col = body.get("sample_column")
    sample_vals = body.get("sample_rows", [])
    blank_col = body.get("blank_column")
    blank_vals = body.get("blank_rows", [])
    cutoff = float(body.get("cutoff", 0.3))

    try:
        sample_idx = md[md[sample_col].isin(sample_vals)].index
        blank_idx = md[md[blank_col].isin(blank_vals)].index
        samples_df = ft[ft.columns.intersection(sample_idx)]
        blanks_df = ft[ft.columns.intersection(blank_idx)]

        ft_cleaned, n_bg, n_real = remove_blank_features(blanks_df, samples_df, cutoff)
        sess["ft_cleaned"] = ft_cleaned
    except Exception as exc:
        raise HTTPException(400, f"Blank removal failed: {exc}")

    return {"n_background": n_bg, "n_real": n_real, "new_shape": list(ft_cleaned.shape)}


# ---------------------------------------------------------------------------
# Save dataset
# ---------------------------------------------------------------------------

@app.post("/api/dataset/save")
async def save_dataset(body: dict):
    session_id = body.get("session_id", "")
    name = body.get("name", "").strip()
    do_impute = bool(body.get("impute", False))

    if not name:
        raise HTTPException(400, "Dataset name is required.")
    if not session_id or session_id not in sessions:
        raise HTTPException(404, "Session not found or expired.")

    safe = _safe_name(name)
    dataset_dir = DATASETS_DIR / safe

    if dataset_dir.exists():
        raise HTTPException(409, f"A dataset named '{name}' already exists.")

    dataset_dir.mkdir(parents=True)
    sess = sessions[session_id]

    if not sess.get("has_coords", False):
        raise HTTPException(
            400,
            "Dataset cannot be saved: metadata must include Latitude and Longitude columns.",
        )

    ft: pd.DataFrame = sess.get("ft_cleaned", sess["ft"]).copy()
    md: pd.DataFrame = sess["md"].copy()
    an: Optional[pd.DataFrame] = sess.get("an")

    if do_impute:
        ft = impute_missing_values(ft)

    combined = create_combined_table(ft, md, an)

    # Save as parquet (fast, compact)
    ft.to_parquet(dataset_dir / "ft.parquet")
    md.to_parquet(dataset_dir / "md.parquet")
    if an is not None and not an.empty:
        an.to_parquet(dataset_dir / "an.parquet")
    if combined is not None and not combined.empty:
        combined.to_parquet(dataset_dir / "combined.parquet")


    meta = {
        "name": name,
        "safe_name": safe,
        "source_task_id": sess.get("source_task_id"),
        "has_coords": sess["has_coords"],
        "lat_col": sess["lat_col"],
        "lon_col": sess["lon_col"],
        "n_samples": int(md.shape[0]),
        "n_features": int(ft.shape[0]),
        "has_annotation": an is not None and not an.empty,
        "md_columns": list(md.columns),
    }
    (dataset_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    # Invalidate caches
    DATASET_DF_CACHE.pop(safe, None)
    keys_to_del = [k for k in PCOA_CACHE if k[0] == safe]
    for k in keys_to_del:
        PCOA_CACHE.pop(k, None)

    del sessions[session_id]
    return {"success": True, "name": name, "safe_name": safe}


# ---------------------------------------------------------------------------
# Dataset library
# ---------------------------------------------------------------------------

@app.get("/api/datasets")
async def list_datasets():
    result = []
    for d in DATASETS_DIR.iterdir():
        meta_path = d / "meta.json"
        if d.is_dir() and meta_path.exists():
            result.append(json.loads(meta_path.read_text()))
    return result


@app.delete("/api/datasets/{safe_name}")
async def delete_dataset(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found.")
    shutil.rmtree(dataset_dir)
    # Invalidate caches
    DATASET_DF_CACHE.pop(safe_name, None)
    keys_to_del = [k for k in PCOA_CACHE if k[0] == safe_name]
    for k in keys_to_del:
        PCOA_CACHE.pop(k, None)
    return {"success": True}


@app.get("/api/datasets/{safe_name}/table/{table_name}")
async def get_dataset_table(safe_name: str, table_name: str):
    allowed = {"ft", "md", "an", "combined"}
    if table_name not in allowed:
        raise HTTPException(400, f"table_name must be one of {allowed}")
    path = DATASETS_DIR / safe_name / f"{table_name}.parquet"
    if not path.exists():
        return {"data": [], "columns": []}
    df = pd.read_parquet(path)
    return {"data": _df_records(df), "columns": _df_columns(df)}


# ---------------------------------------------------------------------------
# Map data  (one point per sample, common metadata = intersection across datasets)
# ---------------------------------------------------------------------------

@app.get("/api/map/data")
async def get_map_data():
    """
    One point per sample across all datasets.
    common_metadata = intersection of metadata columns present in every dataset
    that has coordinates, ensuring filters/colours are valid for every point.
    """
    all_points: list[pd.DataFrame] = []
    total_features = 0
    dataset_names: list[str] = []
    dataset_safe_map: dict[str, str] = {}
    md_columns_per_dataset: list[set] = []   # for computing intersection
    datasets_details: list[dict] = []

    for d in DATASETS_DIR.iterdir():
        meta_path = d / "meta.json"
        md_path = d / "md.parquet"

        if not d.is_dir() or not meta_path.exists():
            continue

        meta = json.loads(meta_path.read_text())
        dataset_names.append(meta["name"])
        dataset_safe_map[str(meta["name"])] = str(meta.get("safe_name", d.name))
        total_features += meta.get("n_features", 0)

        # Collect detailed info for each dataset
        datasets_details.append({
            "name": meta["name"],
            "safe_name": meta.get("safe_name", d.name),
            "n_samples": meta.get("n_samples", 0),
            "n_features": meta.get("n_features", 0),
            "has_coords": meta.get("has_coords", False)
        })

        if not meta.get("has_coords") or not md_path.exists():
            continue

        lat_col = _find_column_case_insensitive(md := pd.read_parquet(md_path), meta.get("lat_col"))
        lon_col = _find_column_case_insensitive(md, meta.get("lon_col"))
        if not lat_col or not lon_col:
            # Skip malformed coordinate metadata instead of crashing the whole map payload.
            continue

        md["_dataset"] = meta["name"]
        md["_dataset_safe"] = meta.get("safe_name", d.name)
        md_reset = md.reset_index()
        fallback_ids = [f"row_{i}" for i in range(len(md_reset))]
        if "filename" in md_reset.columns:
            candidate_ids = md_reset["filename"].astype(str)
            md["_sample_id"] = np.where(candidate_ids.str.strip().ne(""), candidate_ids, fallback_ids)
        else:
            index_ids = md.index.astype(str)
            md["_sample_id"] = np.where(pd.Series(index_ids).str.strip().ne(""), index_ids, fallback_ids)
        md["_lat"] = pd.to_numeric(md[lat_col], errors="coerce")
        md["_lon"] = pd.to_numeric(md[lon_col], errors="coerce")

        # Ensure the filename (first column of metadata) is included as a regular column
        filename_col = md.index.name or "filename"
        md[filename_col] = md.index.astype(str)

        md = md.dropna(subset=["_lat", "_lon"])

        if md.empty:
            continue

        md_columns_per_dataset.append(set(meta.get("md_columns", [])))
        all_points.append(md.copy())

    if not all_points:
        return {
            "points": [],
            "datasets": dataset_names,
            "datasets_details": datasets_details,
            "dataset_safe_map": dataset_safe_map,
            "total_samples": 0,
            "total_features": total_features,
            "common_metadata": [],
        }

    # Columns present in EVERY plotted dataset → valid filter/colour options
    if md_columns_per_dataset:
        common_cols = set.intersection(*md_columns_per_dataset)
    else:
        common_cols = set()

    combined = pd.concat(all_points, ignore_index=True)
    combined = combined.fillna("N/A")

    common_meta = sorted(c for c in common_cols if c in combined.columns)

    return {
        "points": json.loads(combined.to_json(orient="records", default_handler=str)),
        "datasets": dataset_names,
        "datasets_details": datasets_details,
        "dataset_safe_map": dataset_safe_map,
        "total_samples": len(combined),
        "total_features": total_features,
        "common_metadata": common_meta,
    }


@app.post("/api/map/metabolite-features")
async def get_metabolite_features(body: dict):
    row_id_q = str(body.get("row_id", "")).strip().lower()
    rt_q = str(body.get("row_retention_time", "")).strip().lower()
    mz_q = str(body.get("row_mz", "")).strip().lower()
    annotation_q = str(body.get("annotation", "")).strip().lower()
    metabolite_q = str(body.get("metabolite", "")).strip().lower()
    has_annotation_q = body.get("has_annotation", False)
    if isinstance(has_annotation_q, str):
        has_annotation_q = has_annotation_q.lower() == "true"

    dataset_safes_raw = body.get("dataset_safes") or []
    dataset_safes = {str(x).strip() for x in dataset_safes_raw if str(x).strip()}

    limit = int(body.get("limit", 200))
    limit = max(1, min(limit, 1000))

    features_out = []

    for d in DATASETS_DIR.iterdir():
        if not d.is_dir():
            continue

        meta_path = d / "meta.json"
        md_path = d / "md.parquet"
        ft_path = d / "ft.parquet"
        an_path = d / "an.parquet"
        if not meta_path.exists() or not md_path.exists() or not ft_path.exists():
            continue

        meta = json.loads(meta_path.read_text())
        dataset_safe = str(meta.get("safe_name", d.name))
        dataset_name = str(meta.get("name", d.name))
        if dataset_safes and dataset_safe not in dataset_safes:
            continue

        md = pd.read_parquet(md_path)
        lat_col = _find_column_case_insensitive(md, meta.get("lat_col"))
        lon_col = _find_column_case_insensitive(md, meta.get("lon_col"))
        if not lat_col or not lon_col:
            continue

        md.index = md.index.astype(str)
        md["_lat"] = pd.to_numeric(md[lat_col], errors="coerce")
        md["_lon"] = pd.to_numeric(md[lon_col], errors="coerce")

        md_reset = md.reset_index()
        fallback_ids = [f"row_{i}" for i in range(len(md_reset))]
        if "filename" in md_reset.columns:
            candidate_ids = md_reset["filename"].astype(str)
            md["_sample_id"] = np.where(candidate_ids.str.strip().ne(""), candidate_ids, fallback_ids)
        else:
            index_ids = md.index.astype(str)
            md["_sample_id"] = np.where(pd.Series(index_ids).str.strip().ne(""), index_ids, fallback_ids)

        md_valid = md.dropna(subset=["_lat", "_lon"])
        if md_valid.empty:
            continue

        valid_sample_ids = set(md_valid.index.astype(str))

        ft = pd.read_parquet(ft_path)
        ft.columns = [str(c) for c in ft.columns]
        ft.index = ft.index.astype(str)

        sample_cols = [c for c in ft.columns if c in valid_sample_ids]
        if not sample_cols:
            continue

        annotation_map: dict[str, str] = {}
        if an_path.exists():
            an = pd.read_parquet(an_path)
            if not an.empty:
                name_col = next(
                    (c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns),
                    None,
                )
                scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
                if name_col and scan_col:
                    an_copy = an[[scan_col, name_col]].copy()
                    an_copy[scan_col] = an_copy[scan_col].astype(str)
                    an_copy[name_col] = an_copy[name_col].astype(str)
                    annotation_map = dict(zip(an_copy[scan_col], an_copy[name_col]))

        for feature_key, row in ft[sample_cols].iterrows():
            feature_str = str(feature_key)
            parsed_row_id, parsed_mz, parsed_rt = _parse_feature_parts(feature_str)
            annotation_name = str(annotation_map.get(parsed_row_id, ""))
            if annotation_name == "nan":
                annotation_name = ""

            if row_id_q and row_id_q not in parsed_row_id.lower():
                continue
            if mz_q and mz_q not in ("" if parsed_mz is None else str(parsed_mz).lower()):
                continue
            if rt_q and rt_q not in ("" if parsed_rt is None else str(parsed_rt).lower()):
                continue
            if annotation_q and annotation_q not in annotation_name.lower():
                continue
            if metabolite_q and metabolite_q not in feature_str.lower() and metabolite_q not in annotation_name.lower():
                continue
            if has_annotation_q and not annotation_name:
                continue

            present_samples = []
            detected_count = 0
            for sample_col in sample_cols:
                intensity = row[sample_col]
                if pd.isna(intensity):
                    continue
                try:
                    intensity_num = float(intensity)
                    if intensity_num < 0:
                        continue
                except Exception:
                    continue

                lat_val = md_valid.loc[sample_col, "_lat"]
                lon_val = md_valid.loc[sample_col, "_lon"]
                if isinstance(lat_val, pd.Series):
                    lat_val = lat_val.iloc[0]
                if isinstance(lon_val, pd.Series):
                    lon_val = lon_val.iloc[0]

                present_samples.append(
                    {
                        "dataset": dataset_name,
                        "dataset_safe": dataset_safe,
                        "sample_id": str(sample_col),
                        "lat": float(lat_val),
                        "lon": float(lon_val),
                        "intensity": intensity_num,
                    }
                )
                if intensity_num > 0:
                    detected_count += 1

            if not present_samples:
                continue

            features_out.append(
                {
                    "metabolite": feature_str,
                    "row_id": parsed_row_id,
                    "row_mz": parsed_mz,
                    "row_retention_time": parsed_rt,
                    "annotation": annotation_name or None,
                    "sample_count": len(present_samples),
                    "detected_sample_count": detected_count,
                    "dataset": dataset_name,
                    "dataset_safe": dataset_safe,
                    "present_samples": present_samples,
                }
            )

    features_out.sort(
        key=lambda x: (x["sample_count"], x["metabolite"]),
        reverse=True,
    )

    return {
        "features": features_out[:limit],
        "total": len(features_out),
    }


@app.get("/api/map/sample-details")
async def get_map_sample_details(
    dataset_safe: str,
    lat: float,
    lon: float,
    sample_id: Optional[str] = None,
):
    dataset_dir = DATASETS_DIR / dataset_safe
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found.")

    md_path = dataset_dir / "md.parquet"
    ft_path = dataset_dir / "ft.parquet"
    an_path = dataset_dir / "an.parquet"
    meta_path = dataset_dir / "meta.json"

    if not md_path.exists() or not ft_path.exists() or not meta_path.exists():
        raise HTTPException(404, "Dataset files are missing.")

    meta = json.loads(meta_path.read_text())
    lat_col = _find_column_case_insensitive(md := pd.read_parquet(md_path), meta.get("lat_col"))
    lon_col = _find_column_case_insensitive(md, meta.get("lon_col"))
    if not lat_col or not lon_col:
        raise HTTPException(400, "Dataset is missing coordinate column metadata.")

    md.index = md.index.astype(str)

    matched_sample_id: Optional[str] = None
    sample_id_hint = str(sample_id).strip() if sample_id is not None else ""
    if sample_id_hint and sample_id_hint in md.index:
        matched_sample_id = sample_id_hint
    else:
        md_lat = pd.to_numeric(md[lat_col], errors="coerce")
        md_lon = pd.to_numeric(md[lon_col], errors="coerce")
        valid = md_lat.notna() & md_lon.notna()
        if not valid.any():
            raise HTTPException(404, "No valid coordinates found in dataset metadata.")

        subset = md.loc[valid].copy()
        subset["_lat_num"] = md_lat.loc[valid]
        subset["_lon_num"] = md_lon.loc[valid]

        tol = 1e-4
        exact = subset[
            ((subset["_lat_num"] - float(lat)).abs() <= tol)
            & ((subset["_lon_num"] - float(lon)).abs() <= tol)
        ]

        if not exact.empty:
            matched_sample_id = str(exact.index[0])
        else:
            # Fallback to nearest sample to the clicked coordinates.
            dist = (subset["_lat_num"] - float(lat)) ** 2 + (subset["_lon_num"] - float(lon)) ** 2
            matched_sample_id = str(dist.idxmin())

    if not matched_sample_id or matched_sample_id not in md.index:
        raise HTTPException(404, "Could not resolve sample from coordinates.")

    sample_row = md.loc[matched_sample_id]
    if isinstance(sample_row, pd.DataFrame):
        sample_row = sample_row.iloc[0]

    sample_dict = sample_row.to_dict()
    attribute_keys = [k for k in sample_dict.keys() if str(k).startswith("ATTRIBUTE_")]
    keys_to_return = attribute_keys if attribute_keys else list(sample_dict.keys())
    metadata = {
        str(k): ("N/A" if pd.isna(sample_dict.get(k)) else str(sample_dict.get(k)))
        for k in keys_to_return
    }

    # Always guarantee the original filename column is explicitly in the metadata list
    filename_col = md.index.name or "filename"
    metadata[str(filename_col)] = str(matched_sample_id)

    ft = pd.read_parquet(ft_path)

    # Exact match first (fast path — both cleaned by data_processor so should align)
    feature_col: Optional[str] = None
    if matched_sample_id in ft.columns:
        feature_col = matched_sample_id
    else:
        # Build fuzzy candidate list for legacy or GNPS datasets
        candidate_sample_keys: list[str] = [matched_sample_id]
        for ext in (".mzML", ".mzXML", ".raw"):
            candidate_sample_keys.append(matched_sample_id + ext)
        for maybe_col in ("filename", "sample", "sample_id", "sample_name"):
            if maybe_col in sample_row.index:
                val = str(sample_row[maybe_col])
                candidate_sample_keys.extend([val, val + ".mzML", val + ".mzXML"])
        feature_col = _resolve_ft_sample_column(ft, candidate_sample_keys)

    if not feature_col:
        return {
            "dataset_safe": dataset_safe,
            "sample_id": matched_sample_id,
            "query_lat": float(lat),
            "query_lon": float(lon),
            "metadata": metadata,
            "metabolites": [],
        }

    # Only include features detected in this specific sample (non-zero, non-null intensity)
    sample_features = ft[feature_col]

    annotation_map: dict[str, str] = {}
    if an_path.exists():
        an = pd.read_parquet(an_path)
        if not an.empty:
            name_col = next(
                (c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns),
                None,
            )
            scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
            if name_col and scan_col:
                an_copy = an[[scan_col, name_col]].copy()
                an_copy[scan_col] = an_copy[scan_col].astype(str)
                an_copy[name_col] = an_copy[name_col].astype(str)
                annotation_map = dict(zip(an_copy[scan_col], an_copy[name_col]))

    metabolites = []
    for metabolite_id, intensity in sample_features.items():
        # Skip features not detected in this sample (zero or missing intensity).
        if pd.isna(intensity) or float(intensity) == 0:
            continue
        metabolite_id_str = str(metabolite_id)
        row_id = metabolite_id_str.split("_", 1)[0]
        annotation_name = annotation_map.get(row_id)
        if annotation_name and annotation_name != "nan":
            label = f"{metabolite_id_str} | {annotation_name}"
        else:
            label = metabolite_id_str
        metabolites.append(
            {
                "metabolite": metabolite_id_str,
                "annotation": None if not annotation_name or annotation_name == "nan" else annotation_name,
                "label": label,
                "intensity": None if pd.isna(intensity) else float(intensity),
            }
        )

    metabolites.sort(
        key=lambda x: x["intensity"] if x["intensity"] is not None else float("-inf"),
        reverse=True,
    )

    return {
        "dataset_safe": dataset_safe,
        "sample_id": matched_sample_id,
        "query_lat": float(lat),
        "query_lon": float(lon),
        "metadata": metadata,
        "metabolites": metabolites,
    }


@app.get("/api/datasets/{safe_name}/metadata-schema")
async def get_dataset_metadata_schema(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")
    md_path = dataset_dir / "md.parquet"
    if not md_path.exists():
        return {"columns": [], "categories": {}, "samples": []}

    md, _ = get_cached_dataset(safe_name, dataset_dir)
    if md is None:
        raise HTTPException(400, "Dataset files missing")

    md.index = md.index.astype(str)
    metadata_cols = sorted([c for c in md.columns if not c.startswith('_')])

    categories = {}
    for col in metadata_cols:
        cats = sorted([str(x) for x in md[col].dropna().unique() if str(x).strip() != ''])
        categories[col] = cats

    # Build a lightweight list of all samples and their relevant metadata
    samples_list = []
    for idx, row in md.iterrows():
        sample_data = {
            "sample_id": str(idx),
        }
        for col in metadata_cols:
            val = row.get(col)
            sample_data[col] = "N/A" if pd.isna(val) else str(val)
        samples_list.append(sample_data)

    return {
        "columns": metadata_cols,
        "categories": categories,
        "samples": samples_list
    }


@app.get("/api/datasets/{safe_name}/metabolites")
async def get_dataset_metabolites(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    ft_path = dataset_dir / "ft.parquet"
    if not ft_path.exists():
        raise HTTPException(404, "Feature table missing")

    ft = pd.read_parquet(ft_path)

    # Calculate max intensity for each metabolite for sorting
    # Use max() as it represents the highest detection signal
    metas = []
    for idx, row in ft.iterrows():
        metas.append({
            "id": str(idx),
            "max_intensity": float(row.max())
        })

    # Sort by max intensity descending
    metas.sort(key=lambda x: x["max_intensity"], reverse=True)

    return {"metabolites": metas}


@app.post("/api/datasets/{safe_name}/boxplot-data")
async def get_boxplot_data(safe_name: str, body: dict):
    metabolite = body.get("metabolite")
    samples = body.get("samples", [])

    if not metabolite:
        raise HTTPException(400, "Metabolite ID is required")

    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    ft_path = dataset_dir / "ft.parquet"
    md_path = dataset_dir / "md.parquet"

    if not ft_path.exists() or not md_path.exists():
        raise HTTPException(404, "Dataset files missing")

    ft = pd.read_parquet(ft_path)
    md = pd.read_parquet(md_path)

    if metabolite not in ft.index:
        # Try fuzzy match if exact fails (e.g. string vs int index)
        ft.index = ft.index.astype(str)
        if str(metabolite) not in ft.index:
            raise HTTPException(404, f"Metabolite '{metabolite}' not found in dataset")
        metabolite = str(metabolite)

    # Get intensities for the metabolite
    row = ft.loc[metabolite]

    # If samples are provided, filter by them
    if samples:
        # Ensure sample IDs are strings and exist in columns
        samples = [str(s) for s in samples]
        available_samples = [s for s in samples if s in row.index]
        intensities = row[available_samples]
    else:
        intensities = row

    # Prepare data for boxplot: list of {sample: ID, intensity: VAL, metadata: ...}
    plot_data = []
    for sample_id, val in intensities.items():
        if pd.isna(val):
            continue

        sample_meta = {}
        if sample_id in md.index:
            sample_meta = md.loc[sample_id].to_dict()

        plot_data.append({
            "sample_id": str(sample_id),
            "intensity": float(val),
            "metadata": {str(k): str(v) for k, v in sample_meta.items() if not str(k).startswith('_')}
        })

    return {
        "metabolite": metabolite,
        "data": plot_data
    }


@app.post("/api/map/pcoa")
async def run_map_pcoa(body: dict):
    dataset_safe = body.get("dataset_safe")
    if not dataset_safe:
        raise HTTPException(400, "dataset_safe is required")

    dataset_dir = DATASETS_DIR / dataset_safe
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    md, ft = get_cached_dataset(dataset_safe, dataset_dir)
    if md is None or ft is None:
        raise HTTPException(400, "Dataset files missing")

    md.index = md.index.astype(str)
    ft.columns = [str(c) for c in ft.columns]
    ft.index = ft.index.astype(str)

    # Resolve filename or _sample_id
    md_reset = md.reset_index()
    fallback_ids = [f"row_{i}" for i in range(len(md_reset))]
    if "filename" in md_reset.columns:
        candidate_ids = md_reset["filename"].astype(str)
        md["_sample_id"] = np.where(candidate_ids.str.strip().ne(""), candidate_ids, fallback_ids)
    else:
        index_ids = md.index.astype(str)
        md["_sample_id"] = np.where(pd.Series(index_ids).str.strip().ne(""), index_ids, fallback_ids)

    # Available samples
    all_sample_ids = list(md.index)
    all_metadata_cols = sorted(list(md.columns))

    # Clean metadata columns to remove internal columns starting with '_'
    metadata_cols = [c for c in all_metadata_cols if not c.startswith('_')]

    # Get inputs
    distance_metric = body.get("distance_metric", "braycurtis")
    attribute = body.get("attribute") or (metadata_cols[0] if metadata_cols else None)

    # Selected categories to filter on
    selected_categories = body.get("categories")
    selected_samples = body.get("samples")
    color_by = body.get("color_by") or attribute

    # Unique non-null categories for the attribute
    all_categories = []
    if attribute and attribute in md.columns:
        all_categories = sorted([str(x) for x in md[attribute].dropna().unique() if str(x).strip() != ''])

    # Filtering samples
    filtered_md = md.copy()
    if attribute and attribute in filtered_md.columns:
        filtered_md = filtered_md[filtered_md[attribute].notna()]
        if selected_categories is not None:
            filtered_md = filtered_md[filtered_md[attribute].astype(str).isin(selected_categories)]

    # Use the sample mapping logic to ensure robust sample ID matching
    if selected_samples is not None:
        # Match selected_samples against the resolved _sample_id
        filtered_md = filtered_md[filtered_md["_sample_id"].isin(selected_samples)]

    sample_cols = [c for c in ft.columns if c in filtered_md.index]

    if len(sample_cols) < 2:
        return {
            "all_sample_ids": all_sample_ids,
            "metadata_columns": metadata_cols,
            "all_categories": all_categories,
            "error": "At least 2 samples are required to perform PCoA. Currently only " + str(len(sample_cols)) + " sample(s) available after filtering."
        }

    # Extract and transpose feature table
    X_df = ft[sample_cols].T.fillna(0.0)
    # Filter out features with all zeros (to avoid zero variance/distance issues)
    X_df = X_df.loc[:, (X_df != 0).any(axis=0)]

    # Sort index to match FBMN-STATS-Webapp behavior exactly
    X_df.sort_index(inplace=True)

    perm_md = filtered_md[filtered_md[color_by].notna()].copy()
    perm_md.sort_index(inplace=True)

    n_unique = perm_md[color_by].nunique()
    min_per_cat = perm_md[color_by].value_counts().min() if n_unique > 0 else 0
    can_permanova = n_unique >= 2 and min_per_cat >= 2

    # Check PCoA Eigendecomposition and Distance Matrix Cache
    # We must sort sample_cols here to ensure cache key matches
    sorted_samples = tuple(X_df.index)
    cache_key = (dataset_safe, distance_metric, sorted_samples)
    pcoa = PCOA_CACHE.get(cache_key)

    permanova_df = None

    try:
        from scipy.spatial import distance as scipy_distance
        # Compute distance matrix
        d_vals = scipy_distance.pdist(X_df.values, metric=distance_metric)
        D = scipy_distance.squareform(d_vals)
        distance_matrix = skbio.stats.distance.DistanceMatrix(
            D,
            ids=X_df.index,
        )

        if pcoa is None:
            pcoa = skbio.stats.ordination.pcoa(distance_matrix)
            PCOA_CACHE[cache_key] = pcoa

        if can_permanova:
            permanova_groups = perm_md.loc[X_df.index, color_by]
            permanova = skbio.stats.distance.permanova(distance_matrix, permanova_groups)
            permanova["R2"] = 1 - 1 / (1 + permanova["test statistic"] * permanova["number of groups"] / (permanova["sample size"] - permanova["number of groups"] - 1))
            permanova_res = permanova.to_frame(name="PERMANOVA results").reset_index()
            permanova_res.columns = ["Metric", "Value"]
            permanova_res["Value"] = permanova_res["Value"].apply(lambda x: str(x) if not isinstance(x, (int, float)) else x)
            permanova_df = permanova_res.to_dict(orient="records")

    except Exception as e:
        return {
            "all_sample_ids": all_sample_ids,
            "metadata_columns": metadata_cols,
            "all_categories": all_categories,
            "error": f"Failed to compute PCoA or PERMANOVA: {str(e)}"
        }

    n = len(sample_cols)
    top_k = min(10, n)

    pcoa_x_axis = body.get("x_axis", "PC1")
    pcoa_y_axis = body.get("y_axis", "PC2")

    df = pcoa.samples[[pcoa_x_axis, pcoa_y_axis]].copy()

    cols_to_merge = [color_by]
    if attribute and attribute != color_by:
        cols_to_merge.append(attribute)

    df = pd.merge(
        df,
        filtered_md[cols_to_merge].apply(lambda c: c.apply(str)),
        left_index=True,
        right_index=True,
    )

    symbol_col = attribute if attribute else color_by

    fig_scatter = px.scatter(
        df,
        x=pcoa_x_axis,
        y=pcoa_y_axis,
        template="plotly_dark",
        color=color_by,
        symbol=symbol_col,
        hover_name=df.index,
    )

    x_expl = pcoa.proportion_explained.iloc[int(pcoa_x_axis[2:]) - 1] * 100
    y_expl = pcoa.proportion_explained.iloc[int(pcoa_y_axis[2:]) - 1] * 100

    fig_scatter.update_layout(
        font={"color": "grey", "size": 12, "family": "Sans"},
        title={"text": "PRINCIPAL COORDINATE ANALYSIS", "font_color": "#ffffff"},
        xaxis_title=f"{pcoa_x_axis} ({round(x_expl, 1)}%)",
        yaxis_title=f"{pcoa_y_axis} ({round(y_expl, 1)}%)",
        autosize=True,
        margin=dict(l=40, r=40, t=40, b=40),
        yaxis=dict(
            scaleanchor="x",
            scaleratio=1
        )
    )

    percent_variance = np.round(pcoa.proportion_explained[:10] * 100, decimals=2)
    fig_var = px.bar(
        x=pcoa.samples.columns[:10],
        y=percent_variance,
        template="plotly_dark",
    )
    fig_var.update_traces(marker_color="#696880", width=0.5)
    fig_var.update_layout(
        font={"color": "grey", "size": 12, "family": "Sans"},
        title={"text": "PCoA - VARIANCE", "x": 0.5, "font_color": "#ffffff"},
        xaxis_title="principal component",
        yaxis_title="variance (%)",
        autosize=True,
        margin=dict(l=40, r=40, t=40, b=40)
    )

    # Prepare sample details for coordinates
    coordinate_details = []
    for s_id in sample_cols:
        row_coords = pcoa.samples.loc[s_id].to_dict()
        row_md = filtered_md.loc[s_id]
        color_val = str(row_md.get(color_by, "N/A")) if color_by else "N/A"
        shape_val = str(row_md.get(attribute, "N/A")) if attribute else "N/A"
        coordinate_details.append({
            "sample_id": s_id,
            "color_value": color_val,
            "shape_value": shape_val,
            "coordinates": {f"PC{k+1}": float(row_coords.get(f"PC{k+1}", 0.0)) for k in range(top_k)}
        })

    # Replace NaN values with "N/A" for JSON serialization compliance
    filtered_metadata_records = filtered_md.reset_index().fillna("N/A").to_dict(orient="records")

    return {
        "all_sample_ids": all_sample_ids,
        "metadata_columns": metadata_cols,
        "all_categories": all_categories,
        "coordinates": coordinate_details,
        "scatter_plot": json.loads(fig_scatter.to_json()),
        "variance_plot": json.loads(fig_var.to_json()),
        "proportion_explained": pcoa.proportion_explained.tolist(),
        "permanova": permanova_df,
        "filtered_metadata": filtered_metadata_records
    }


def _formula_from_inchi(inchi: str) -> Optional[str]:
    """Extract the molecular formula layer from an InChI string."""
    if not isinstance(inchi, str):
        return None
    iv = inchi.strip()
    if iv.startswith("InChI=") and "/" in iv:
        parts = iv.split("/")
        if len(parts) >= 2 and parts[1].strip():
            return parts[1].strip()
    return None


def _formula_from_smiles(smiles: str) -> Optional[str]:
    """Convert a SMILES string to a molecular formula (requires RDKit)."""
    if not _RDKIT_AVAILABLE or not isinstance(smiles, str):
        return None
    smi = smiles.strip()
    if not smi or smi.lower() == "nan":
        return None
    try:
        mol = _rd_Chem.MolFromSmiles(smi)
        if mol is None:
            return None
        return _rd_md.CalcMolFormula(mol)
    except Exception:
        return None


def _resolve_row_formula(row, formula_col=None, inchi_col=None, smiles_col=None) -> tuple[str, str]:
    """Resolve (molecular_formula, source) for one annotation row.

    Priority: explicit formula column (SIRIUS/ZODIAC or library match) → InChI → SMILES.
    Returns ("", "") when nothing usable is found.
    """
    if formula_col and formula_col in row.index:
        val = row[formula_col]
        if not pd.isna(val):
            f = str(val).strip()
            if f and f.lower() != "nan":
                return f, "sirius_or_library"
    if inchi_col and inchi_col in row.index:
        f = _formula_from_inchi(str(row[inchi_col]))
        if f:
            return f, "inchi"
    if smiles_col and smiles_col in row.index:
        f = _formula_from_smiles(str(row[smiles_col]))
        if f:
            return f, "smiles"
    return "", ""


def _get_annotated_scans(
    an: pd.DataFrame,
    scan_col: Optional[str],
    formula_col: Optional[str],
    include_msbuddy: bool = False,
) -> set:
    """Return normalized scan IDs that carry a molecular formula from ANY source.

    Sources: formula column (SIRIUS/ZODIAC/library), InChI, SMILES (with RDKit).
    MSBuddy-predicted rows are excluded unless include_msbuddy=True.
    """
    if an.empty or not scan_col or scan_col not in an.columns:
        return set()

    inchi_col = next((c for c in an.columns if c.lower() == "inchi"), None)
    smiles_col = next((c for c in an.columns if c.lower() in ("smiles", "smile")), None)

    has_formula = pd.Series(False, index=an.index)
    if formula_col and formula_col in an.columns:
        s = an[formula_col].astype(str).str.strip()
        has_formula |= an[formula_col].notna() & s.ne("") & s.str.lower().ne("nan")
    if inchi_col:
        s = an[inchi_col].astype(str).str.strip()
        has_formula |= s.str.startswith("InChI=") & s.str.contains("/") & s.str.split("/").str[1].str.strip().ne("")
    if smiles_col and _RDKIT_AVAILABLE:
        s = an[smiles_col].astype(str).str.strip()
        has_formula |= s.ne("") & s.str.lower().ne("nan")

    if not include_msbuddy:
        if "SpectrumID" in an.columns:
            has_formula &= ~an["SpectrumID"].astype(str).str.startswith("MSB_")
        if "Compound_Name" in an.columns:
            has_formula &= ~an["Compound_Name"].astype(str).str.startswith("MSBuddy:")

    scans = set()
    for sid in an.loc[has_formula, scan_col].astype(str).values:
        if sid.endswith(".0"):
            sid = sid[:-2]
        scans.add(sid)
    return scans


def calculate_ratios_from_formula(formula: str) -> tuple[Optional[float], Optional[float]]:
    if not isinstance(formula, str) or not formula or pd.isna(formula):
        return None, None
    pattern = r'([A-Z][a-z]*)(\d*)'
    matches = re.findall(pattern, formula)
    
    counts = {}
    for elem, count_str in matches:
        count = int(count_str) if count_str else 1
        counts[elem] = counts.get(elem, 0) + count
        
    c = counts.get('C', 0)
    h = counts.get('H', 0)
    o = counts.get('O', 0)
    
    if c == 0:
        return None, None
        
    return o / c, h / c


def calculate_carbon_oxidation_state(formula: str) -> Optional[float]:
    """Calculate Carbon Oxidation State (COS) from molecular formula.
    
    COS = (2*O + N - H) / C
    
    Returns COS value or None if formula is invalid.
    """
    if not isinstance(formula, str) or not formula or pd.isna(formula):
        return None
    pattern = r'([A-Z][a-z]*)(\d*)'
    matches = re.findall(pattern, formula)
    
    counts = {}
    for elem, count_str in matches:
        count = int(count_str) if count_str else 1
        counts[elem] = counts.get(elem, 0) + count
        
    c = counts.get('C', 0)
    if c == 0:
        return None
    
    o = counts.get('O', 0)
    n = counts.get('N', 0)
    h = counts.get('H', 0)
    
    return (2 * o + n - h) / c


def classify_by_formula_ratios(formula: str, o_c: float, h_c: float) -> str:
    pattern = r'([A-Z][a-z]*)(\d*)'
    matches = re.findall(pattern, formula)
    counts = {}
    for elem, count_str in matches:
        count = int(count_str) if count_str else 1
        counts[elem] = counts.get(elem, 0) + count
        
    n = counts.get('N', 0)
    
    if o_c < 0.3 and h_c >= 1.5:
        return "Lipids"
    elif 0.3 <= o_c <= 0.6 and 1.5 <= h_c <= 2.2 and n > 0:
        return "Amino Acids / Peptides"
    elif o_c >= 0.6 and h_c >= 1.5:
        return "Carbohydrates"
    elif o_c <= 0.1 and h_c < 0.5:
        return "Condensed Aromatics"
    elif 0.1 < o_c < 0.6 and 0.5 <= h_c <= 1.5:
        return "Lignins"
    elif o_c < 0.1 and 1.0 <= h_c < 1.5:
        return "Unsaturated Hydrocarbons"
    elif n > 0:
        return "Alkaloids / Organonitrogen"
    else:
        return "Aliphatic Organics"


def apply_fdr_correction(p_values: list[float]) -> list[float]:
    """Apply Benjamini-Hochberg FDR correction."""
    n = len(p_values)
    if n == 0: return []
    indexed_ps = sorted(enumerate(p_values), key=lambda x: x[1])
    adj_ps = [0] * n
    prev_adj_p = 1.0
    for i in range(n - 1, -1, -1):
        idx, p = indexed_ps[i]
        adj_p = min(prev_adj_p, p * n / (i + 1))
        adj_ps[idx] = adj_p
        prev_adj_p = adj_p
    return adj_ps


@app.get("/api/datasets/{safe_name}/vankrevelen")
async def get_dataset_vankrevelen(
    safe_name: str,
    show_msbuddy: bool = False
):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")

    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    md_path = dataset_dir / "md.parquet"
    meta_path = dataset_dir / "meta.json"

    if not an_path.exists() or not ft_path.exists():
        return {
            "points": [], "total_points": 0, "message": "Required files missing.",
            "unannotated_significant_count": 0, "total_features": 0
        }

    an = pd.read_parquet(an_path)
    ft = pd.read_parquet(ft_path)
    md = pd.read_parquet(md_path) if md_path.exists() else pd.DataFrame()
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    if ft.empty:
        return {"points": [], "total_points": 0, "total_features": 0}

    scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
    formula_col = next((c for c in an.columns if c.lower() in ["molecular_formula", "formula"]), None)
    inchi_col = next((c for c in an.columns if c.lower() == "inchi"), None)
    smiles_col = next((c for c in an.columns if c.lower() in ("smiles", "smile")), None)

    # Scans carrying a formula from ANY source (SIRIUS/ZODIAC, library match, InChI, SMILES)
    annotated_scans = _get_annotated_scans(an, scan_col, formula_col, include_msbuddy=show_msbuddy)

    ft.index = ft.index.astype(str)
    ft.columns = [str(c) for c in ft.columns]

    # Isolate sample data from background blanks and control solutions
    blank_samples = set()
    if not md.empty:
        for col in md.columns:
            try:
                series_str = md[col].astype(str).str.lower()
                matches = md.index[series_str.str.contains("blank|control|qc|solvent|media", regex=True)]
                blank_samples.update(matches.astype(str))
            except Exception: continue
    bio_samples_idx = md.index.difference(blank_samples)
    bio_samples = [c for c in ft.columns if c in bio_samples_idx]
    if not bio_samples: bio_samples = list(ft.columns)

    # Pre-extract and normalize row IDs
    f_keys = ft.index.values
    rids = [str(k).split("_")[0] for k in f_keys]
    rids = [rid[:-2] if rid.endswith(".0") else rid for rid in rids]

    # Create true biological annotated mask
    is_annotated = np.array([rid in annotated_scans for rid in rids])
    ft_filtered = ft.loc[is_annotated]

    # Vectorized mean calculation over bio_samples (instantaneous in pandas!)
    if not ft_filtered.empty and bio_samples:
        mean_intensities = ft_filtered[bio_samples].mean(axis=1).fillna(0.0).to_dict()
    else:
        mean_intensities = {}

    # Gather features with non-zero pre-computed mean intensities
    sirius_features = [(f_key, mean_intensities.get(f_key, 0.0)) for f_key in ft_filtered.index]

    # Sort descending by mean intensity/abundance and slice the top 1000
    sirius_features.sort(key=lambda x: x[1], reverse=True)
    top_keys = [item[0] for item in sirius_features[:1000]]

    row_id_to_full = {}
    for k in top_keys:
        rid = str(k).split("_")[0]
        if rid.endswith(".0"): rid = rid[:-2]
        row_id_to_full[rid] = k

    # Pre-filter 'an' rows vectorially for maximum loop efficiency
    an_scans_str = an[scan_col].astype(str).values if scan_col else []
    normalized_scans = [s[:-2] if s.endswith(".0") else s for s in an_scans_str]
    unique_row_ids_to_keep = set(row_id_to_full.keys())

    an_keep_mask = np.array([s in unique_row_ids_to_keep for s in normalized_scans])
    an_subset = an.loc[an_keep_mask]

    points = []
    name_col = next((c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns), None)

    for _, row in an_subset.iterrows():
        rid = str(row[scan_col]) if scan_col else ""
        if rid.endswith(".0"): rid = rid[:-2]
        if rid not in row_id_to_full: continue
        f_key = row_id_to_full[rid]
        is_msbuddy = str(row.get("SpectrumID", "")).startswith("MSB_") or str(row.get("Compound_Name", "")).startswith("MSBuddy:")
        if is_msbuddy and not show_msbuddy:
            continue

        formula, formula_source = _resolve_row_formula(row, formula_col, inchi_col, smiles_col)
        if not formula: continue
        o_c, h_c = calculate_ratios_from_formula(formula)
        if o_c is None or h_c is None: continue

        points.append({
            "metabolite": f_key, "row_id": rid, "formula": formula, "o_c": o_c, "h_c": h_c,
            "formula_source": "msbuddy" if is_msbuddy else formula_source,
            "compound_name": str(row[name_col]) if name_col and not pd.isna(row[name_col]) else "",
            "intensity": mean_intensities.get(f_key, 1.0),
            "superclass": str(row.get("superclass", "Unclassified")),
            "class": str(row.get("class", "Unclassified")),
            "subclass": str(row.get("subclass", "Unclassified")),
            "npclassifier_superclass": str(row.get("npclassifier_superclass", "Unclassified")),
            "npclassifier_class": str(row.get("npclassifier_class", "Unclassified")),
            "npclassifier_pathway": str(row.get("npclassifier_pathway", "Unclassified"))
        })

    return {
        "points": points, "total_points": len(points),
        "unannotated_significant_count": 0,
        "total_features": int(ft.shape[0]),
        "annotated_features": int(is_annotated.sum()),
        "msbuddy_included": bool(show_msbuddy),
    }


@app.get("/api/datasets/{safe_name}/carbon-ox-state")
async def get_dataset_carbon_ox_state(safe_name: str, show_msbuddy: bool = False):
    """
    Get Carbon Oxidation State (COS) data for annotated features.

    Returns top features by intensity with COS values and classification.
    """
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")

    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    md_path = dataset_dir / "md.parquet"
    meta_path = dataset_dir / "meta.json"

    if not an_path.exists() or not ft_path.exists():
        return {
            "points": [], "total_points": 0, "message": "Required files missing.",
            "total_features": 0
        }

    an = pd.read_parquet(an_path)
    ft = pd.read_parquet(ft_path)
    md = pd.read_parquet(md_path) if md_path.exists() else pd.DataFrame()
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    if ft.empty:
        return {"points": [], "total_points": 0, "total_features": 0}

    scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
    formula_col = next((c for c in an.columns if c.lower() in ["molecular_formula", "formula"]), None)
    inchi_col = next((c for c in an.columns if c.lower() == "inchi"), None)
    smiles_col = next((c for c in an.columns if c.lower() in ("smiles", "smile")), None)

    # Scans carrying a formula from ANY source (SIRIUS/ZODIAC, library match, InChI, SMILES)
    annotated_scans = _get_annotated_scans(an, scan_col, formula_col, include_msbuddy=show_msbuddy)

    ft.index = ft.index.astype(str)
    ft.columns = [str(c) for c in ft.columns]
    ft.index = ft.index.astype(str)

    # Isolate biological samples from blanks/controls
    blank_samples = set()
    if not md.empty:
        for col in md.columns:
            try:
                series_str = md[col].astype(str).str.lower()
                matches = md.index[series_str.str.contains("blank|control|qc|solvent|media", regex=True)]
                blank_samples.update(matches.astype(str))
            except Exception: continue
    bio_samples_idx = md.index.difference(blank_samples)
    bio_samples = [c for c in ft.columns if c in bio_samples_idx]
    if not bio_samples: bio_samples = list(ft.columns)

    # Pre-extract and normalize row IDs
    f_keys = ft.index.values
    rids = [str(k).split("_")[0] for k in f_keys]
    rids = [rid[:-2] if rid.endswith(".0") else rid for rid in rids]

    # Filter for annotated features
    is_annotated = np.array([rid in annotated_scans for rid in rids])
    ft_filtered = ft.loc[is_annotated]

    # Calculate mean intensities over biological samples
    if not ft_filtered.empty and bio_samples:
        mean_intensities = ft_filtered[bio_samples].mean(axis=1).fillna(0.0).to_dict()
    else:
        mean_intensities = {}

    # Gather features with non-zero mean intensities
    sirius_features = [(f_key, mean_intensities.get(f_key, 0.0)) for f_key in ft_filtered.index]

    # Sort by mean intensity descending and take top 1000
    sirius_features.sort(key=lambda x: x[1], reverse=True)
    top_keys = [item[0] for item in sirius_features[:1000]]

    row_id_to_full = {}
    for k in top_keys:
        rid = str(k).split("_")[0]
        if rid.endswith(".0"): rid = rid[:-2]
        row_id_to_full[rid] = k

    # Pre-filter annotation table for top features
    an_scans_str = an[scan_col].astype(str).values if scan_col else []
    normalized_scans = [s[:-2] if s.endswith(".0") else s for s in an_scans_str]
    unique_row_ids_to_keep = set(row_id_to_full.keys())

    an_keep_mask = np.array([s in unique_row_ids_to_keep for s in normalized_scans])
    an_subset = an.loc[an_keep_mask]

    # Extract points with COS values
    points = []
    name_col = next((c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns), None)

    for _, row in an_subset.iterrows():
        rid = str(row[scan_col]) if scan_col else ""
        if rid.endswith(".0"): rid = rid[:-2]
        if rid not in row_id_to_full: continue

        # Skip MSBuddy annotations unless requested
        is_msbuddy = str(row.get("SpectrumID", "")).startswith("MSB_") or str(row.get("Compound_Name", "")).startswith("MSBuddy:")
        if is_msbuddy and not show_msbuddy:
            continue

        # Extract formula (formula column → InChI → SMILES)
        formula, formula_source = _resolve_row_formula(row, formula_col, inchi_col, smiles_col)
        if not formula:
            continue

        # Calculate COS
        cos = calculate_carbon_oxidation_state(formula)
        if cos is None: continue

        f_key = row_id_to_full[rid]
        points.append({
            "metabolite": f_key,
            "row_id": rid,
            "formula": formula,
            "cos": cos,
            "formula_source": "msbuddy" if is_msbuddy else formula_source,
            "compound_name": str(row[name_col]) if name_col and not pd.isna(row[name_col]) else "",
            "intensity": mean_intensities.get(f_key, 1.0),
            "superclass": str(row.get("superclass", "Unclassified")),
            "class": str(row.get("class", "Unclassified")),
            "subclass": str(row.get("subclass", "Unclassified")),
            "npclassifier_superclass": str(row.get("npclassifier_superclass", "Unclassified")),
            "npclassifier_class": str(row.get("npclassifier_class", "Unclassified")),
            "npclassifier_pathway": str(row.get("npclassifier_pathway", "Unclassified"))
        })

    return {
        "points": points,
        "total_points": len(points),
        "total_features": int(ft.shape[0]),
        "annotated_features": int(is_annotated.sum()),
        "msbuddy_included": bool(show_msbuddy),
    }


@app.get("/api/datasets/{safe_name}/unannotated-count")
async def get_unannotated_count(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists(): return {"count": 0}
    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    if not an_path.exists() or not ft_path.exists(): return {"count": 0}

    an = pd.read_parquet(an_path)
    ft = pd.read_parquet(ft_path)

    scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
    formula_col = next((c for c in an.columns if c.lower() in ["molecular_formula", "formula"]), None)

    if not scan_col: return {"count": int(ft.shape[0])}

    annotated = _get_annotated_scans(an, scan_col, formula_col, include_msbuddy=True)

    unannotated = 0
    for f_key in ft.index:
        rid = str(f_key).split("_")[0]
        if rid.endswith(".0"): rid = rid[:-2]
        if rid not in annotated:
            unannotated += 1
    return {"count": unannotated}


@app.get("/api/datasets/{safe_name}/formula-coverage")
async def get_formula_coverage(safe_name: str):
    """Molecular-formula coverage report for a dataset, with guidance on
    improving coverage upstream via SIRIUS + ZODIAC."""
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")
    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    if not ft_path.exists():
        raise HTTPException(404, "Feature table missing")

    ft = pd.read_parquet(ft_path)
    total_features = int(ft.shape[0])
    ft_rids = set()
    for k in ft.index:
        rid = str(k).split("_")[0]
        if rid.endswith(".0"): rid = rid[:-2]
        ft_rids.add(rid)

    by_source = {"sirius_or_library": 0, "inchi": 0, "smiles": 0, "msbuddy": 0}
    annotated_rids: set = set()

    if an_path.exists():
        an = pd.read_parquet(an_path)
        scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
        formula_col = next((c for c in an.columns if c.lower() in ["molecular_formula", "formula"]), None)
        inchi_col = next((c for c in an.columns if c.lower() == "inchi"), None)
        smiles_col = next((c for c in an.columns if c.lower() in ("smiles", "smile")), None)
        if scan_col:
            for _, row in an.iterrows():
                rid = str(row[scan_col])
                if rid.endswith(".0"):
                    rid = rid[:-2]
                if rid not in ft_rids or rid in annotated_rids:
                    continue
                is_msbuddy = str(row.get("SpectrumID", "")).startswith("MSB_") or str(row.get("Compound_Name", "")).startswith("MSBuddy:")
                formula, source = _resolve_row_formula(row, formula_col, inchi_col, smiles_col)
                if not formula:
                    continue
                annotated_rids.add(rid)
                by_source["msbuddy" if is_msbuddy else source] += 1

    annotated_total = len(annotated_rids)
    return {
        "total_features": total_features,
        "annotated_features": annotated_total,
        "unannotated_features": total_features - annotated_total,
        "coverage_pct": round(100.0 * annotated_total / total_features, 2) if total_features else 0.0,
        "by_source": by_source,
        "rdkit_available": _RDKIT_AVAILABLE,
        "zodiac": {
            "runs_in_portal": False,
            "reason": "ZODIAC is part of SIRIUS and requires raw MS/MS spectra (.mgf/.ms); this portal stores processed tables only.",
            "how_to_enable": [
                "Run SIRIUS (GUI or CLI) on your raw spectra with ZODIAC enabled — it re-ranks molecular formula candidates using dataset-wide network relationships, typically improving correct formulas by 10-20%.",
                "SIRIUS CLI example: sirius --input spectra.mgf --output results formula zodiac fingerprint structure canopus",
                "In the SIRIUS GUI, ZODIAC runs as part of the Formula Identification step when compounds are computed together.",
                "Export the SIRIUS annotation table (with a molecular_formula column) and re-upload it to this portal.",
            ],
        },
    }


# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
