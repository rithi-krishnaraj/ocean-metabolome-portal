"""
Ocean Metabolome Portal – FastAPI Backend
Routes for manual upload, GNPS task loading, dataset management, and map data.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Optional
import skbio
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from scipy import sparse
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from data_processor import (
    clean_feature_table,
    index_feature_table,
    clean_metadata_table,
    drop_unknown_ecosystem,
    create_combined_table,
    parse_file,
    validate_coordinates,
)
from gnps_client import GNPS2_WORKFLOW_KEYS, detect_workflow, load_eb, load_fbmn, normalize_eb_annotations

# Optional RDKit — enables SMILES → molecular formula fallback for Van Krevelen plots
try:
    from rdkit import Chem as _rd_Chem
    from rdkit.Chem import rdMolDescriptors as _rd_md
    from rdkit import RDLogger as _rd_logger

    # Unparseable SMILES just yield no formula; RDKit's per-molecule error logging floods the console
    _rd_logger.DisableLog("rdApp.*")
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
# Dashboard responses (sample metadata, plots) are several MB of repetitive JSON
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

DATASETS_DIR = Path(__file__).parent / "datasets"
DATASETS_DIR.mkdir(exist_ok=True)

# In-memory sessions: session_id → { ft, md, an, meta }
sessions: dict = {}

# In-memory caches for blazingly fast performance
DATASET_DF_CACHE = {}  # dataset_safe -> {"md": DataFrame, "ft": DataFrame, "mtime_md": float, "mtime_ft": float}
PCOA_CACHE = OrderedDict()       # (dataset_safe, file mtimes, distance_metric, sorted sample ids) -> skbio OrdinationResults
PERMANOVA_CACHE = OrderedDict()  # PCOA_CACHE key + (color_by,) -> PERMANOVA result records
PCOA_CACHE_MAX = 16
FEATURE_FILTER_CACHE = {}  # dataset dir name -> {"key": file mtimes, "index": _feature_filter_index() result}
AN_CACHE = {}  # dataset_safe -> {"an": DataFrame, "mtime": float}
# Statistics dashboard results (mostly pre-encoded JSON), keyed by _stats_key(): any change to
# the dataset's files or public columns gives a new key, so stale entries are never served.
STATS_CACHE = OrderedDict()
STATS_CACHE_MAX = 64
# Whole-dataset sample × sample distance matrices: (dataset_safe, ft mtime, metric) -> (sample ids, matrix).
# Also saved to <dataset>/.cache/ so they survive restarts.
DIST_CACHE = OrderedDict()
DIST_CACHE_MAX = 4
DIST_CACHE_DIRNAME = ".cache"
_cache_lock = threading.Lock()
_dist_locks: dict = {}  # DIST_CACHE key -> Lock, so concurrent requests compute a matrix only once

# ---------------------------------------------------------------------------
# Admin authentication
# ---------------------------------------------------------------------------

# Local runs read the repo-root .env; in Docker, env_file already sets the variable
# (load_dotenv never overrides a variable that is already set).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

ADMIN_TOKEN_TTL_SECONDS = 12 * 60 * 60

# In-memory admin tokens: token → expiry timestamp. A backend restart logs everyone out.
admin_tokens: dict[str, float] = {}

_bearer = HTTPBearer(auto_error=False)


def _admin_password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "")


def require_admin(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> None:
    """Dependency for admin-only routes: requires a valid token from /api/admin/login."""
    now = time.time()
    for token, expiry in list(admin_tokens.items()):
        if expiry <= now:
            admin_tokens.pop(token, None)
    if creds is None or creds.credentials not in admin_tokens:
        raise HTTPException(401, "Admin login required.", headers={"WWW-Authenticate": "Bearer"})

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


def _dataset_frames(dataset_safe: str, dataset_dir: Path):
    """Cached (md, ft) exactly as saved — all metadata columns, no copy. Callers must not modify them."""
    md_path = dataset_dir / "md.parquet"
    ft_path = dataset_dir / "ft.parquet"

    if not md_path.exists() or not ft_path.exists():
        return None, None

    mtime_md = md_path.stat().st_mtime
    mtime_ft = ft_path.stat().st_mtime

    cached = DATASET_DF_CACHE.get(dataset_safe)
    if not (cached and cached["mtime_md"] == mtime_md and cached["mtime_ft"] == mtime_ft):
        cached = {
            "md": pd.read_parquet(md_path),
            "ft": pd.read_parquet(ft_path),
            "mtime_md": mtime_md,
            "mtime_ft": mtime_ft
        }
        DATASET_DF_CACHE[dataset_safe] = cached
    return cached["md"], cached["ft"]


def get_cached_dataset(dataset_safe: str, dataset_dir: Path):
    md, ft = _dataset_frames(dataset_safe, dataset_dir)
    if md is None:
        return None, None
    # Public columns are applied on every call (not cached), so editing them takes effect at once.
    return _public_md(md, _read_meta(dataset_dir)).copy(), ft.copy()


def _annotation_frame(dataset_safe: str, dataset_dir: Path) -> Optional[pd.DataFrame]:
    """Cached annotation table (no copy; callers must not modify it), or None when there is none."""
    an_path = dataset_dir / "an.parquet"
    if not an_path.exists():
        return None
    mtime = an_path.stat().st_mtime
    cached = AN_CACHE.get(dataset_safe)
    if not (cached and cached["mtime"] == mtime):
        cached = {"an": pd.read_parquet(an_path), "mtime": mtime}
        AN_CACHE[dataset_safe] = cached
    return cached["an"]


def _stats_key(kind: str, dataset_dir: Path, *args) -> tuple:
    """Cache key that changes whenever any of the dataset's files (or its public columns) change."""
    mtimes = tuple(
        p.stat().st_mtime if p.exists() else 0.0
        for p in (dataset_dir / f for f in ("md.parquet", "ft.parquet", "an.parquet", "meta.json"))
    )
    return (kind, dataset_dir.name, mtimes, *args)


def _lru_get(cache: OrderedDict, key):
    with _cache_lock:
        if key not in cache:
            return None
        cache.move_to_end(key)
        return cache[key]


def _lru_put(cache: OrderedDict, key, value, max_size: int) -> None:
    with _cache_lock:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > max_size:
            cache.popitem(last=False)


def _cached_stats(key: tuple, compute):
    value = _lru_get(STATS_CACHE, key)
    if value is None:
        value = compute()
        _lru_put(STATS_CACHE, key, value, STATS_CACHE_MAX)
    return value


def _json_response(body: str) -> Response:
    return Response(body, media_type="application/json")


def _invalidate_dataset_caches(dataset_safe: str) -> None:
    DATASET_DF_CACHE.pop(dataset_safe, None)
    AN_CACHE.pop(dataset_safe, None)
    with _cache_lock:
        for cache in (PCOA_CACHE, PERMANOVA_CACHE, DIST_CACHE):
            for k in [k for k in cache if k[0] == dataset_safe]:
                cache.pop(k, None)
        for k in [k for k in STATS_CACHE if k[1] == dataset_safe]:
            STATS_CACHE.pop(k, None)


def _dataset_mtimes(dataset_dir: Path) -> tuple[float, float]:
    """(md_mtime, ft_mtime) for cache invalidation — cheap stat() calls."""
    md_path = dataset_dir / "md.parquet"
    ft_path = dataset_dir / "ft.parquet"
    return (
        md_path.stat().st_mtime if md_path.exists() else 0.0,
        ft_path.stat().st_mtime if ft_path.exists() else 0.0,
    )


PREVIEW_MAX_ROWS = 200
# Feature and combined tables have one column per sample or feature (thousands); previews
# of every table keep the first columns so the response and the admin table stay small.
PREVIEW_MAX_COLS = 50


def _df_records_json(
    df: Optional[pd.DataFrame],
    max_rows: int = PREVIEW_MAX_ROWS,
    max_cols: Optional[int] = PREVIEW_MAX_COLS,
) -> str:
    """The first rows/columns of df as a JSON array of records (NaN → null)."""
    if df is None or df.empty:
        return "[]"
    return df.iloc[:max_rows, :max_cols].reset_index().to_json(orient="records", default_handler=str)


def _df_records(
    df: Optional[pd.DataFrame],
    max_rows: int = PREVIEW_MAX_ROWS,
    max_cols: Optional[int] = PREVIEW_MAX_COLS,
) -> list:
    return json.loads(_df_records_json(df, max_rows, max_cols))


def _upload_response(fields: dict, ft: pd.DataFrame, md: pd.DataFrame, an: Optional[pd.DataFrame]) -> Response:
    """Upload result with table previews, sent as pre-encoded JSON.

    A feature table preview has hundreds of thousands of cells; returning it as Python
    objects made FastAPI re-encode every value (~3 s for a 2,400-sample GNPS task).
    """
    named_ft = _named_features(ft)
    # The combined preview needs only the first samples and columns, not the full
    # samples × features table (save_dataset builds that).
    ft_samples = set(ft.columns)
    preview_samples = [s for s in md.index if s in ft_samples][:PREVIEW_MAX_ROWS]
    combined = create_combined_table(ft[preview_samples].iloc[:PREVIEW_MAX_COLS], md)
    fields = {
        **fields,
        "ft_columns": _df_columns(named_ft),
        "md_columns": _df_columns(md),
        "preview_max_rows": PREVIEW_MAX_ROWS,
        "preview_max_cols": PREVIEW_MAX_COLS,
    }
    previews = {
        "ft_preview": _df_records_json(named_ft),
        "md_preview": _df_records_json(md),
        "an_preview": _df_records_json(an),
        "combined_preview": _df_records_json(combined),
    }
    body = json.dumps(fields, default=str)[:-1] + "".join(f", {json.dumps(k)}: {v}" for k, v in previews.items()) + "}"
    return Response(body, media_type="application/json")


def _df_columns(df: Optional[pd.DataFrame]) -> list:
    if df is None or df.empty:
        return []
    return list(df.reset_index().columns)


def _named_features(ft: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Label the feature index 'Feature Name' so previews show it as the first column."""
    return None if ft is None else ft.rename_axis("Feature Name")


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)


def _dataset_name_taken(name: str, exclude_safe: Optional[str] = None) -> bool:
    """Whether another saved dataset already uses this display name (case-insensitive)."""
    wanted = name.strip().lower()
    for meta_path in DATASETS_DIR.glob("*/meta.json"):
        if meta_path.parent.name == exclude_safe:
            continue
        try:
            if str(json.loads(meta_path.read_text()).get("name", "")).strip().lower() == wanted:
                return True
        except (OSError, ValueError):
            continue
    return False


def _validated_md_columns(requested, md: pd.DataFrame) -> list:
    """Public metadata columns: the requested ones that exist, in table order; all if none requested."""
    if requested is None:
        return list(md.columns)
    if not isinstance(requested, list):
        raise HTTPException(400, "md_columns must be a list of column names.")
    wanted = {str(c) for c in requested}
    return [c for c in md.columns if str(c) in wanted]


def _public_md(md: pd.DataFrame, meta: dict) -> pd.DataFrame:
    """Drop metadata columns the admin has not made public.

    Coordinates are always kept: they place samples on the map.
    """
    public = meta.get("md_columns")
    if public is None or md is None or md.empty:
        return md
    keep = {str(c) for c in public}
    coords = {str(meta.get(k) or "").strip().lower() for k in ("lat_col", "lon_col")}
    return md[[c for c in md.columns if str(c) in keep or str(c).strip().lower() in coords]]


def _map_coverage(ft: pd.DataFrame, md: pd.DataFrame, lat_col: Optional[str], lon_col: Optional[str]) -> tuple[int, int]:
    """(samples, features) that appear on the map.

    A sample is mapped when its Latitude and Longitude are both numeric; a feature
    counts when it has a positive intensity in at least one mapped sample.
    """
    if md is None or md.empty:
        return 0, 0
    lat_col = _find_column_case_insensitive(md, lat_col)
    lon_col = _find_column_case_insensitive(md, lon_col)
    if not lat_col or not lon_col:
        return 0, 0
    has_coords = pd.to_numeric(md[lat_col], errors="coerce").notna() & pd.to_numeric(md[lon_col], errors="coerce").notna()
    mapped_samples = set(md.index[has_coords].astype(str))
    sample_cols = [c for c in ft.columns if str(c) in mapped_samples]
    if not sample_cols:
        return len(mapped_samples), 0
    intensities = ft[sample_cols].apply(pd.to_numeric, errors="coerce")
    return len(mapped_samples), int((intensities > 0).any(axis=1).sum())


def _read_meta(dataset_dir: Path) -> dict:
    meta_path = dataset_dir / "meta.json"
    return json.loads(meta_path.read_text()) if meta_path.exists() else {}


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
    # Ignore an appended compound name ("rowID_mz_rt&Compound_Name"), as in datasets saved with one
    key = str(feature_key).split("&", 1)[0].strip()
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
# Admin login
# ---------------------------------------------------------------------------

@app.post("/api/admin/login")
async def admin_login(body: dict):
    expected = _admin_password()
    if not expected:
        # Fail closed: without a configured password nobody can log in.
        raise HTTPException(503, "Admin login is disabled: ADMIN_PASSWORD is not set on the server.")

    password = body.get("password")
    if not isinstance(password, str) or not secrets.compare_digest(
        password.encode("utf-8"), expected.encode("utf-8")
    ):
        await asyncio.sleep(1)  # slow down password guessing
        raise HTTPException(401, "Incorrect password.")

    token = secrets.token_urlsafe(32)
    admin_tokens[token] = time.time() + ADMIN_TOKEN_TTL_SECONDS
    return {"token": token, "expires_in": ADMIN_TOKEN_TTL_SECONDS}


# ---------------------------------------------------------------------------
# Upload – manual files
# ---------------------------------------------------------------------------

@app.post("/api/upload/manual", dependencies=[Depends(require_admin)])
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

    an: Optional[pd.DataFrame] = None
    if an_file and an_file.filename:
        an = parse_file(await an_file.read(), an_file.filename)
        if an is not None:
            # Everything Bagel library matches name their columns differently (query_scan, NAME, ...)
            an = normalize_eb_annotations(an)

    # Index by feature name first: cleaning drops the name / ID / m/z / RT columns.
    ft = clean_feature_table(index_feature_table(ft))
    md = clean_metadata_table(md)
    md, ft, n_unknown_ecosystem = drop_unknown_ecosystem(md, ft)

    has_coords, lat_col, lon_col = validate_coordinates(md)

    session_id = str(uuid.uuid4())
    sessions[session_id] = dict(
        ft=ft,
        md=md,
        an=an,
        has_coords=has_coords,
        lat_col=lat_col,
        lon_col=lon_col,
        source_task_id=None,
    )

    return _upload_response(
        {
            "session_id": session_id,
            "default_name": "",
            "has_coords": has_coords,
            "lat_col": lat_col,
            "lon_col": lon_col,
            "ft_shape": list(ft.shape),
            "md_shape": list(md.shape),
            "n_unknown_ecosystem_removed": n_unknown_ecosystem,
            "an_shape": list(an.shape) if an is not None else [0, 0],
        },
        ft, md, an,
    )


# ---------------------------------------------------------------------------
# Upload – GNPS task ID
# ---------------------------------------------------------------------------

WORKFLOW_LABELS = {"fbmn": "FBMN", "eb": "EB (Everything Bagel)"}


async def _gnps_load_error(task_id: str, workflow: str, exc: Exception) -> str:
    """Explain a failed GNPS load, naming the right workflow when the wrong one was selected."""
    actual = await asyncio.to_thread(detect_workflow, task_id)
    if actual:
        actual_key = GNPS2_WORKFLOW_KEYS.get(actual)
        if actual_key is None:
            return (
                f"Task '{task_id}' is a GNPS2 '{actual}' task, which the portal cannot import. "
                "Use an FBMN or Everything Bagel task ID."
            )
        if actual_key != workflow:
            return (
                f"Task '{task_id}' is an {WORKFLOW_LABELS[actual_key]} task, but {WORKFLOW_LABELS[workflow]} is selected. "
                f"Change the workflow type to {WORKFLOW_LABELS[actual_key]} and load again."
            )
    return f"Failed to load from GNPS: {exc}"


@app.post("/api/upload/gnps", dependencies=[Depends(require_admin)])
async def upload_gnps(body: dict):
    task_id = body.get("task_id", "").strip()
    workflow = body.get("workflow", "fbmn")

    if not task_id:
        raise HTTPException(400, "task_id is required.")

    loaders = {"fbmn": load_fbmn, "eb": load_eb}
    if workflow not in loaders:
        raise HTTPException(400, f"Unknown workflow '{workflow}'. Use one of: {', '.join(loaders)}.")

    try:
        # Downloads can take minutes; run them off the event loop so other requests keep working.
        ft, md, an = await asyncio.to_thread(loaders[workflow], task_id)
    except Exception as exc:
        raise HTTPException(400, await _gnps_load_error(task_id, workflow, exc))

    if ft is None or ft.empty:
        raise HTTPException(400, "GNPS returned an empty feature table. Check the task ID.")

    ft = clean_feature_table(ft)
    md = clean_metadata_table(md) if md is not None and not md.empty else pd.DataFrame()
    md, ft, n_unknown_ecosystem = drop_unknown_ecosystem(md, ft)

    has_coords, lat_col, lon_col = validate_coordinates(md)

    session_id = str(uuid.uuid4())
    sessions[session_id] = dict(
        ft=ft,
        md=md,
        an=an,
        has_coords=has_coords,
        lat_col=lat_col,
        lon_col=lon_col,
        source_task_id=task_id,
    )

    return _upload_response(
        {
            "session_id": session_id,
            "default_name": task_id,
            "source_task_id": task_id,
            "has_coords": has_coords,
            "lat_col": lat_col,
            "lon_col": lon_col,
            "ft_shape": list(ft.shape),
            "md_shape": list(md.shape) if md is not None else [0, 0],
            "n_unknown_ecosystem_removed": n_unknown_ecosystem,
            "an_shape": list(an.shape) if an is not None else [0, 0],
        },
        ft, md, an,
    )


# ---------------------------------------------------------------------------
# Save dataset
# ---------------------------------------------------------------------------

@app.post("/api/dataset/save", dependencies=[Depends(require_admin)])
async def save_dataset(body: dict):
    session_id = body.get("session_id", "")
    name = body.get("name", "").strip()

    if not name:
        raise HTTPException(400, "Dataset name is required.")
    if not session_id or session_id not in sessions:
        raise HTTPException(404, "Session not found or expired.")

    if _dataset_name_taken(name):
        raise HTTPException(409, f"A dataset named '{name}' already exists.")

    # Renamed datasets keep their folder, so a free name can still map to a used folder: add a suffix.
    base_safe = safe = _safe_name(name)
    suffix = 2
    while (DATASETS_DIR / safe).exists():
        safe = f"{base_safe}_{suffix}"
        suffix += 1
    dataset_dir = DATASETS_DIR / safe

    sess = sessions[session_id]

    if not sess.get("has_coords", False):
        raise HTTPException(
            400,
            "Dataset cannot be saved: metadata must include Latitude and Longitude columns.",
        )
    dataset_dir.mkdir(parents=True)

    ft: pd.DataFrame = sess["ft"].copy()
    md: pd.DataFrame = sess["md"].copy()
    an: Optional[pd.DataFrame] = sess.get("an")

    combined = create_combined_table(ft, md)
    n_samples_on_map, n_features_on_map = _map_coverage(ft, md, sess["lat_col"], sess["lon_col"])

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
        # Only samples with coordinates (and features detected in them) are shown on the map
        "n_samples_on_map": n_samples_on_map,
        "n_features_on_map": n_features_on_map,
        "has_annotation": an is not None and not an.empty,
        # Public metadata columns (the admin's choice; all columns if none was sent)
        "md_columns": _validated_md_columns(body.get("visible_md_columns"), md),
        "n_md_columns_total": int(md.shape[1]),
    }
    (dataset_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    # Invalidate caches, then precompute the statistics dashboard's defaults in the background
    _invalidate_dataset_caches(safe)
    _start_stats_warmup([safe])

    del sessions[session_id]
    return {
        "success": True,
        "name": name,
        "safe_name": safe,
        "n_samples": meta["n_samples"],
        "n_features": meta["n_features"],
        "n_samples_on_map": n_samples_on_map,
        "n_features_on_map": n_features_on_map,
    }


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


def _dataset_dir_or_404(safe_name: str) -> Path:
    dataset_dir = (DATASETS_DIR / safe_name).resolve()
    # Only ever a direct child of DATASETS_DIR (blocks names like "..").
    if dataset_dir.parent != DATASETS_DIR.resolve() or not (dataset_dir / "meta.json").is_file():
        raise HTTPException(404, "Dataset not found.")
    return dataset_dir


@app.get("/api/datasets/{safe_name}/settings", dependencies=[Depends(require_admin)])
async def get_dataset_settings(safe_name: str):
    """Editable settings for the admin page, including every metadata column (public or not)."""
    dataset_dir = _dataset_dir_or_404(safe_name)
    meta = json.loads((dataset_dir / "meta.json").read_text())
    md_path = dataset_dir / "md.parquet"
    all_columns = list(pd.read_parquet(md_path).columns) if md_path.exists() else []
    return {
        "name": meta.get("name", safe_name),
        "md_columns_all": all_columns,
        "md_columns": [c for c in all_columns if c in set(meta.get("md_columns", all_columns))],
        "lat_col": meta.get("lat_col"),
        "lon_col": meta.get("lon_col"),
    }


@app.patch("/api/datasets/{safe_name}", dependencies=[Depends(require_admin)])
async def update_dataset(safe_name: str, body: dict):
    """Edit a saved dataset's display name, public metadata columns and map visibility.

    The folder (safe_name) stays the same, so links, caches and the files on disk are unaffected.
    """
    dataset_dir = _dataset_dir_or_404(safe_name)
    meta_path = dataset_dir / "meta.json"
    meta = json.loads(meta_path.read_text())

    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "Dataset name is required.")
        if _dataset_name_taken(name, exclude_safe=safe_name):
            raise HTTPException(409, f"A dataset named '{name}' already exists.")
        meta["name"] = name

    if "md_columns" in body:
        md_path = dataset_dir / "md.parquet"
        md = pd.read_parquet(md_path) if md_path.exists() else pd.DataFrame()
        meta["md_columns"] = _validated_md_columns(body.get("md_columns"), md)
        meta["n_md_columns_total"] = int(md.shape[1])

    if "hidden" in body:
        # Hidden datasets stay saved but are left out of the public map and its analyses.
        meta["hidden"] = bool(body.get("hidden"))

    meta_path.write_text(json.dumps(meta, indent=2))
    _invalidate_dataset_caches(safe_name)
    return meta


@app.delete("/api/datasets/{safe_name}", dependencies=[Depends(require_admin)])
async def delete_dataset(safe_name: str):
    dataset_dir = (DATASETS_DIR / safe_name).resolve()
    # Only ever delete a direct child of DATASETS_DIR (blocks names like "..").
    if dataset_dir.parent != DATASETS_DIR.resolve() or not dataset_dir.is_dir():
        raise HTTPException(404, "Dataset not found.")
    shutil.rmtree(dataset_dir)
    _invalidate_dataset_caches(safe_name)
    return {"success": True}


@app.get("/api/datasets/{safe_name}/table/{table_name}", dependencies=[Depends(require_admin)])
async def get_dataset_table(safe_name: str, table_name: str):
    allowed = {"ft", "md", "an", "combined"}
    if table_name not in allowed:
        raise HTTPException(400, f"table_name must be one of {allowed}")
    path = DATASETS_DIR / safe_name / f"{table_name}.parquet"
    if not path.exists():
        return {"data": [], "columns": []}
    df = pd.read_parquet(path)
    if table_name == "ft":
        df = _named_features(df)
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
        if meta.get("hidden"):
            continue
        dataset_names.append(meta["name"])
        dataset_safe_map[str(meta["name"])] = str(meta.get("safe_name", d.name))

        if "n_features_on_map" not in meta:
            # Datasets saved before map coverage was recorded: compute once and store it.
            ft_path = d / "ft.parquet"
            if meta.get("has_coords") and md_path.exists() and ft_path.exists():
                meta["n_samples_on_map"], meta["n_features_on_map"] = _map_coverage(
                    pd.read_parquet(ft_path), pd.read_parquet(md_path), meta.get("lat_col"), meta.get("lon_col")
                )
            else:
                meta["n_samples_on_map"], meta["n_features_on_map"] = 0, 0
            meta_path.write_text(json.dumps(meta, indent=2))

        # Only features detected in samples with coordinates count towards the map total
        total_features += meta["n_features_on_map"]

        # Collect detailed info for each dataset
        datasets_details.append({
            "name": meta["name"],
            "safe_name": meta.get("safe_name", d.name),
            "n_samples": meta["n_samples_on_map"],
            "n_features": meta["n_features_on_map"],
            "n_samples_total": meta.get("n_samples", 0),
            "n_features_total": meta.get("n_features", 0),
            "has_coords": meta.get("has_coords", False)
        })

        if not meta.get("has_coords") or not md_path.exists():
            continue

        lat_col = _find_column_case_insensitive(md := _public_md(pd.read_parquet(md_path), meta), meta.get("lat_col"))
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
        # Ensure the filename (first column of metadata) is included as a regular column.
        # Use assign() rather than md[...] = ...: pandas 2.2 on Python 3.14 emits a
        # false-positive ChainedAssignmentError FutureWarning for setitem here.
        filename_col = md.index.name or "filename"
        md = md.assign(**{
            "_lat": pd.to_numeric(md[lat_col], errors="coerce"),
            "_lon": pd.to_numeric(md[lon_col], errors="coerce"),
            filename_col: md.index.astype(str),
        })

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


def _feature_filter_index(d: Path, meta: dict) -> Optional[dict]:
    """Per-dataset data for metabolite filtering, cached until the dataset's files change:
    one row per feature (parsed row ID / m/z / RT, annotation, lower-case search text) and
    a sparse features × samples intensity matrix over the samples that have coordinates
    (only detections are stored: feature tables are mostly zeros).
    None when the dataset has no mappable samples.
    """
    paths = [d / "meta.json", d / "md.parquet", d / "ft.parquet", d / "an.parquet"]
    key = tuple(p.stat().st_mtime if p.exists() else 0.0 for p in paths)
    cached = FEATURE_FILTER_CACHE.get(d.name)
    if cached and cached["key"] == key:
        return cached["index"]

    index = None
    md = _public_md(pd.read_parquet(d / "md.parquet"), meta)
    lat_col = _find_column_case_insensitive(md, meta.get("lat_col"))
    lon_col = _find_column_case_insensitive(md, meta.get("lon_col"))
    if lat_col and lon_col:
        md.index = md.index.astype(str)
        coords = pd.DataFrame({
            "lat": pd.to_numeric(md[lat_col], errors="coerce"),
            "lon": pd.to_numeric(md[lon_col], errors="coerce"),
        }).dropna()
        coords = coords[~coords.index.duplicated()]  # a repeated sample takes its first coordinates

        ft = pd.read_parquet(d / "ft.parquet")
        ft.columns = [str(c) for c in ft.columns]
        ft.index = ft.index.astype(str)
        sample_cols = [c for c in ft.columns if c in coords.index]
        if sample_cols:
            values = ft[sample_cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
            # NaN compares False: missing or zero means not detected
            intensities = sparse.csr_matrix(np.where(values > 0, values, 0.0))
            del values

            annotation_map: dict[str, str] = {}
            an_path = d / "an.parquet"
            if an_path.exists():
                an = pd.read_parquet(an_path)
                name_col = next((c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns), None)
                scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
                if name_col and scan_col:
                    annotation_map = dict(zip(an[scan_col].astype(str), an[name_col].astype(str)))

            parsed = [_parse_feature_parts(k) for k in ft.index]
            features = pd.DataFrame({
                "metabolite": ft.index,
                "row_id": [p[0] for p in parsed],
                "row_mz": [p[1] for p in parsed],
                "row_retention_time": [p[2] for p in parsed],
            })
            annotations = features["row_id"].map(annotation_map).fillna("").astype(str)
            features["annotation"] = annotations.where(annotations != "nan", "")
            features["sample_count"] = np.diff(intensities.indptr)
            # Search text, lower-cased once: the filters below are substring matches.
            features["q_row_id"] = features["row_id"].str.lower()
            features["q_mz"] = ["" if p[1] is None else str(p[1]).lower() for p in parsed]
            features["q_rt"] = ["" if p[2] is None else str(p[2]).lower() for p in parsed]
            features["q_metabolite"] = features["metabolite"].str.lower()
            features["q_annotation"] = features["annotation"].str.lower()

            coords = coords.loc[sample_cols]
            index = {
                "features": features,
                "intensities": intensities,
                "sample_ids": sample_cols,
                "lat": coords["lat"].astype(float).tolist(),
                "lon": coords["lon"].astype(float).tolist(),
            }

    FEATURE_FILTER_CACHE[d.name] = {"key": key, "index": index}
    return index


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

    # The map's sample filters: {dataset_safe: [sample IDs]}. When given, only these samples
    # count, and datasets missing from it are skipped. Absent means every sample.
    sample_keys = body.get("sample_keys")
    if not isinstance(sample_keys, dict):
        sample_keys = None

    limit = int(body.get("limit", 200))
    limit = max(1, min(limit, 1000))

    def contains(col: pd.Series, q: str) -> pd.Series:
        return col.str.contains(q, regex=False)

    # (sample_count, metabolite, dataset, feature position) for every match
    matches = []
    for d in DATASETS_DIR.iterdir():
        if not d.is_dir():
            continue
        if not all((d / f).exists() for f in ("meta.json", "md.parquet", "ft.parquet")):
            continue

        meta = json.loads((d / "meta.json").read_text())
        if meta.get("hidden"):
            continue
        dataset = {
            "safe": str(meta.get("safe_name", d.name)),
            "name": str(meta.get("name", d.name)),
        }
        if dataset_safes and dataset["safe"] not in dataset_safes:
            continue
        if sample_keys is not None and not sample_keys.get(dataset["safe"]):
            continue

        index = await asyncio.to_thread(_feature_filter_index, d, meta)
        if index is None:
            continue
        dataset["index"] = index

        f = index["features"]
        counts = f["sample_count"].to_numpy()
        allowed = None  # mask over index["sample_ids"]; None = all samples
        if sample_keys is not None:
            wanted = {str(x) for x in sample_keys[dataset["safe"]]}
            allowed = np.array([sid in wanted for sid in index["sample_ids"]])
            if not allowed.any():
                continue
            # Detections among the allowed samples only
            counts = (index["intensities"] > 0).astype(np.int32) @ allowed.astype(np.int32)
        dataset["allowed"] = allowed

        mask = counts > 0
        if row_id_q:
            mask &= contains(f["q_row_id"], row_id_q).to_numpy()
        if mz_q:
            mask &= contains(f["q_mz"], mz_q).to_numpy()
        if rt_q:
            mask &= contains(f["q_rt"], rt_q).to_numpy()
        if annotation_q:
            mask &= contains(f["q_annotation"], annotation_q).to_numpy()
        if metabolite_q:
            mask &= (contains(f["q_metabolite"], metabolite_q) | contains(f["q_annotation"], metabolite_q)).to_numpy()
        if has_annotation_q:
            mask &= (f["annotation"] != "").to_numpy()

        positions = np.flatnonzero(mask)
        names = f["metabolite"].to_numpy()[positions]
        matches.extend(zip(counts[positions].tolist(), names.tolist(), [dataset] * len(positions), positions.tolist()))

    matches.sort(key=lambda m: (m[0], m[1]), reverse=True)

    # Sample lists are built only for the features returned.
    features_out = []
    measured_samples: dict[str, list[str]] = {}
    for count, metabolite, dataset, pos in matches[:limit]:
        index, allowed = dataset["index"], dataset["allowed"]
        row = index["features"].iloc[pos]
        sample_ids, lat, lon = index["sample_ids"], index["lat"], index["lon"]
        intensities = index["intensities"]
        start, end = intensities.indptr[pos], intensities.indptr[pos + 1]
        detected = zip(intensities.indices[start:end].tolist(), intensities.data[start:end].tolist())
        if dataset["safe"] not in measured_samples:
            # Every mappable sample measures every feature; the map greys out undetected ones.
            measured_samples[dataset["safe"]] = (
                list(sample_ids) if allowed is None else [s for s, ok in zip(sample_ids, allowed) if ok]
            )
        features_out.append(
            {
                "metabolite": metabolite,
                "row_id": row["row_id"],
                "row_mz": None if pd.isna(row["row_mz"]) else float(row["row_mz"]),
                "row_retention_time": None if pd.isna(row["row_retention_time"]) else float(row["row_retention_time"]),
                "annotation": row["annotation"] or None,
                "sample_count": count,
                "dataset": dataset["name"],
                "dataset_safe": dataset["safe"],
                "present_samples": [
                    {
                        "dataset": dataset["name"],
                        "dataset_safe": dataset["safe"],
                        "sample_id": sample_ids[i],
                        "lat": lat[i],
                        "lon": lon[i],
                        "intensity": value,
                    }
                    for i, value in detected
                    if allowed is None or allowed[i]
                ],
            }
        )

    # Pre-encoded: FastAPI's encoder walks every value, slow for thousands of sample entries.
    return Response(
        json.dumps({"features": features_out, "total": len(matches), "measured_samples": measured_samples}),
        media_type="application/json",
    )


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
    lat_col = _find_column_case_insensitive(md := _public_md(pd.read_parquet(md_path), meta), meta.get("lat_col"))
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
            label = f"{metabolite_id_str.split('&', 1)[0]} | {annotation_name}"
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
def get_dataset_metadata_schema(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")
    md_path = dataset_dir / "md.parquet"
    if not md_path.exists():
        return {"columns": [], "categories": {}, "samples": []}

    return _json_response(_cached_stats(
        _stats_key("metadata-schema", dataset_dir),
        lambda: _metadata_schema_json(safe_name, dataset_dir),
    ))


def _metadata_schema_json(safe_name: str, dataset_dir: Path) -> str:
    md, _ = _dataset_frames(safe_name, dataset_dir)
    if md is None:
        raise HTTPException(400, "Dataset files missing")

    md = _public_md(md, _read_meta(dataset_dir))
    md = md.set_axis(md.index.astype(str), axis=0)
    metadata_cols = sorted([c for c in md.columns if not c.startswith('_')])

    categories = {}
    for col in metadata_cols:
        cats = sorted([str(x) for x in md[col].dropna().unique() if str(x).strip() != ''])
        categories[col] = cats

    # Build a lightweight list of all samples and their relevant metadata
    values = md[metadata_cols]
    as_text = values.map(str).where(values.notna(), "N/A")
    samples_list = [
        {"sample_id": sample_id, **dict(zip(metadata_cols, row))}
        for sample_id, row in zip(md.index, as_text.itertuples(index=False, name=None))
    ]

    return json.dumps({
        "columns": metadata_cols,
        "categories": categories,
        "samples": samples_list
    })


@app.get("/api/datasets/{safe_name}/metabolites")
def get_dataset_metabolites(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    _, ft = _dataset_frames(safe_name, dataset_dir)
    if ft is None:
        raise HTTPException(404, "Feature table missing")

    def compute() -> str:
        # Max intensity (the highest detection signal) of each metabolite, highest first
        max_intensity = ft.max(axis=1).to_numpy(dtype=float)
        order = np.argsort(-max_intensity, kind="stable")
        ids = ft.index.astype(str)
        return json.dumps({"metabolites": [{"id": ids[i], "max_intensity": float(max_intensity[i])} for i in order]})

    return _json_response(_cached_stats(_stats_key("metabolites", dataset_dir), compute))


@app.post("/api/datasets/{safe_name}/boxplot-data")
def get_boxplot_data(safe_name: str, body: dict):
    metabolite = body.get("metabolite")
    samples = body.get("samples", [])
    # The dashboard already has every sample's metadata (from metadata-schema) and sends false
    include_metadata = body.get("include_metadata", True)

    if not metabolite:
        raise HTTPException(400, "Metabolite ID is required")

    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    md, ft = _dataset_frames(safe_name, dataset_dir)
    if md is None or ft is None:
        raise HTTPException(404, "Dataset files missing")

    if metabolite in ft.index:
        row = ft.loc[metabolite]
    else:
        # Try fuzzy match if exact fails (e.g. string vs int index)
        matches = np.flatnonzero(ft.index.astype(str) == str(metabolite))
        if not len(matches):
            raise HTTPException(404, f"Metabolite '{metabolite}' not found in dataset")
        metabolite = str(metabolite)
        row = ft.iloc[matches[0]]

    # If samples are provided, filter by them
    if samples:
        # Ensure sample IDs are strings and exist in columns
        samples = [str(s) for s in samples]
        available_samples = [s for s in samples if s in row.index]
        intensities = row[available_samples]
    else:
        intensities = row
    intensities = intensities[intensities.notna()]

    sample_meta = _boxplot_sample_metadata(safe_name, dataset_dir, md) if include_metadata else {}

    # Prepare data for boxplot: list of {sample: ID, intensity: VAL, metadata: ...}
    plot_data = [
        {
            "sample_id": str(sample_id),
            "intensity": float(val),
            "metadata": sample_meta.get(sample_id, {}),
        }
        for sample_id, val in intensities.items()
    ]

    return {
        "metabolite": metabolite,
        "data": plot_data
    }


def _boxplot_sample_metadata(safe_name: str, dataset_dir: Path, md: pd.DataFrame) -> dict:
    """sample id → {public metadata column: value as text}."""
    def compute() -> dict:
        public = _public_md(md, _read_meta(dataset_dir))
        cols = [c for c in public.columns if not str(c).startswith('_')]
        names = [str(c) for c in cols]
        return {
            sample_id: {k: str(v) for k, v in zip(names, row)}
            for sample_id, row in zip(public.index, public[cols].itertuples(index=False, name=None))
        }
    return _cached_stats(_stats_key("boxplot-metadata", dataset_dir), compute)


# Metrics where the distance between two samples depends only on those two samples (features
# absent from both add nothing), so a distance matrix for any sample subset can be cut out of
# one whole-dataset matrix instead of being recomputed for every filter change.
SUBSET_INVARIANT_METRICS = {
    "braycurtis", "canberra", "chebyshev", "cityblock", "cosine",
    "euclidean", "jaccard", "minkowski", "sqeuclidean",
}


def _pairwise_distances(X: np.ndarray, metric: str) -> np.ndarray:
    """squareform(pdist(X, metric)), computed in row blocks across CPU cores (cdist releases the GIL)."""
    from scipy.spatial import distance as scipy_distance

    n = X.shape[0]
    D = np.zeros((n, n))
    step = 32

    def fill_upper(i: int) -> None:
        j = min(i + step, n)
        D[i:j, i:] = scipy_distance.cdist(X[i:j], X[i:], metric=metric)

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 1) as pool:
        list(pool.map(fill_upper, range(0, n, step)))
    lower = np.tril_indices(n, -1)
    D[lower] = D.T[lower]
    np.fill_diagonal(D, 0.0)
    return D


def _full_distance_matrix(dataset_safe: str, dataset_dir: Path, ft: pd.DataFrame, metric: str):
    """(sample ids, distances between every pair of samples in ft), cached in memory and on disk."""
    mtime_ft = (dataset_dir / "ft.parquet").stat().st_mtime
    key = (dataset_safe, mtime_ft, metric)
    with _cache_lock:
        lock = _dist_locks.setdefault(key, threading.Lock())
    with lock:
        cached = _lru_get(DIST_CACHE, key)
        if cached is not None:
            return cached

        ids = np.array([str(c) for c in ft.columns])
        cache_path = dataset_dir / DIST_CACHE_DIRNAME / f"dist_{metric}.npz"
        result = None
        if cache_path.exists():
            try:
                with np.load(cache_path) as saved:
                    if float(saved["mtime_ft"]) == mtime_ft and np.array_equal(saved["ids"], ids):
                        result = (ids, saved["D"])
            except (OSError, ValueError, KeyError):
                result = None
        if result is None:
            X = ft.T.fillna(0.0).to_numpy(dtype=float)
            result = (ids, _pairwise_distances(X, metric))
            try:
                cache_path.parent.mkdir(exist_ok=True)
                tmp_path = cache_path.with_name(f"tmp_{os.getpid()}_{cache_path.name}")
                np.savez(tmp_path, D=result[1], ids=ids, mtime_ft=mtime_ft)
                os.replace(tmp_path, cache_path)
            except OSError:
                pass
        _lru_put(DIST_CACHE, key, result, DIST_CACHE_MAX)
        return result


def _sample_distance_matrix(dataset_safe: str, dataset_dir: Path, ft: pd.DataFrame, samples: list, metric: str):
    """skbio DistanceMatrix between `samples` (feature-table column names as text)."""
    ft_cols = [str(c) for c in ft.columns]
    if metric in SUBSET_INVARIANT_METRICS and len(set(ft_cols)) == len(ft_cols):
        ids, D = _full_distance_matrix(dataset_safe, dataset_dir, ft, metric)
        pos = {s: i for i, s in enumerate(ids)}
        idx = np.array([pos[s] for s in samples])
        sub = D[np.ix_(idx, idx)]
    else:
        from scipy.spatial import distance as scipy_distance

        col_pos = {c: i for i, c in enumerate(ft_cols)}
        X = ft.iloc[:, [col_pos[s] for s in samples]].T.fillna(0.0)
        # Filter out features with all zeros (to avoid zero variance/distance issues)
        X = X.loc[:, (X != 0).any(axis=0)]
        sub = scipy_distance.squareform(scipy_distance.pdist(X.values, metric=metric))
    return skbio.stats.distance.DistanceMatrix(sub, ids=list(samples))


def _permanova_records(distance_matrix, groups: pd.Series) -> list:
    """PERMANOVA over the samples in `groups` (a subset of the distance matrix's samples)."""
    distance_matrix = distance_matrix.filter(list(groups.index))
    permanova = skbio.stats.distance.permanova(distance_matrix, groups)
    # R² = SS_between / SS_total. With pseudo-F = (SS_between / (k - 1)) / (SS_within / (N - k)),
    # SS_between / SS_within = F (k - 1) / (N - k), so R² = 1 - 1 / (1 + F (k - 1) / (N - k)).
    k = permanova["number of groups"]
    n = permanova["sample size"]
    permanova["R2"] = 1 - 1 / (1 + permanova["test statistic"] * (k - 1) / (n - k))
    permanova_res = permanova.to_frame(name="PERMANOVA results").reset_index()
    permanova_res.columns = ["Metric", "Value"]
    permanova_res["Value"] = permanova_res["Value"].apply(lambda x: str(x) if not isinstance(x, (int, float)) else x)
    return permanova_res.to_dict(orient="records")


@app.post("/api/map/pcoa")
def run_map_pcoa(body: dict):
    dataset_safe = body.get("dataset_safe")
    if not dataset_safe:
        raise HTTPException(400, "dataset_safe is required")

    dataset_dir = DATASETS_DIR / dataset_safe
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    # Building the Plotly figures alone takes a second or two on large datasets, so whole
    # responses are cached too: going back to an earlier set of options is instant.
    key = _stats_key("pcoa", dataset_dir, json.dumps(body, sort_keys=True, default=str))
    return _json_response(_cached_stats(
        key, lambda: json.dumps(_pcoa_result(body, dataset_safe, dataset_dir), allow_nan=False)
    ))


def _pcoa_result(body: dict, dataset_safe: str, dataset_dir: Path) -> dict:
    md, ft = _dataset_frames(dataset_safe, dataset_dir)
    if md is None or ft is None:
        raise HTTPException(400, "Dataset files missing")

    md = _public_md(md, _read_meta(dataset_dir)).copy()
    md.index = md.index.astype(str)

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
    filtered_md = md
    if attribute and attribute in filtered_md.columns:
        filtered_md = filtered_md[filtered_md[attribute].notna()]
        if selected_categories is not None:
            filtered_md = filtered_md[filtered_md[attribute].astype(str).isin(selected_categories)]

    # Use the sample mapping logic to ensure robust sample ID matching
    if selected_samples is not None:
        # The dashboard sends metadata row IDs (as in metadata-schema); also accept the resolved _sample_id
        filtered_md = filtered_md[
            filtered_md.index.isin(selected_samples) | filtered_md["_sample_id"].isin(selected_samples)
        ]

    sample_cols = [str(c) for c in ft.columns if str(c) in filtered_md.index]

    if len(sample_cols) < 2:
        return {
            "all_sample_ids": all_sample_ids,
            "metadata_columns": metadata_cols,
            "all_categories": all_categories,
            "error": "At least 2 samples are required to perform PCoA. Currently only " + str(len(sample_cols)) + " sample(s) available after filtering."
        }

    # Sorted to match FBMN-STATS-Webapp behavior exactly
    sorted_samples = sorted(sample_cols)

    # PERMANOVA tests the samples in the analysis that have a value for the grouping column
    perm_md = filtered_md.loc[sorted_samples]
    perm_md = perm_md[perm_md[color_by].notna()]

    n_unique = perm_md[color_by].nunique()
    min_per_cat = perm_md[color_by].value_counts().min() if n_unique > 0 else 0
    can_permanova = n_unique >= 2 and min_per_cat >= 2

    # PCoA depends on the samples and metric; PERMANOVA also on the grouping column.
    # Both are cached, so changing only axes or colours (or going back to an earlier
    # selection) skips the distance matrix, the eigendecomposition and the permutations.
    cache_key = (dataset_safe, _stats_key("pcoa", dataset_dir)[2], distance_metric, tuple(sorted_samples))
    permanova_key = cache_key + (color_by,)
    pcoa = _lru_get(PCOA_CACHE, cache_key)
    permanova_df = _lru_get(PERMANOVA_CACHE, permanova_key) if can_permanova else None

    try:
        if pcoa is None or (can_permanova and permanova_df is None):
            distance_matrix = _sample_distance_matrix(dataset_safe, dataset_dir, ft, sorted_samples, distance_metric)
            # The eigendecomposition and the permutation test are independent: run them side by side
            with ThreadPoolExecutor(max_workers=2) as pool:
                # Only PC1-PC10 are ever shown, so a partial eigendecomposition (O(n²k) rather than
                # O(n³)) is enough; skbio still takes proportions explained from the full trace
                pcoa_job = (
                    pool.submit(
                        skbio.stats.ordination.pcoa,
                        distance_matrix,
                        dimensions=min(10, distance_matrix.shape[0]),
                    )
                    if pcoa is None else None
                )
                permanova_job = None
                if can_permanova and permanova_df is None:
                    permanova_groups = perm_md[color_by].astype(str)
                    permanova_job = pool.submit(_permanova_records, distance_matrix, permanova_groups)
                if pcoa_job is not None:
                    pcoa = pcoa_job.result()
                    _lru_put(PCOA_CACHE, cache_key, pcoa, PCOA_CACHE_MAX)
                if permanova_job is not None:
                    permanova_df = permanova_job.result()
                    _lru_put(PERMANOVA_CACHE, permanova_key, permanova_df, PCOA_CACHE_MAX)

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
    pc_names = [f"PC{k+1}" for k in range(top_k)]
    coords = pcoa.samples.reindex(index=sample_cols, columns=pc_names).fillna(0.0).to_numpy(dtype=float)
    sample_md = filtered_md.loc[sample_cols]

    def column_text(col):
        if not col or col not in sample_md.columns:
            return ["N/A"] * len(sample_cols)
        return [str(v) for v in sample_md[col]]

    coordinate_details = [
        {
            "sample_id": s_id,
            "color_value": color_val,
            "shape_value": shape_val,
            "coordinates": dict(zip(pc_names, row_coords)),
        }
        for s_id, color_val, shape_val, row_coords in zip(
            sample_cols, column_text(color_by), column_text(attribute), coords.tolist()
        )
    ]

    result = {
        "all_sample_ids": all_sample_ids,
        "metadata_columns": metadata_cols,
        "all_categories": all_categories,
        "coordinates": coordinate_details,
        "scatter_plot": json.loads(fig_scatter.to_json()),
        "variance_plot": json.loads(fig_var.to_json()),
        "proportion_explained": pcoa.proportion_explained.tolist(),
        "permanova": permanova_df,
    }
    # Every filtered sample's full metadata is large and the dashboard does not use it
    if body.get("include_filtered_metadata"):
        # Replace NaN values with "N/A" for JSON serialization compliance
        result["filtered_metadata"] = filtered_md.reset_index().fillna("N/A").to_dict(orient="records")
    return result


@app.get("/api/datasets/{safe_name}/ranges")
def get_dataset_ranges(safe_name: str):
    """m/z and RT ranges parsed from feature labels (ID_mz@RT) — used as heatmap filter bounds."""
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    _, ft = _dataset_frames(safe_name, dataset_dir)
    if ft is None:
        raise HTTPException(404, "Feature table missing")

    parsed = [_parse_feature_parts(str(i)) for i in ft.index]
    valid_mz = [mz for _, mz, _ in parsed if mz is not None]
    valid_rt = [rt for _, _, rt in parsed if rt is not None]
    return {
        "mz_min": float(min(valid_mz)) if valid_mz else 0.0,
        "mz_max": float(max(valid_mz)) if valid_mz else 10000.0,
        "rt_min": float(min(valid_rt)) if valid_rt else 0.0,
        "rt_max": float(max(valid_rt)) if valid_rt else 10000.0,
    }


@app.get("/api/datasets/{safe_name}/heatmap")
async def get_dataset_heatmap(
    safe_name: str,
    row_id_filter: str = "",
    mz_min: float = 0.0,
    mz_max: float = 10000.0,
    rt_min: float = 0.0,
    rt_max: float = 10000.0,
    attribute: str = "",
    categories: str = "",
    samples: str = "",
    cmap: str = "viridis",
):
    """Intensity heatmap rendered as a Matplotlib PNG (returned as base64 JSON).

    FBMN-STATS style filtering:
      attribute/categories/samples -> metadata-driven sample selection
      row_id_filter/mz/rt          -> feature selection
      cmap                         -> heatmap color palette
    """
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, "Dataset not found")

    cmap_name = str(cmap).strip().lower()
    if cmap_name not in HEATMAP_COLORMAPS:
        cmap_name = "viridis"

    mtime_md, mtime_ft = _dataset_mtimes(dataset_dir)

    # The clustered/reordered matrix depends on every filter EXCEPT the color
    # palette — cache it so palette swaps (and repeat requests) skip the
    # O(n^2) hierarchical clustering and label parsing entirely.
    cluster_key = (
        safe_name, mtime_md, mtime_ft,
        str(attribute), str(categories), str(samples),
        row_id_filter.strip().lower(),
        float(mz_min), float(mz_max), float(rt_min), float(rt_max),
    )
    cluster = HEATMAP_CLUSTER_CACHE.get(cluster_key)

    if cluster is None:
        md, ft = get_cached_dataset(safe_name, dataset_dir)
        if md is None or ft is None:
            raise HTTPException(400, "Dataset files missing")

        md.index = md.index.astype(str)
        ft.columns = [str(c) for c in ft.columns]
        ft.index = ft.index.astype(str)

        # --- Attribute → category → sample filtering (FBMN-STATS style) ---
        filtered_md = md
        title_suffix = ""
        if attribute and attribute in md.columns:
            filtered_md = md[md[attribute].notna()]
            cat_list = [c.strip() for c in categories.split(",") if c.strip()] if categories else []
            if cat_list:
                filtered_md = filtered_md[filtered_md[attribute].astype(str).isin(cat_list)]
            title_suffix += f" | {attribute} ({len(cat_list) if cat_list else 'all'} groups)"

        if samples:
            sample_list = [s.strip() for s in samples.split(",") if s.strip()]
            if sample_list:
                filtered_md = filtered_md[filtered_md.index.isin(sample_list)]

        sample_cols = [c for c in ft.columns if c in filtered_md.index]
        if len(sample_cols) < 2 or ft.shape[0] < 2:
            raise HTTPException(400, f"Insufficient data for heatmap: {len(sample_cols)} sample(s) after filtering (need at least 2).")

        # --- Feature filtering, vectorized over cached parsed labels ---
        parts = _get_feature_parts(safe_name, ft, mtime_ft)
        mask = np.ones(len(ft.index), dtype=bool)
        if row_id_filter and row_id_filter.strip():
            q = row_id_filter.strip().lower()
            mask &= np.array([q in rid for rid in parts["row_ids"]], dtype=bool)
        mz_arr, rt_arr = parts["mz"], parts["rt"]
        mask &= np.isnan(mz_arr) | ((mz_arr >= mz_min) & (mz_arr <= mz_max))
        mask &= np.isnan(rt_arr) | ((rt_arr >= rt_min) & (rt_arr <= rt_max))

        filtered_indices = ft.index[mask]
        features_total = int(len(filtered_indices))
        if features_total < 1:
            raise HTTPException(400, "No features match filter criteria")

        # Cap features sent to clustering — linkage is O(n^2) in both time and
        # memory, so very large feature sets would otherwise stall the request.
        capped = False
        if features_total > HEATMAP_MAX_FEATURES:
            mean_intensity = ft.loc[filtered_indices, sample_cols].mean(axis=1)
            filtered_indices = mean_intensity.nlargest(HEATMAP_MAX_FEATURES).index
            capped = True

        ft_sub = ft.loc[filtered_indices, sample_cols].fillna(0.0)

        try:
            # Cluster using log-transformed data
            cluster_data = np.log10(ft_sub + 1)
            if ft_sub.shape[0] >= 2:
                cluster_ft = dendrogram(linkage(cluster_data, method="complete", metric="euclidean"), no_plot=True)
                ft_order = cluster_ft["leaves"]
            else:
                ft_order = list(range(ft_sub.shape[0]))
            cluster_samples = dendrogram(linkage(cluster_data.T, method="complete", metric="euclidean"), no_plot=True)

            # Reorder data using cluster leaves
            ord_ft = ft_sub.iloc[ft_order, cluster_samples["leaves"]]
        except Exception as e:
            raise HTTPException(500, f"Heatmap clustering failed: {str(e)}")

        # Prepare title
        if row_id_filter:
            title_suffix += f" | Row ID: {row_id_filter}"
        if mz_min > 0 or mz_max < 10000:
            title_suffix += f" | m/z: {mz_min:.1f}-{mz_max:.1f}"
        if rt_min > 0 or rt_max < 10000:
            title_suffix += f" | RT: {rt_min:.1f}-{rt_max:.1f}"
        if capped:
            title_suffix += f" | top {HEATMAP_MAX_FEATURES:,} of {features_total:,} features"

        cluster = {
            "ord_ft": ord_ft,
            "title_suffix": title_suffix,
            "n_features": int(ord_ft.shape[0]),
            "n_samples": len(sample_cols),
            "features_total": features_total,
            "capped": capped,
        }
        # Bound memory: drop stale entries for this dataset, then cap total size (FIFO).
        for k in [k for k in HEATMAP_CLUSTER_CACHE if k[0] == safe_name]:
            HEATMAP_CLUSTER_CACHE.pop(k, None)
        while len(HEATMAP_CLUSTER_CACHE) >= HEATMAP_CLUSTER_CACHE_MAX:
            HEATMAP_CLUSTER_CACHE.pop(next(iter(HEATMAP_CLUSTER_CACHE)))
        HEATMAP_CLUSTER_CACHE[cluster_key] = cluster

    ord_ft = cluster["ord_ft"]
    title_suffix = cluster["title_suffix"]

    try:
        # Generate Matplotlib heatmap
        fig, ax = plt.subplots(figsize=(12, 8), dpi=100)
        im = ax.imshow(ord_ft.values, cmap=cmap_name, aspect='auto', interpolation='nearest')

        ax.set_xlabel("Samples", fontsize=10)
        ax.set_ylabel("Metabolites", fontsize=10)
        ax.set_title(f"Intensity Heatmap: {safe_name}{title_suffix}", fontsize=12, pad=10)

        # Add colorbar
        cbar = plt.colorbar(im, ax=ax)
        cbar.set_label('Intensity', fontsize=9)

        # Set tick labels (simplified for large datasets)
        n_samples = len(ord_ft.columns)
        n_features = len(ord_ft.index)
        sample_step = max(1, n_samples // 10)
        feature_step = max(1, n_features // 10)

        ax.set_xticks(range(0, n_samples, sample_step))
        ax.set_xticklabels([ord_ft.columns[i] for i in range(0, n_samples, sample_step)], rotation=45, ha='right', fontsize=7)
        ax.set_yticks(range(0, n_features, feature_step))
        ax.set_yticklabels([str(ord_ft.index[i]).split('&')[0] for i in range(0, n_features, feature_step)], fontsize=7)

        plt.tight_layout()

        # Render to PNG in memory
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=100, bbox_inches='tight')
        plt.close(fig)

        # Return as base64 data URI so the frontend can render it in an <img> tag
        img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return {
            "image": f"data:image/png;base64,{img_b64}",
            "title": f"Intensity Heatmap: {safe_name}{title_suffix}",
            "features": cluster["n_features"],
            "samples": cluster["n_samples"],
            "features_total": cluster["features_total"],
            "features_capped": cluster["capped"],
        }

    except Exception as e:
        raise HTTPException(500, f"Heatmap generation failed: {str(e)}")


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


_MISSING_SMILES = frozenset({"nan", "none", "null", "n/a", "na", "-", "--", "?", "unknown"})


@lru_cache(maxsize=65536)
def _formula_from_smiles(smiles: str) -> Optional[str]:
    """Convert a SMILES string to a molecular formula (requires RDKit)."""
    if not _RDKIT_AVAILABLE or not isinstance(smiles, str):
        return None
    smi = smiles.strip()
    # Missing values arrive as placeholder text ("nan", "N/A", ...); RDKit would only fail on them
    if not smi or smi.lower() in _MISSING_SMILES:
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
        # Only SMILES that RDKit can turn into a formula count (missing values read as "None")
        mask = has_formula.to_numpy(copy=True)
        smiles = an[smiles_col].to_numpy()
        for i in np.flatnonzero(~mask):
            mask[i] = _formula_from_smiles(smiles[i]) is not None
        has_formula = pd.Series(mask, index=an.index)

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


def _element_counts(formula: str) -> dict:
    """Atom counts of a molecular formula such as 'C6H12O6'.

    Salts and hydrates are written as dot-separated parts ('C37H36N2O9S3.2H3N'); only the
    part with the most carbon atoms (the organic molecule) is counted, so counter-ions and
    water do not shift its ratios.
    """
    if not isinstance(formula, str) or not formula or pd.isna(formula):
        return {}
    best: dict = {}
    for part in formula.split("."):
        counts: dict = {}
        # Leading multipliers ('2H3N') are skipped: only the matched element symbols are read
        for elem, count_str in re.findall(r'([A-Z][a-z]?)(\d*)', part):
            counts[elem] = counts.get(elem, 0) + (int(count_str) if count_str else 1)
        if counts.get('C', 0) > best.get('C', 0):
            best = counts
    return best


def calculate_ratios_from_formula(formula: str) -> tuple[Optional[float], Optional[float]]:
    """(O/C, H/C) atomic ratios for the Van Krevelen diagram."""
    counts = _element_counts(formula)
    c = counts.get('C', 0)
    if c == 0:
        return None, None
    return counts.get('O', 0) / c, counts.get('H', 0) / c


def calculate_carbon_oxidation_state(formula: str) -> Optional[float]:
    """Nominal oxidation state of carbon (NOSC; LaRowe & Van Cappellen 2011) of a neutral molecule.

    NOSC = 4 - (4C + H - 3N - 2O + 5P - 2S) / C

    i.e. H at +1, N at -3, O at -2, P at +5 and S at -2. Other elements are not counted.
    Returns None if the formula has no carbon.
    """
    counts = _element_counts(formula)
    c = counts.get('C', 0)
    if c == 0:
        return None
    h, n, o, p, s = (counts.get(e, 0) for e in ('H', 'N', 'O', 'P', 'S'))
    return 4 - (4 * c + h - 3 * n - 2 * o + 5 * p - 2 * s) / c


def classify_by_formula_ratios(formula: str, o_c: float, h_c: float) -> str:
    n = _element_counts(formula).get('N', 0)
    
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


# Compound class columns of the annotation table (CANOPUS / NPClassifier), used to group plot points
CLASS_COLUMNS = (
    "superclass", "class", "subclass",
    "npclassifier_superclass", "npclassifier_class", "npclassifier_pathway",
)


def _class_label(value) -> str:
    """A class name, or 'Unclassified' when the column is missing or the value is empty."""
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return "Unclassified"
    text = str(value).strip()
    return "Unclassified" if text.lower() in ("", "nan", "none") else text


def _top_formula_rows(safe_name: str, dataset_dir: Path, show_msbuddy: bool) -> dict:
    """Shared by the Van Krevelen and Carbon Oxidation State plots: annotation rows with a
    molecular formula for the 1,000 most intense annotated features (by mean intensity over
    biological samples), plus feature counts. Cached until the dataset changes."""
    def compute() -> dict:
        an = _annotation_frame(safe_name, dataset_dir)
        md, ft = _dataset_frames(safe_name, dataset_dir)
        if an is None or ft is None:
            return {"missing": True}
        # Blanks/controls are found from all metadata columns, including ones not made public:
        # only the resulting mean intensities are returned, never the hidden values.
        if ft.empty:
            return {"empty": True}

        scan_col = next((c for c in ["#Scan#", "row ID", "row_id"] if c in an.columns), None)
        formula_col = next((c for c in an.columns if c.lower() in ["molecular_formula", "formula"]), None)
        inchi_col = next((c for c in an.columns if c.lower() == "inchi"), None)
        smiles_col = next((c for c in an.columns if c.lower() in ("smiles", "smile")), None)

        # Scans carrying a formula from ANY source (SIRIUS/ZODIAC, library match, InChI, SMILES)
        annotated_scans = _get_annotated_scans(an, scan_col, formula_col, include_msbuddy=show_msbuddy)

        # Text labels on a shallow copy: the cached table itself is never modified
        ft = ft.copy(deep=False)
        ft.index = ft.index.astype(str)
        ft.columns = [str(c) for c in ft.columns]

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
        rids = [str(k).split("_")[0] for k in ft.index.values]
        rids = [rid[:-2] if rid.endswith(".0") else rid for rid in rids]

        # Filter for annotated features
        is_annotated = np.array([rid in annotated_scans for rid in rids], dtype=bool)
        ft_filtered = ft.loc[is_annotated]

        # Calculate mean intensities over biological samples
        if not ft_filtered.empty and bio_samples:
            mean_intensities = ft_filtered[bio_samples].mean(axis=1).fillna(0.0).to_dict()
        else:
            mean_intensities = {}

        # Sort by mean intensity descending and take top 1000
        sirius_features = [(f_key, mean_intensities.get(f_key, 0.0)) for f_key in ft_filtered.index]
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
        an_keep_mask = np.array([s in row_id_to_full for s in normalized_scans], dtype=bool)
        an_subset = an.loc[an_keep_mask] if len(an_keep_mask) else an.iloc[0:0]

        name_col = next((c for c in ["Compound_Name", "compound_name", "name", "Name"] if c in an.columns), None)

        rows = []
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

            f_key = row_id_to_full[rid]
            rows.append({
                "metabolite": f_key,
                "row_id": rid,
                "formula": formula,
                "formula_source": "msbuddy" if is_msbuddy else formula_source,
                "compound_name": str(row[name_col]) if name_col and not pd.isna(row[name_col]) else "",
                "intensity": mean_intensities.get(f_key, 1.0),
                **{col: _class_label(row.get(col)) for col in CLASS_COLUMNS},
            })

        return {
            "rows": rows,
            "total_features": int(ft.shape[0]),
            "annotated_features": int(is_annotated.sum()),
        }

    return _cached_stats(_stats_key("formula-rows", dataset_dir, bool(show_msbuddy)), compute)


@app.get("/api/datasets/{safe_name}/vankrevelen")
def get_dataset_vankrevelen(
    safe_name: str,
    show_msbuddy: bool = False
):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")

    def compute() -> str:
        base = _top_formula_rows(safe_name, dataset_dir, show_msbuddy)
        if base.get("missing"):
            return json.dumps({
                "points": [], "total_points": 0, "message": "Required files missing.",
                "unannotated_significant_count": 0, "total_features": 0
            })
        if base.get("empty"):
            return json.dumps({"points": [], "total_points": 0, "total_features": 0})

        points = []
        for row in base["rows"]:
            o_c, h_c = calculate_ratios_from_formula(row["formula"])
            if o_c is None or h_c is None: continue
            points.append({**row, "o_c": o_c, "h_c": h_c})

        return json.dumps({
            "points": points, "total_points": len(points),
            "unannotated_significant_count": 0,
            "total_features": base["total_features"],
            "annotated_features": base["annotated_features"],
            "msbuddy_included": bool(show_msbuddy),
        })

    return _json_response(_cached_stats(_stats_key("vankrevelen", dataset_dir, bool(show_msbuddy)), compute))


@app.get("/api/datasets/{safe_name}/carbon-ox-state")
def get_dataset_carbon_ox_state(safe_name: str, show_msbuddy: bool = False):
    """
    Get Carbon Oxidation State (COS) data for annotated features.

    Returns top features by intensity with COS values and classification.
    """
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")

    def compute() -> str:
        base = _top_formula_rows(safe_name, dataset_dir, show_msbuddy)
        if base.get("missing"):
            return json.dumps({
                "points": [], "total_points": 0, "message": "Required files missing.",
                "total_features": 0
            })
        if base.get("empty"):
            return json.dumps({"points": [], "total_points": 0, "total_features": 0})

        points = []
        for row in base["rows"]:
            cos = calculate_carbon_oxidation_state(row["formula"])
            if cos is None: continue
            points.append({**row, "cos": cos})

        return json.dumps({
            "points": points,
            "total_points": len(points),
            "total_features": base["total_features"],
            "annotated_features": base["annotated_features"],
            "msbuddy_included": bool(show_msbuddy),
        })

    return _json_response(_cached_stats(_stats_key("carbon-ox-state", dataset_dir, bool(show_msbuddy)), compute))


@app.get("/api/datasets/{safe_name}/unannotated-count")
def get_unannotated_count(safe_name: str):
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists(): return {"count": 0}
    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    if not an_path.exists() or not ft_path.exists(): return {"count": 0}

    an = _annotation_frame(safe_name, dataset_dir)
    _, ft = _dataset_frames(safe_name, dataset_dir)
    if ft is None: ft = pd.read_parquet(ft_path)

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
def get_formula_coverage(safe_name: str):
    """Molecular-formula coverage report for a dataset, with guidance on
    improving coverage upstream via SIRIUS + ZODIAC."""
    dataset_dir = DATASETS_DIR / safe_name
    if not dataset_dir.exists():
        raise HTTPException(404, f"Dataset {safe_name} not found")
    an_path = dataset_dir / "an.parquet"
    ft_path = dataset_dir / "ft.parquet"
    if not ft_path.exists():
        raise HTTPException(404, "Feature table missing")

    _, ft = _dataset_frames(safe_name, dataset_dir)
    if ft is None: ft = pd.read_parquet(ft_path)
    total_features = int(ft.shape[0])
    ft_rids = set()
    for k in ft.index:
        rid = str(k).split("_")[0]
        if rid.endswith(".0"): rid = rid[:-2]
        ft_rids.add(rid)

    by_source = {"sirius_or_library": 0, "inchi": 0, "smiles": 0, "msbuddy": 0}
    annotated_rids: set = set()

    if an_path.exists():
        an = _annotation_frame(safe_name, dataset_dir)
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
# Statistics dashboard warm-up
# ---------------------------------------------------------------------------

def _warm_stats_caches(names: Optional[list] = None) -> None:
    """Precompute each public dataset's default dashboard results (including the
    Bray-Curtis distance matrix behind PCoA), so the first use of the dashboard is instant."""
    for dataset_dir in sorted(DATASETS_DIR.iterdir()):
        if names is not None and dataset_dir.name not in names:
            continue
        meta_path = dataset_dir / "meta.json"
        if not dataset_dir.is_dir() or not meta_path.exists():
            continue
        try:
            if json.loads(meta_path.read_text()).get("hidden"):
                continue
            safe = dataset_dir.name
            get_dataset_metadata_schema(safe)
            get_dataset_metabolites(safe)
            get_dataset_vankrevelen(safe)
            get_dataset_carbon_ox_state(safe)
            run_map_pcoa({"dataset_safe": safe})
        except Exception as exc:  # warm-up is best effort; requests compute on demand
            print(f"Statistics warm-up skipped for {dataset_dir.name}: {exc}")


def _start_stats_warmup(names: Optional[list] = None) -> None:
    threading.Thread(target=_warm_stats_caches, args=(names,), daemon=True).start()


@app.on_event("startup")
async def _warm_stats_on_startup() -> None:
    if os.environ.get("STATS_WARMUP", "1") != "0":
        _start_stats_warmup()


# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
