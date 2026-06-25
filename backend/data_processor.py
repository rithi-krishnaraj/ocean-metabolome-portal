"""
data_processor.py
All data loading, parsing, aggregation and filtering logic.
The Flask routes delegate here; no HTTP/Flask code lives in this module.
"""

from __future__ import annotations

import io
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Column name normalisation helpers
# ---------------------------------------------------------------------------

# Maps internal "_key" names to lists of possible source column names
# (checked in order; first match wins).
COLUMN_MAP: Dict[str, List[str]] = {
    "_lat": ["ATTRIBUTE_Latitude", "Latitude", "latitude", "lat"],
    "_lon": ["ATTRIBUTE_Longitude", "Longitude", "longitude", "lon", "long"],
    "_depth": ["ATTRIBUTE_Depth", "Depth", "depth"],
    "_region": ["ATTRIBUTE_region", "Region", "region"],
    "_ecosystem": ["ATTRIBUTE_ecosystem", "Ecosystem", "ecosystem"],
    "_year": ["ATTRIBUTE_Year", "Year", "year"],
    "_type": ["ATTRIBUTE_type", "Type", "type"],
    "_type2": ["ATTRIBUTE_type2", "Type2", "type2"],
    "_batch": ["ATTRIBUTE_batch", "Batch", "batch"],
    "_descriptor": ["ATTRIBUTE_descriptor", "Descriptor", "descriptor"],
    "_depth_bucket": ["ATTRIBUTE_Depth_bucket", "Depth_bucket", "depth_bucket"],
    "_dist_coast_km": ["ATTRIBUTE_distance_to_coast_km", "distance_to_coast_km"],
    "_dist_coast_bucket": ["ATTRIBUTE_distancetocoast_bucket", "distancetocoast_bucket"],
    "_massive_id": ["MassIVE ID", "MassIVE_ID", "massive_id"],
    "_filename": ["filename", "Filename", "file_name"],
    "_submitter": ["Submitter", "submitter"],
    "_collector": ["Sample Collector", "sample_collector"],
}

REQUIRED_COLUMNS = {"_lat", "_lon"}


def _map_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Add internal '_*' columns by mapping from raw column names."""
    for target, sources in COLUMN_MAP.items():
        for src in sources:
            if src in df.columns:
                df[target] = df[src]
                break
        else:
            if target not in df.columns:
                df[target] = pd.NA
    return df


def _parse_tsv(source: io.BytesIO | str) -> pd.DataFrame:
    """Read a TSV/TXT metadata file and return a normalised DataFrame."""
    kwargs: Dict[str, Any] = dict(
        sep="\t",
        dtype=str,
        on_bad_lines="skip",
        encoding="utf-8",
    )
    if isinstance(source, (str, Path)):
        df = pd.read_csv(source, **kwargs)
    else:
        content = source.read()
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        df = pd.read_csv(io.StringIO(text), **kwargs)

    # Strip whitespace from column names
    df.columns = [c.strip() for c in df.columns]
    df = _map_columns(df)

    # Coerce numeric lat/lon
    df["_lat"] = pd.to_numeric(df["_lat"], errors="coerce")
    df["_lon"] = pd.to_numeric(df["_lon"], errors="coerce")
    df["_depth"] = pd.to_numeric(df["_depth"], errors="coerce")
    df["_year"] = df["_year"].str.strip() if df["_year"].notna().any() else df["_year"]

    return df


def _parse_ft_bytes(ft_bytes: bytes) -> pd.DataFrame:
    """Parse a feature quantification table (CSV or TSV), auto-detecting separator."""
    try:
        text = ft_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = ft_bytes.decode("latin-1")
    sample = text[:4096]
    sep = "\t" if sample.count("\t") >= sample.count(",") else ","
    df = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, on_bad_lines="skip")
    df.columns = [c.strip() for c in df.columns]
    return df


# GNPS standard merge keys (used in staging preview and enforced for GNPS imports)
GNPS_FT_KEY   = "row ID"
GNPS_AN_KEY   = "#Scan#"
GNPS_NAME_KEY = "Compound_Name"


def _get_sample_cols(df: pd.DataFrame) -> List[str]:
    """Return column names that are sample intensity columns (not metadata/feature-id columns)."""
    cols = [c for c in df.columns if ".mzML" in c or ".mzXML" in c or " Peak area" in c]
    if cols:
        return cols
    _skip = {"row ID", "row m/z", "row retention time", "metabolite", "row number"}
    return [c for c in df.columns if c not in _skip]


def _build_df_preview(df: pd.DataFrame, max_rows: int = 5, max_cols: int = 12) -> Dict:
    """Return a JSON-serialisable preview dict for *df* (first rows, non-internal columns)."""
    all_cols = [c for c in df.columns if not c.startswith("_")]
    cols = all_cols[:max_cols]
    rows = df[cols].head(max_rows).fillna("").astype(str).to_dict(orient="records")
    return {
        "columns": cols,
        "rows": rows,
        "total_rows": len(df),
        "total_cols": len(all_cols),
    }


def _build_metabolite_labels(df: pd.DataFrame) -> pd.Series:
    """Build FBMN-style metabolite labels: row ID_row m/z@row retention time."""
    if df.empty:
        return pd.Series(dtype=str)

    def _clean_part(value: Any) -> str:
        if pd.isna(value):
            return "NA"
        text = str(value).strip()
        return text if text else "NA"

    def _format_mz(value: Any) -> str:
        if pd.isna(value):
            return "NA"
        try:
            return f"{float(value):.4f}"
        except (TypeError, ValueError):
            return _clean_part(value)

    def _format_rt(value: Any) -> str:
        if pd.isna(value):
            return "NA"
        try:
            return f"{float(value):.2f}"
        except (TypeError, ValueError):
            return _clean_part(value)

    row_id = df[GNPS_FT_KEY] if GNPS_FT_KEY in df.columns else pd.Series(df.index.astype(str), index=df.index)
    mz = df["row m/z"] if "row m/z" in df.columns else pd.Series(["NA"] * len(df), index=df.index)
    rt = df["row retention time"] if "row retention time" in df.columns else pd.Series(["NA"] * len(df), index=df.index)
    return row_id.map(_clean_part) + "_" + mz.map(_format_mz) + "@" + rt.map(_format_rt)


def _normalise_sample_name(value: Any) -> str:
    """Normalise sample IDs so FT columns and metadata filenames can be aligned."""
    text = str(value).strip()
    text = text.replace(" Peak area", "")
    text = text.replace(".mzML", "")
    text = text.replace(".mzXML", "")
    return text


def _make_unique_labels(labels: pd.Series) -> pd.Series:
    """Ensure labels are unique by appending a numeric suffix when repeated."""
    counts: Dict[str, int] = {}
    out: List[str] = []
    for raw in labels.astype(str).tolist():
        val = raw if raw else "NA"
        counts[val] = counts.get(val, 0) + 1
        if counts[val] == 1:
            out.append(val)
        else:
            out.append(f"{val}__{counts[val]}")
    return pd.Series(out, index=labels.index)


def _build_final_concatenated_table(
    md_df: pd.DataFrame,
    ft_df: Optional[pd.DataFrame],
    an_df: Optional[pd.DataFrame],
) -> Optional[pd.DataFrame]:
    """Build a Final Table.csv-like matrix: metadata columns + transposed FT intensity columns.

    The output is sample-wise (one row per sample), with metabolite columns named using
    FBMN-style labels and annotation names appended as "metabolite&Compound_Name" when available.
    """
    if ft_df is None or ft_df.empty or md_df is None or md_df.empty:
        return None

    md_public_cols = [c for c in md_df.columns if not c.startswith("_")]
    if not md_public_cols:
        return None

    filename_col = next((c for c in md_public_cols if c.lower() in ("filename", "file_name")), None)

    md_work = md_df.copy()
    if filename_col and filename_col in md_work.columns:
        md_work = md_work.set_index(filename_col)
    md_work.index = md_work.index.map(_normalise_sample_name)

    ft_work = ft_df.copy()
    sample_cols = _get_sample_cols(ft_work)
    if not sample_cols:
        return None

    metabolite = _build_metabolite_labels(ft_work)

    if (
        an_df is not None
        and not an_df.empty
        and GNPS_FT_KEY in ft_work.columns
        and GNPS_AN_KEY in an_df.columns
        and GNPS_NAME_KEY in an_df.columns
    ):
        an_merge = an_df[[GNPS_AN_KEY, GNPS_NAME_KEY]].copy()
        an_merge[GNPS_AN_KEY] = an_merge[GNPS_AN_KEY].astype(str)
        ft_keys = ft_work[GNPS_FT_KEY].astype(str)
        name_map = dict(zip(an_merge[GNPS_AN_KEY], an_merge[GNPS_NAME_KEY]))
        compound = ft_keys.map(name_map).fillna("NA").astype(str).str.replace(" ", "_", regex=False)
        metabolite = metabolite.astype(str) + "&" + compound

    metabolite = _make_unique_labels(metabolite)

    ft_num = ft_work[sample_cols].apply(pd.to_numeric, errors="coerce").fillna(0)
    ft_num.index = metabolite
    final_data = ft_num.T
    final_data.index = final_data.index.map(_normalise_sample_name)

    shared_samples = [idx for idx in md_work.index.tolist() if idx in final_data.index]
    if not shared_samples:
        return None

    md_aligned = md_work.loc[shared_samples, md_public_cols if not filename_col else [c for c in md_public_cols if c != filename_col]].copy()
    data_aligned = final_data.loc[shared_samples].copy()

    out = pd.concat([md_aligned, data_aligned], axis=1)
    out.insert(0, "filename", shared_samples)
    return out.reset_index(drop=True)


def _with_stage_display_columns(df: pd.DataFrame, table_name: str) -> pd.DataFrame:
    """Return a copy of *df* with display/download columns used by the staged-table UI."""
    out_df = df.copy()
    if table_name == "md":
        return out_df[[c for c in out_df.columns if not c.startswith("_")]]
    if table_name == "ft":
        out_df.insert(0, "metabolite", _build_metabolite_labels(out_df))
        return out_df
    if table_name == "ft_an":
        metabolite = _build_metabolite_labels(out_df)
        out_df.insert(0, "metabolite", metabolite)
        if GNPS_NAME_KEY in out_df.columns:
            out_df["annotated_name"] = (
                metabolite
                + "&"
                + out_df[GNPS_NAME_KEY].fillna("unknown").astype(str).str.replace(" ", "_", regex=False)
            )
        return out_df
    if table_name == "final":
        return out_df
    return out_df


class DataProcessor:
    """Loads, stores and queries metabolomics metadata files."""

    def __init__(self, data_dir: str = "data") -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # dataset_id (8-char hex) -> metadata dict
        self._datasets: Dict[str, Dict] = {}
        # Combined DataFrame of all loaded data
        self._df: pd.DataFrame = pd.DataFrame()
        # stage_id -> staged data dict (temporary, cleared on commit)
        self._staging: Dict[str, Dict] = {}

        self._load_existing()

    # ------------------------------------------------------------------
    # Startup: scan data directory
    # ------------------------------------------------------------------

    def _load_existing(self) -> None:
        for path in sorted(self.data_dir.iterdir()):
            if path.suffix.lower() not in {".txt", ".tsv", ".csv"}:
                continue

            # Skip legacy helper artifacts that should not be treated as standalone datasets.
            legacy_skip_suffixes = (
                "_ft.txt",
                "_md.txt",
                "_an.tsv",
                "_ft_with_annotations.tsv",
            )
            if path.name.endswith(legacy_skip_suffixes):
                continue

            if path.name.startswith("."):
                continue

            try:
                self._ingest(str(path), path.stem, file_path=path)
            except Exception as exc:  # noqa: BLE001
                print(f"[DataProcessor] Could not load {path.name}: {exc}")
                try:
                    self._ingest(str(path), path.name, file_path=path)
                except Exception as exc:  # noqa: BLE001
                    print(f"[DataProcessor] Could not load {path.name}: {exc}")

    # ------------------------------------------------------------------
    # Public ingestion API
    # ------------------------------------------------------------------

    def load_dataset(
        self,
        md_bytes: bytes,
        name: str,
        ft_bytes: Optional[bytes] = None,
        an_bytes: Optional[bytes] = None,
        task_id: Optional[str] = None,
        save_dir: Optional[Path] = None,
        ft_filename: Optional[str] = None,
        md_filename: Optional[str] = None,
        an_filename: Optional[str] = None,
    ) -> Dict:
        """Load a complete dataset: metadata (required for map), ft and annotation (optional).

        The metadata file drives map locations; ft and annotation are stored as
        supplementary files and their paths are recorded in the dataset dict.
        """
        save_dir = Path(save_dir) if save_dir is not None else None
        ft_path: Optional[Path] = None
        md_path: Optional[Path] = None
        an_path: Optional[Path] = None

        if save_dir is not None:
            save_dir.mkdir(parents=True, exist_ok=True)
            if ft_bytes is not None and ft_filename:
                ft_path = _unique_path(save_dir / ft_filename)
                ft_path.write_bytes(ft_bytes)
            if md_filename:
                md_path = _unique_path(save_dir / md_filename)
                md_path.write_bytes(md_bytes)
            if an_bytes is not None and an_filename:
                an_path = _unique_path(save_dir / an_filename)
                an_path.write_bytes(an_bytes)

        dataset_id = self._ingest(io.BytesIO(md_bytes), name, task_id=task_id, file_path=md_path)

        self._datasets[dataset_id]["ft_path"] = ft_path
        self._datasets[dataset_id]["an_path"] = an_path
        self._datasets[dataset_id]["has_ft"] = ft_bytes is not None
        self._datasets[dataset_id]["has_annotation"] = an_bytes is not None

        return {
            "status": "ok",
            "dataset_id": dataset_id,
            "name": name,
            "rows": self._datasets[dataset_id]["rows"],
            "has_ft": ft_bytes is not None,
            "has_annotation": an_bytes is not None,
        }

    def load_bytes(
        self,
        raw_bytes: bytes,
        name: str,
        task_id: Optional[str] = None,
        file_path: Optional[Path] = None,
    ) -> str:
        """Parse raw bytes and return the new dataset_id."""
        return self._ingest(io.BytesIO(raw_bytes), name, task_id=task_id, file_path=file_path)

    def stage_dataset(
        self,
        md_bytes: bytes,
        ft_bytes: Optional[bytes],
        an_bytes: Optional[bytes],
        name: str,
        task_id: Optional[str] = None,
    ) -> Dict:
        """Parse bytes into DataFrames and store in staging area for preview / data-prep before committing."""
        md_df = _parse_tsv(io.BytesIO(md_bytes))
        orig_cols: List[str] = [c for c in md_df.columns if not c.startswith("_")]

        fn_col = next((c for c in orig_cols if c.lower() in ("filename", "file_name")), None)
        sample_names: List[str] = (
            list(md_df[fn_col].dropna().astype(str).tolist())
            if fn_col
            else list(md_df.index.astype(str).tolist())
        )

        # Build attribute→values map for blank-removal UI (skip filename col; skip high-cardinality cols)
        md_levels: Dict[str, List[str]] = {}
        for col in orig_cols:
            if fn_col and col == fn_col:
                continue
            vals = list(md_df[col].dropna().astype(str).unique())
            if 1 < len(vals) <= 30:
                md_levels[col] = sorted(vals)

        # Parse feature table
        ft_df: Optional[pd.DataFrame] = None
        n_features = 0
        if ft_bytes is not None:
            try:
                ft_df = _parse_ft_bytes(ft_bytes)
                n_features = len(ft_df)
            except Exception as exc:
                print(f"[DataProcessor] Warning: could not parse feature table for staging: {exc}")

        # Parse annotation table (TSV/CSV auto-detect, matching FT logic)
        an_df: Optional[pd.DataFrame] = None
        an_columns: List[str] = []
        n_annotations = 0
        if an_bytes is not None:
            try:
                an_df = _parse_ft_bytes(an_bytes)
                n_annotations = len(an_df)
                an_columns = list(an_df.columns)
            except Exception as exc:
                print(f"[DataProcessor] Warning: could not parse annotation table: {exc}")

        # ── Metadata column validation ────────────────────────────────────
        warnings_list: List[str] = []
        errors_list: List[str] = []

        if "ATTRIBUTE_Latitude" not in orig_cols:
            errors_list.append(
                "Missing required column 'ATTRIBUTE_Latitude'. "
                "This column is needed to place samples on the map."
            )
        if "ATTRIBUTE_Longitude" not in orig_cols:
            errors_list.append(
                "Missing required column 'ATTRIBUTE_Longitude'. "
                "This column is needed to place samples on the map."
            )

        # All non-first columns (excluding the filename column) should start with ATTRIBUTE_
        non_first_cols = orig_cols[1:] if len(orig_cols) > 1 else []
        non_attr_cols = [c for c in non_first_cols if not c.startswith("ATTRIBUTE_")]
        if non_attr_cols:
            sample_str = (
                ", ".join(f"'{c}'" for c in non_attr_cols[:5])
                + (" …" if len(non_attr_cols) > 5 else "")
            )
            warnings_list.append(
                f"Some metadata columns (besides the first) do not start with 'ATTRIBUTE_': "
                f"{sample_str}. GNPS standard format requires all non-filename columns to use "
                "the ATTRIBUTE_ prefix (e.g., ATTRIBUTE_Latitude, ATTRIBUTE_region, …)."
            )

        # ── Build preview data ────────────────────────────────────────────
        md_preview = _build_df_preview(md_df)
        ft_preview = (
            _build_df_preview(ft_df)
            if ft_df is not None and not ft_df.empty else None
        )
        an_preview = (
            _build_df_preview(an_df)
            if an_df is not None and not an_df.empty else None
        )

        # ── Auto-build annotated FT preview (GNPS fixed keys) ────────────
        ft_an_preview = None
        final_preview = None
        if (ft_df is not None and an_df is not None
                and not ft_df.empty and not an_df.empty
                and GNPS_FT_KEY in ft_df.columns
                and GNPS_AN_KEY in an_df.columns):
            try:
                ft_m = ft_df.copy()
                an_m = an_df.copy()
                ft_m[GNPS_FT_KEY] = ft_m[GNPS_FT_KEY].astype(str)
                an_m[GNPS_AN_KEY] = an_m[GNPS_AN_KEY].astype(str)
                merged_df = ft_m.merge(
                    an_m,
                    left_on=GNPS_FT_KEY,
                    right_on=GNPS_AN_KEY,
                    how="left",
                    suffixes=("", "_an"),
                )
                # Build annotated_name column (feature_id&Compound_Name)
                if GNPS_NAME_KEY in merged_df.columns:
                    def _mk_an_name(row: pd.Series) -> str:
                        fid = str(row.get(GNPS_FT_KEY, ""))
                        cn_val = row.get(GNPS_NAME_KEY)
                        cn = str(cn_val) if pd.notna(cn_val) else "unknown"
                        return f"{fid}&{cn.replace(' ', '_')}"
                    merged_df["annotated_name"] = merged_df.apply(_mk_an_name, axis=1)

                sc_set = set(_get_sample_cols(ft_df))
                non_sc = [c for c in merged_df.columns if c not in sc_set and not c.startswith("_")]
                # Put annotated_name first
                if "annotated_name" in non_sc:
                    non_sc = ["annotated_name"] + [c for c in non_sc if c != "annotated_name"]
                preview_cols = non_sc[:15]
                preview_rows = (
                    merged_df[preview_cols].head(5).fillna("").astype(str).to_dict(orient="records")
                )
                ft_an_preview = {
                    "columns": preview_cols,
                    "rows": preview_rows,
                    "total_rows": len(merged_df),
                }
            except Exception as exc:
                print(f"[DataProcessor] Auto annotation preview failed: {exc}")

        stage_id = uuid.uuid4().hex[:12]
        self._staging[stage_id] = {
            "md_bytes": md_bytes,
            "ft_bytes": ft_bytes,
            "an_bytes": an_bytes,
            "ft_df": ft_df,
            "an_df": an_df,
            "ft_an_df": merged_df if 'merged_df' in locals() else None,
            "md_df": md_df,
            "name": name,
            "task_id": task_id,
        }
        return {
            "stage_id": stage_id,
            "name": name,
            "n_samples": len(sample_names),
            "sample_names": sample_names,
            "n_features": n_features,
            "n_annotations": n_annotations,
            "has_ft": ft_bytes is not None,
            "has_annotation": an_bytes is not None,
            "md_columns": orig_cols,
            "md_levels": md_levels,
            "ft_columns": list(ft_df.columns) if ft_df is not None else [],
            "an_columns": an_columns,
            "warnings": warnings_list,
            "errors": errors_list,
            "md_preview": md_preview,
            "ft_preview": ft_preview,
            "an_preview": an_preview,
            "ft_an_preview": ft_an_preview,
        }

    def get_staged_table_page(
        self,
        stage_id: str,
        table_name: str,
        page: int = 1,
        page_size: int = 10,
    ) -> Dict:
        """Return one paginated page from a staged table for the admin preview UI."""
        staged = self._staging.get(stage_id)
        if staged is None:
            return {"error": f"Staged dataset not found (id: {stage_id}). It may have expired."}

        page = max(1, int(page))
        page_size = 25 if int(page_size) == 25 else 10

        table_map = {
            "ft": staged.get("ft_df"),
            "md": staged.get("md_df"),
            "an": staged.get("an_df"),
            "ft_an": staged.get("ft_an_df"),
        }
        df = table_map.get(table_name)
        if df is None or getattr(df, "empty", True):
            return {"error": f"Staged table '{table_name}' is not available."}

        out_df = _with_stage_display_columns(df, table_name)

        total_rows = len(out_df)
        total_pages = max(1, int(np.ceil(total_rows / page_size)))
        page = min(page, total_pages)
        start = (page - 1) * page_size
        end = start + page_size
        page_df = out_df.iloc[start:end].fillna("").astype(str)

        return {
            "table": table_name,
            "page": page,
            "page_size": page_size,
            "total_rows": total_rows,
            "total_pages": total_pages,
            "columns": list(page_df.columns),
            "rows": page_df.to_dict(orient="records"),
        }

    def get_staged_table_download(
        self,
        stage_id: str,
        table_name: str,
    ) -> Dict[str, Any]:
        """Return download-ready bytes and metadata for a staged table."""
        staged = self._staging.get(stage_id)
        if staged is None:
            return {"error": f"Staged dataset not found (id: {stage_id}). It may have expired."}

        table_map = {
            "ft": staged.get("ft_df"),
            "md": staged.get("md_df"),
            "an": staged.get("an_df"),
            "ft_an": staged.get("ft_an_df"),
        }
        df = table_map.get(table_name)
        if df is None or getattr(df, "empty", True):
            return {"error": f"Staged table '{table_name}' is not available."}

        out_df = _with_stage_display_columns(df, table_name).fillna("")
        buffer = io.StringIO()
        out_df.to_csv(buffer, sep="\t", index=False)
        filename = f"{table_name}_preview.tsv"
        return {
            "filename": filename,
            "mimetype": "text/tab-separated-values; charset=utf-8",
            "content": buffer.getvalue().encode("utf-8"),
        }

    def commit_staged(
        self,
        stage_id: str,
        name: Optional[str] = None,
        blank_attribute: Optional[str] = None,
        blank_values: Optional[List[str]] = None,
        blank_cutoff: float = 0.3,
        impute: bool = False,
        ft_key: Optional[str] = None,
        an_key: Optional[str] = None,
        name_key: Optional[str] = None,
        save_dir: Optional[Path] = None,
    ) -> Dict:
        """Apply optional blank removal / imputation to a staged dataset, then permanently ingest it."""
        if stage_id not in self._staging:
            return {"error": f"Staged dataset not found (id: {stage_id}). It may have expired."}

        staged = self._staging[stage_id]
        md_bytes: bytes = staged["md_bytes"]
        ft_bytes: Optional[bytes] = staged.get("ft_bytes")
        an_bytes: Optional[bytes] = staged.get("an_bytes")
        dataset_name = (name or staged["name"]).strip()[:120]
        task_id: Optional[str] = staged.get("task_id")
        ft_df: Optional[pd.DataFrame] = staged.get("ft_df")
        md_df: pd.DataFrame = staged["md_df"]

        data_prep: Dict[str, Any] = {}
        ft_modified = False

        def _sample_cols(df: pd.DataFrame) -> List[str]:
            cols = [c for c in df.columns if ".mzML" in c or ".mzXML" in c]
            if cols:
                return cols
            _skip = {"row ID", "row m/z", "row retention time", "metabolite", "row number"}
            return [c for c in df.columns if c not in _skip]

        def _strip_ext(s: str) -> str:
            return s.replace(".mzXML", "").replace(".mzML", "").replace(" Peak area", "").strip()

        # ── Blank removal ─────────────────────────────────────────────
        if ft_df is not None and blank_attribute and blank_values:
            try:
                orig_cols = [c for c in md_df.columns if not c.startswith("_")]
                fn_col = next((c for c in orig_cols if c.lower() in ("filename", "file_name")), None)
                if blank_attribute in md_df.columns:
                    is_blank_row = md_df[blank_attribute].astype(str).isin(blank_values)
                    blank_fns = (
                        set(md_df.loc[is_blank_row, fn_col].astype(str).tolist())
                        if fn_col
                        else set(md_df.index[is_blank_row].astype(str).tolist())
                    )
                    all_sc = _sample_cols(ft_df)
                    clean_blank = {_strip_ext(f) for f in blank_fns}
                    blank_cols = [c for c in all_sc if _strip_ext(c) in clean_blank]
                    sample_cols = [c for c in all_sc if c not in blank_cols]

                    if blank_cols and sample_cols:
                        ft_num = ft_df[all_sc].apply(pd.to_numeric, errors="coerce").fillna(0)
                        avg_blank = ft_num[blank_cols].mean(axis=1, skipna=False)
                        avg_samples = ft_num[sample_cols].mean(axis=1, skipna=False)
                        ratio = (avg_blank + 1) / (avg_samples + 1)
                        is_real = ratio < float(blank_cutoff)
                        non_sc = [c for c in ft_df.columns if c not in all_sc]
                        ft_df = ft_df[is_real.values][non_sc + sample_cols].copy()
                        ft_modified = True
                        data_prep["blank_removal"] = {
                            "features_removed": int((~is_real).sum()),
                            "features_kept": int(is_real.sum()),
                            "blank_samples_removed": len(blank_cols),
                            "attribute": blank_attribute,
                            "values": blank_values,
                        }
            except Exception as exc:
                print(f"[DataProcessor] Blank removal failed: {exc}")
                data_prep["blank_removal_error"] = str(exc)

        # ── Imputation ────────────────────────────────────────────────
        if ft_df is not None and impute:
            try:
                sc = _sample_cols(ft_df)
                if sc:
                    ft_num = ft_df[sc].apply(pd.to_numeric, errors="coerce").fillna(0)
                    min_val = ft_num.replace(0, float("nan")).min().min()
                    if not pd.isna(min_val) and float(min_val) > 1:
                        lod = int(round(float(min_val)))
                        mask = ft_num == 0
                        rand_fill = pd.DataFrame(
                            np.random.randint(1, lod, size=ft_num.shape),
                            columns=ft_num.columns,
                            index=ft_num.index,
                        )
                        imputed = ft_num.where(~mask, other=rand_fill)
                        ft_df = ft_df.copy()
                        ft_df[sc] = imputed
                        ft_modified = True
                        data_prep["imputation"] = {"lod_cutoff": lod}
            except Exception as exc:
                print(f"[DataProcessor] Imputation failed: {exc}")
                data_prep["imputation_error"] = str(exc)

        # Re-serialise modified feature table
        if ft_modified and ft_df is not None:
            buf = io.StringIO()
            ft_df.to_csv(buf, sep="\t", index=False)
            ft_bytes = buf.getvalue().encode("utf-8")

        # ── Annotation merge (mirrors FBMN-STATS merge_annotation logic) ────────
        ft_with_an_bytes: Optional[bytes] = None
        ft_with_an_preview: Optional[Dict] = None
        if ft_df is not None and ft_key and an_key:
            an_df_staged: Optional[pd.DataFrame] = staged.get("an_df")
            if an_df_staged is not None and not an_df_staged.empty:
                try:
                    ft_merge = ft_df.copy()
                    an_merge = an_df_staged.copy()
                    # Coerce join keys to string (same as FBMN-STATS merge_annotation)
                    ft_merge[ft_key] = ft_merge[ft_key].astype(str)
                    an_merge[an_key] = an_merge[an_key].astype(str)

                    merged = ft_merge.merge(
                        an_merge,
                        left_on=ft_key,
                        right_on=an_key,
                        how="left",          # keep all FT rows (FBMN-STATS pattern)
                        suffixes=("", "_an"),
                    )

                    # Build metabolite + annotated feature names.
                    # Preferred format: rowID_mz@rt&Compound_Name
                    if ft_key == GNPS_FT_KEY:
                        merged["metabolite"] = _build_metabolite_labels(merged)
                    if name_key and name_key in merged.columns:
                        if "metabolite" in merged.columns:
                            merged["annotated_name"] = (
                                merged["metabolite"].astype(str)
                                + "&"
                                + merged[name_key].fillna("unknown").astype(str).str.replace(" ", "_", regex=False)
                            )
                        else:
                            def _make_annotated_name(row: pd.Series) -> str:
                                fid = str(row.get(ft_key, ""))
                                cname = str(row[name_key]) if pd.notna(row[name_key]) else "unknown"
                                return f"{fid}&{cname.replace(' ', '_')}"
                            merged["annotated_name"] = merged.apply(_make_annotated_name, axis=1)

                    buf2 = io.StringIO()
                    merged.to_csv(buf2, sep="\t", index=False)
                    ft_with_an_bytes = buf2.getvalue().encode("utf-8")

                    # Preview: exclude sample intensity columns (same pattern as stats app)
                    sc_set = set(_sample_cols(ft_df))
                    preview_cols = [c for c in merged.columns if c not in sc_set]
                    preview_df = merged[preview_cols].head(20).fillna("").astype(str)
                    ft_with_an_preview = {
                        "columns": list(preview_df.columns),
                        "rows": preview_df.to_dict(orient="records"),
                        "total_features": len(merged),
                        "ft_key": ft_key,
                        "an_key": an_key,
                        "name_key": name_key,
                    }
                    data_prep["annotation_merge"] = {
                        "features_merged": len(merged),
                        "ft_key": ft_key,
                        "an_key": an_key,
                        "name_key": name_key,
                    }
                except Exception as exc:
                    print(f"[DataProcessor] Annotation merge failed: {exc}")
                    data_prep["annotation_merge_error"] = str(exc)

        # ── Final concatenated table (built AFTER cleanup steps) ───────────────
        final_table_bytes: Optional[bytes] = None
        final_table_preview: Optional[Dict[str, Any]] = None
        try:
            final_df = _build_final_concatenated_table(
                md_df=md_df,
                ft_df=ft_df,
                an_df=staged.get("an_df"),
            )
            if final_df is not None and not final_df.empty:
                final_buf = io.StringIO()
                final_df.to_csv(final_buf, sep="\t", index=False)
                final_table_bytes = final_buf.getvalue().encode("utf-8")
                final_table_preview = {
                    "columns": list(final_df.columns[:20]),
                    "rows": final_df.iloc[:20, :20].fillna("").astype(str).to_dict(orient="records"),
                    "total_rows": len(final_df),
                    "total_cols": len(final_df.columns),
                }
        except Exception as exc:
            print(f"[DataProcessor] Final concatenated table build failed: {exc}")
            data_prep["final_table_error"] = str(exc)

        # Keep dataset loaded in memory for map/UI state.
        try:
            result = self.load_dataset(
                md_bytes=md_bytes,
                ft_bytes=ft_bytes,
                an_bytes=an_bytes,
                name=dataset_name,
                task_id=task_id,
                save_dir=None,
                ft_filename=None,
                md_filename=None,
                an_filename=None,
            )
        except ValueError as exc:
            return {"error": str(exc)}

        # Persist only the final concatenated table to backend/data.
        if final_table_bytes is not None and save_dir is not None:
            default_name = task_id if task_id else f"dataset_{stage_id}"
            final_stem = _safe_dataset_filename(dataset_name or default_name, fallback=default_name)
            final_path = _unique_path(Path(save_dir) / f"{final_stem}.tsv")
            final_path.write_bytes(final_table_bytes)
            ds_id = result.get("dataset_id")
            if ds_id and ds_id in self._datasets:
                self._datasets[ds_id]["file_path"] = final_path
                self._datasets[ds_id]["final_concatenated_table_path"] = final_path
                self._datasets[ds_id]["has_final_concatenated_table"] = True
                # Ensure helper artifacts are not tracked/persisted.
                self._datasets[ds_id]["ft_path"] = None
                self._datasets[ds_id]["an_path"] = None
                self._datasets[ds_id]["ft_with_annotations_path"] = None

        if final_table_bytes is None:
            data_prep["final_table_warning"] = (
                "Final concatenated table was not generated, so no file was persisted in backend/data."
            )

        del self._staging[stage_id]
        result["data_prep"] = data_prep
        if ft_with_an_preview is not None:
            result["ft_with_annotations"] = ft_with_an_preview
        if final_table_preview is not None:
            result["final_concatenated_table"] = final_table_preview
        return result

    # ------------------------------------------------------------------
    # Internal ingestion
    # ------------------------------------------------------------------

    def _ingest(
        self,
        source,
        name: str,
        task_id: Optional[str] = None,
        file_path: Optional[Path] = None,
    ) -> str:
        df = _parse_tsv(source)

        missing = REQUIRED_COLUMNS - set(df.columns)
        if missing:
            raise ValueError(
                f"File is missing required columns: {missing}. "
                "Ensure it has Latitude and Longitude columns."
            )

        dataset_id = uuid.uuid4().hex[:8]
        df["_dataset_id"] = dataset_id
        df["_dataset_name"] = name

        self._datasets[dataset_id] = {
            "id": dataset_id,
            "name": name,
            "rows": len(df),
            "columns": list(df.columns),
            "task_id": task_id,
            "file_path": Path(file_path) if file_path is not None else None,
        }
        self._df = pd.concat([self._df, df], ignore_index=True)
        print(f"[DataProcessor] Loaded '{name}' ({len(df)} rows) → id={dataset_id}")
        return dataset_id

    # ------------------------------------------------------------------
    # Public query API (called by Flask routes)
    # ------------------------------------------------------------------

    def get_locations(self, filters: Optional[Dict] = None) -> List[Dict]:
        """Return sample locations aggregated by (lat, lon) after filtering."""
        df = self._df.copy()
        if df.empty:
            return []

        # Drop rows without coordinates
        df = df.dropna(subset=["_lat", "_lon"])

        # Exclude blank/QC rows
        if "_type" in df.columns:
            df = df[~df["_type"].str.upper().isin(["BLANK", "QC"])]

        # Apply optional filters
        if filters:
            if filters.get("region"):
                df = df[df["_region"] == filters["region"]]
            if filters.get("year"):
                df = df[df["_year"] == str(filters["year"])]
            if filters.get("ecosystem"):
                df = df[df["_ecosystem"] == filters["ecosystem"]]
            if filters.get("depth_bucket"):
                df = df[df["_depth_bucket"] == filters["depth_bucket"]]
            if filters.get("dataset_id"):
                df = df[df["_dataset_id"] == filters["dataset_id"]]

        if df.empty:
            return []

        # Round coordinates for spatial grouping (~10 m precision at the equator)
        df["_lat_r"] = df["_lat"].round(4)
        df["_lon_r"] = df["_lon"].round(4)

        locations: List[Dict] = []
        for (lat, lon), grp in df.groupby(["_lat_r", "_lon_r"]):
            depth_series = grp["_depth"].dropna()
            loc: Dict[str, Any] = {
                "lat": float(lat),
                "lon": float(lon),
                "count": int(len(grp)),
                "datasets": _unique_list(grp["_dataset_name"]),
                "regions": _unique_list(grp["_region"]),
                "ecosystems": _unique_list(grp["_ecosystem"]),
                "years": sorted(_unique_list(grp["_year"])),
                "depth_buckets": _unique_list(grp["_depth_bucket"]),
                "massive_ids": _unique_list(grp["_massive_id"]),
                "descriptors": _unique_list(grp["_descriptor"]),
                "batches": _unique_list(grp["_batch"]),
                "filenames": _unique_list(grp["_filename"]),
            }
            if not depth_series.empty:
                loc["depth_min"] = float(depth_series.min())
                loc["depth_max"] = float(depth_series.max())
                loc["depth_mean"] = round(float(depth_series.mean()), 1)
            locations.append(loc)

        return locations

    def get_datasets(self) -> List[Dict]:
        # Exclude internal path objects from API responses
        _path_keys = {
            "file_path",
            "ft_path",
            "an_path",
            "ft_with_annotations_path",
            "final_concatenated_table_path",
        }
        return [
            {k: v for k, v in ds.items() if k not in _path_keys}
            for ds in self._datasets.values()
        ]

    def get_stats(self) -> Dict:
        df = self._df.dropna(subset=["_lat", "_lon"]) if not self._df.empty else self._df
        unique_locs = (
            df.groupby([df["_lat"].round(4), df["_lon"].round(4)]).ngroups
            if not df.empty
            else 0
        )
        return {
            "total_samples": int(len(df)),
            "total_locations": int(unique_locs),
            "total_datasets": int(len(self._datasets)),
            "regions": _unique_list(df.get("_region", pd.Series(dtype=str))),
            "years": sorted(_unique_list(df.get("_year", pd.Series(dtype=str)))),
            "ecosystems": _unique_list(df.get("_ecosystem", pd.Series(dtype=str))),
        }

    def get_filter_options(self) -> Dict:
        df = self._df.dropna(subset=["_lat", "_lon"]) if not self._df.empty else self._df
        meta_cols = [
            c for c in df.columns
            if not c.startswith("_") and c.startswith("ATTRIBUTE_")
        ]
        meta_values: Dict[str, List[str]] = {}
        for col in meta_cols:
            vals = sorted(_unique_list(df[col]))
            if 0 < len(vals) <= 200:
                meta_values[col] = vals
        return {
            "regions": sorted(_unique_list(df.get("_region", pd.Series(dtype=str)))),
            "years": sorted(_unique_list(df.get("_year", pd.Series(dtype=str)))),
            "ecosystems": sorted(_unique_list(df.get("_ecosystem", pd.Series(dtype=str)))),
            "depth_buckets": sorted(_unique_list(df.get("_depth_bucket", pd.Series(dtype=str)))),
            "datasets": [
                {"id": d["id"], "name": d["name"]} for d in self._datasets.values()
            ],
            "metadata_categories": sorted(meta_values.keys()),
            "metadata_values": meta_values,
        }

    def _load_final_table(self, dataset_id: str) -> Optional[pd.DataFrame]:
        ds = self._datasets.get(dataset_id)
        if not ds:
            return None
        p = ds.get("final_concatenated_table_path")
        if p is None:
            return None
        path = Path(p)
        if not path.exists():
            return None
        try:
            return pd.read_csv(path, sep="\t", dtype=str)
        except Exception as exc:
            print(f"[DataProcessor] Could not read final table for {dataset_id}: {exc}")
            return None

    def get_final_table_page(self, dataset_id: str, page: int = 1, page_size: int = 25) -> Dict:
        if dataset_id not in self._datasets:
            return {"error": f"Dataset '{dataset_id}' not found"}
        df = self._load_final_table(dataset_id)
        if df is None or df.empty:
            return {"error": "Final concatenated table is not available for this dataset"}

        page = max(1, int(page))
        page_size = min(200, max(10, int(page_size)))
        total_rows = len(df)
        total_pages = max(1, int(np.ceil(total_rows / page_size)))
        page = min(page, total_pages)
        start = (page - 1) * page_size
        end = start + page_size
        page_df = df.iloc[start:end].fillna("").astype(str)
        return {
            "dataset_id": dataset_id,
            "dataset_name": self._datasets[dataset_id]["name"],
            "page": page,
            "page_size": page_size,
            "total_rows": total_rows,
            "total_pages": total_pages,
            "columns": list(page_df.columns),
            "rows": page_df.to_dict(orient="records"),
        }

    def get_final_table_download(self, dataset_id: str) -> Dict[str, Any]:
        if dataset_id not in self._datasets:
            return {"error": f"Dataset '{dataset_id}' not found"}
        df = self._load_final_table(dataset_id)
        if df is None or df.empty:
            return {"error": "Final concatenated table is not available for this dataset"}

        out = io.StringIO()
        df.fillna("").to_csv(out, sep="\t", index=False)
        return {
            "filename": f"{dataset_id}_final_concatenated_table.tsv",
            "mimetype": "text/tab-separated-values; charset=utf-8",
            "content": out.getvalue().encode("utf-8"),
        }

    def get_metabolite_points(self, filters: Optional[Dict] = None) -> List[Dict[str, Any]]:
        """Return metabolite-level map points using saved final concatenated tables."""
        filters = filters or {}
        dataset_filter = filters.get("dataset_id")
        color_by = filters.get("color_by") or "ATTRIBUTE_ecosystem"
        metadata_key = filters.get("metadata_key")
        metadata_value = filters.get("metadata_value")

        dataset_ids = [dataset_filter] if dataset_filter else list(self._datasets.keys())
        points: List[Dict[str, Any]] = []

        def _first_existing(cols: List[str], candidates: List[str]) -> Optional[str]:
            for c in candidates:
                if c in cols:
                    return c
            return None

        for ds_id in dataset_ids:
            if ds_id not in self._datasets:
                continue
            final_df = self._load_final_table(ds_id)
            if final_df is None or final_df.empty:
                continue

            cols = list(final_df.columns)
            lat_col = _first_existing(cols, ["ATTRIBUTE_Latitude", "Latitude", "latitude", "lat"])
            lon_col = _first_existing(cols, ["ATTRIBUTE_Longitude", "Longitude", "longitude", "lon", "long"])
            if not lat_col or not lon_col:
                continue

            fn_col = _first_existing(cols, ["filename", "Filename", "file_name"])
            region_col = _first_existing(cols, ["ATTRIBUTE_region", "Region", "region"])
            year_col = _first_existing(cols, ["ATTRIBUTE_Year", "Year", "year"])
            eco_col = _first_existing(cols, ["ATTRIBUTE_ecosystem", "Ecosystem", "ecosystem"])
            depth_col = _first_existing(cols, ["ATTRIBUTE_Depth_bucket", "Depth_bucket", "depth_bucket"])

            working = final_df.copy()
            if region_col and filters.get("region"):
                working = working[working[region_col].astype(str) == str(filters["region"])]
            if year_col and filters.get("year"):
                working = working[working[year_col].astype(str) == str(filters["year"])]
            if eco_col and filters.get("ecosystem"):
                working = working[working[eco_col].astype(str) == str(filters["ecosystem"])]
            if depth_col and filters.get("depth_bucket"):
                working = working[working[depth_col].astype(str) == str(filters["depth_bucket"])]
            if metadata_key and metadata_value and metadata_key in working.columns:
                working = working[working[metadata_key].astype(str) == str(metadata_value)]

            if working.empty:
                continue

            meta_cols = [c for c in cols if c == fn_col or c.startswith("ATTRIBUTE_")]
            metabolite_cols = [c for c in cols if c not in meta_cols]
            if not metabolite_cols:
                continue

            long_df = working[[lat_col, lon_col] + meta_cols + metabolite_cols].melt(
                id_vars=[lat_col, lon_col] + meta_cols,
                value_vars=metabolite_cols,
                var_name="metabolite_name",
                value_name="intensity",
            )
            long_df["intensity"] = pd.to_numeric(long_df["intensity"], errors="coerce")
            long_df = long_df.dropna(subset=["intensity"])
            long_df = long_df[long_df["intensity"] > 0]
            if long_df.empty:
                continue

            long_df["lat"] = pd.to_numeric(long_df[lat_col], errors="coerce")
            long_df["lon"] = pd.to_numeric(long_df[lon_col], errors="coerce")
            long_df = long_df.dropna(subset=["lat", "lon"])
            if long_df.empty:
                continue

            for _, row in long_df.iterrows():
                color_value = row.get(color_by)
                if color_value is None and color_by not in long_df.columns:
                    if color_by.lower() == "region" and region_col:
                        color_value = row.get(region_col)
                    elif color_by.lower() == "year" and year_col:
                        color_value = row.get(year_col)
                    elif color_by.lower() == "ecosystem" and eco_col:
                        color_value = row.get(eco_col)

                points.append({
                    "dataset_id": ds_id,
                    "dataset_name": self._datasets[ds_id].get("name", ds_id),
                    "sample_name": str(row.get(fn_col, "")) if fn_col else "",
                    "metabolite_name": str(row["metabolite_name"]),
                    "intensity": float(row["intensity"]),
                    "lat": float(row["lat"]),
                    "lon": float(row["lon"]),
                    "color_value": "" if pd.isna(color_value) else str(color_value),
                    "region": "" if not region_col or pd.isna(row.get(region_col)) else str(row.get(region_col)),
                    "ecosystem": "" if not eco_col or pd.isna(row.get(eco_col)) else str(row.get(eco_col)),
                    "year": "" if not year_col or pd.isna(row.get(year_col)) else str(row.get(year_col)),
                    "depth_bucket": "" if not depth_col or pd.isna(row.get(depth_col)) else str(row.get(depth_col)),
                })

        return points

    def find_dataset_by_task_id(self, task_id: str) -> Optional[Dict]:
        """Return the dataset dict if *task_id* is already loaded, else None."""
        for ds in self._datasets.values():
            if ds.get("task_id") == task_id:
                return ds
        return None

    def rename_dataset(self, dataset_id: str, new_name: str) -> Dict:
        if dataset_id not in self._datasets:
            return {"error": f"Dataset '{dataset_id}' not found"}
        self._datasets[dataset_id]["name"] = new_name
        return {"status": "ok", "dataset_id": dataset_id, "name": new_name}

    def remove_dataset(self, dataset_id: str) -> Dict:
        if dataset_id not in self._datasets:
            return {"error": f"Dataset '{dataset_id}' not found"}
        ds = self._datasets[dataset_id]
        files_to_remove = {
            ds.get("file_path"),
            ds.get("final_concatenated_table_path"),
            ds.get("ft_with_annotations_path"),
            ds.get("ft_path"),
            ds.get("an_path"),
        }
        self._df = self._df[self._df["_dataset_id"] != dataset_id]
        del self._datasets[dataset_id]
        for file_path in files_to_remove:
            if not file_path:
                continue
            try:
                path_obj = Path(file_path)
                path_obj.unlink(missing_ok=True)
                print(f"[DataProcessor] Deleted file {path_obj}")
            except OSError as exc:
                print(f"[DataProcessor] Warning: could not delete {file_path}: {exc}")
        return {"status": "ok", "dataset_id": dataset_id}


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _unique_list(series: pd.Series) -> List[str]:
    return [str(v) for v in series.dropna().unique().tolist() if str(v) not in ("nan", "")]


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(1, 1000):
        candidate = path.parent / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
    return path


def _safe_dataset_filename(value: str, fallback: str = "dataset") -> str:
    """Convert a user/task label into a filesystem-safe stem."""
    text = (value or "").strip()
    if not text:
        text = fallback
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._-")
    return text or fallback
