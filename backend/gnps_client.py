"""
gnps_client.py
Fetches FBMN tables from GNPS2 (with GNPS1 fallback) and Everything Bagel (EB)
tables from GNPS2.
Mirrors FBMN-STATS-Webapp/src/fileselection.py (load_from_gnps_fbmn).

Files are downloaded directly rather than through gnpsdata: GNPS2 rejects
Python's default User-Agent with 403, and gnpsdata hides that error by
returning None, which made every GNPS2 task look like a failed GNPS1 task.
"""
from __future__ import annotations

import posixpath
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Tuple
from urllib.parse import quote

import pandas as pd
import yaml

from data_processor import add_metabolite_index

DEFAULT_EXAMPLE_TASK_ID = "b661d12ba88745639664988329c1363e"

# GNPS servers reject Python's default User-Agent (HTTP 403).
HTTP_HEADERS = {"User-Agent": "ocean-metabolome-portal/2.0 (+https://ocean-metabolome-portal.org)"}
HTTP_TIMEOUT_S = 300

# ---- GNPS2 ------------------------------------------------------------------

GNPS2_SERVERS = ["https://gnps2.org", "https://beta.gnps2.org", "https://de.gnps2.org"]
GNPS2_FBMN_FILES = {
    "ft": ("nf_output/clustering/featuretable_reformated.csv", ","),
    "md": ("nf_output/metadata/merged_metadata.tsv", "\t"),
    "an": ("nf_output/library/merged_results_with_gnps.tsv", "\t"),
}

# Everything Bagel (EB) runs its own feature finding, so its outputs live under
# nf_output/feature_finding/ instead of FBMN's nf_output/clustering/.
GNPS2_EB_QUANT_TABLE_PATHS = [  # MZmine-style feature table with per-sample "Peak area" columns
    "nf_output/feature_finding/feature_finding_results/aligned_features.csv",
]
GNPS2_EB_FEATURE_LIBRARY_PATHS = [  # feature library search results (annotations)
    "nf_output/feature_library_search/merged_feature_library_search_results.tsv",
]
GNPS2_EB_METADATA_PATHS = [  # fallback when no metadata file was uploaded with the task
    "nf_output/metadata/merged_metadata.tsv",
]
# Task parameters holding the uploaded metadata file (FBMN uses metadata_filename, EB uses metadata_file).
# GNPS2 stores the upload in a task input folder named after the parameter.
GNPS2_METADATA_PARAMS = ["metadata_filename", "metadata_file"]
GNPS2_TASK_PARAMS_PATH = "job_parameters.yaml"

# GNPS2 workflow names (the task's "workflowname" parameter) → the portal's workflow keys.
GNPS2_WORKFLOW_KEYS = {
    "feature_based_molecular_networking_workflow": "fbmn",
    "everything_bagel_workflow": "eb",
}

# EB library-search columns renamed to their FBMN equivalents, so annotation
# lookups (feature row ID, compound name, best-match score) work unchanged.
# query_scan is the feature's row ID in aligned_features.csv.
EB_ANNOTATION_COLUMN_MAP = {
    "query_scan": "#Scan#",
    "NAME": "Compound_Name",
    "cosine": "MQScore",
    "matched_peaks": "SharedPeaks",
    "SPECTRUMID": "SpectrumID",
    "ADDUCT": "Adduct",
    "SMILES": "Smiles",
}

# ---- GNPS1 URL templates ---------------------------------------------------

GNPS1_FBMN_URLS = {
    "ft": ("https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=quantification_table_reformatted/&block=main", ","),
    "md": ("https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=metadata_merged/&block=main", "\t"),
    "an": ("https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=DB_result/&block=main", "\t"),
}

TableTuple = Tuple[pd.DataFrame, Optional[pd.DataFrame], Optional[pd.DataFrame]]


def _read_remote_table(url: str, sep: str) -> pd.DataFrame:
    """Download and parse a delimited file.

    The response is streamed straight into pyarrow's multithreaded CSV parser,
    so parsing overlaps the download (≈2× faster than download-then-parse for
    GNPS2's ~170 MB feature tables). Files pyarrow can't parse (ragged rows)
    are re-read with pandas' tolerant C parser.
    """
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
        try:
            return pd.read_csv(response, sep=sep, engine="pyarrow")
        except ValueError:  # pyarrow.ArrowInvalid: malformed rows
            pass
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
        return pd.read_csv(response, sep=sep, on_bad_lines="skip")


def _normalize_metadata(md_raw: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Return metadata indexed by filename when available."""
    if md_raw is None or md_raw.empty:
        return None
    if "filename" in md_raw.columns:
        return md_raw.set_index("filename")
    return md_raw


def _gnps2_url(server: str, task_id: str, path: str) -> str:
    return f"{server}/resultfile?task={task_id}&file={quote(path, safe='')}"


def _read_gnps2_path(task_id: str, path: str, sep: str) -> pd.DataFrame:
    """Download one task file, trying each GNPS2 server in turn."""
    errors = []
    for server in GNPS2_SERVERS:
        try:
            return _read_remote_table(_gnps2_url(server, task_id, path), sep)
        except Exception as exc:
            errors.append(f"{server}: {exc}")
    raise RuntimeError("; ".join(errors))


def _read_gnps2_file(task_id: str, key: str) -> pd.DataFrame:
    """Download one FBMN result file, trying each GNPS2 server in turn."""
    path, sep = GNPS2_FBMN_FILES[key]
    return _read_gnps2_path(task_id, path, sep)


def _read_gnps2_first(task_id: str, paths: list[str], sep: str) -> pd.DataFrame:
    """Download the first of several candidate task files that exists."""
    errors = []
    for path in paths:
        try:
            return _read_gnps2_path(task_id, path, sep)
        except Exception as exc:
            errors.append(f"{path}: {exc}")
    raise RuntimeError("; ".join(errors))


def _read_task_parameters(task_id: str) -> dict:
    """The task's launch parameters (job_parameters.yaml), or {} if unavailable."""
    for server in GNPS2_SERVERS:
        request = urllib.request.Request(_gnps2_url(server, task_id, GNPS2_TASK_PARAMS_PATH), headers=HTTP_HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
                params = yaml.safe_load(response.read())
        except Exception:
            continue
        if isinstance(params, dict):
            return params
    return {}


def detect_workflow(task_id: str) -> Optional[str]:
    """The GNPS2 workflow a task ran (e.g. 'everything_bagel_workflow'), or None if GNPS2 doesn't know it."""
    return _read_task_parameters(task_id).get("workflowname") or None


def _read_gnps2_metadata(task_id: str) -> pd.DataFrame:
    """Metadata uploaded with the task, falling back to the workflow's merged metadata."""
    params = _read_task_parameters(task_id)
    for param in GNPS2_METADATA_PARAMS:
        value = str(params.get(param) or "").strip()
        if not value or value == "NO_FILE":
            continue
        path = f"{param}/{posixpath.basename(value)}"
        sep = "," if path.lower().endswith(".csv") else "\t"
        try:
            return _read_gnps2_path(task_id, path, sep)
        except Exception:
            pass
    return _read_gnps2_first(task_id, GNPS2_EB_METADATA_PATHS, "\t")


def _read_eb_annotations(task_id: str) -> pd.DataFrame:
    an = _read_gnps2_first(task_id, GNPS2_EB_FEATURE_LIBRARY_PATHS, "\t")
    return an.rename(columns={k: v for k, v in EB_ANNOTATION_COLUMN_MAP.items() if v not in an.columns})


def _read_optional(read, *args) -> Optional[pd.DataFrame]:
    """Metadata and library matches are optional: a failed download yields None."""
    try:
        return read(*args)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Public loaders
# ---------------------------------------------------------------------------

def load_fbmn(task_id: str) -> TableTuple:
    """Load FBMN tables from GNPS2, falling back to GNPS1 (as in FBMN-STATS).

    The three tables download in parallel. The feature table is required;
    metadata and library matches are optional. If both GNPS2 and GNPS1 fail,
    the error names each server's failure.
    """
    if task_id == DEFAULT_EXAMPLE_TASK_ID:
        return _load_gnps1_fbmn(task_id)

    with ThreadPoolExecutor(max_workers=3) as pool:
        ft_future = pool.submit(_read_gnps2_file, task_id, "ft")
        md_future = pool.submit(_read_optional, _read_gnps2_file, task_id, "md")
        an_future = pool.submit(_read_optional, _read_gnps2_file, task_id, "an")
        try:
            ft = ft_future.result()
        except Exception as gnps2_exc:
            # GNPS1 task IDs are unknown to GNPS2 and fail there.
            try:
                return _load_gnps1_fbmn(task_id)
            except Exception as gnps1_exc:
                raise RuntimeError(
                    f"Could not load the feature table for task '{task_id}'. "
                    f"GNPS2: {gnps2_exc}. GNPS1: {gnps1_exc}"
                ) from gnps1_exc
        md = md_future.result()
        an = an_future.result()

    if ft.empty:
        raise ValueError(f"GNPS2 returned an empty feature table for task '{task_id}'.")

    return add_metabolite_index(ft), _normalize_metadata(md), an


def load_eb(task_id: str) -> TableTuple:
    """Load Everything Bagel tables from GNPS2 (EB is a GNPS2-only workflow).

    The three tables download in parallel. The feature table is required;
    metadata and library matches are optional.
    """
    with ThreadPoolExecutor(max_workers=3) as pool:
        ft_future = pool.submit(_read_gnps2_first, task_id, GNPS2_EB_QUANT_TABLE_PATHS, ",")
        md_future = pool.submit(_read_optional, _read_gnps2_metadata, task_id)
        an_future = pool.submit(_read_optional, _read_eb_annotations, task_id)
        try:
            ft = ft_future.result()
        except Exception as exc:
            raise RuntimeError(
                f"Could not load the Everything Bagel feature table for task '{task_id}'. {exc}"
            ) from exc
        md = md_future.result()
        an = an_future.result()

    if ft.empty:
        raise ValueError(f"GNPS2 returned an empty feature table for task '{task_id}'.")

    # aligned_features.csv carries many per-feature QC columns; keep only the
    # descriptors needed for the metabolite index plus the per-sample peak areas.
    peak_area_cols = [c for c in ft.columns if str(c).endswith("Peak area")]
    if peak_area_cols:
        index_cols = [c for c in ("row ID", "row m/z", "row retention time") if c in ft.columns]
        ft = ft[index_cols + peak_area_cols]

    return add_metabolite_index(ft), _normalize_metadata(md), an


def _load_gnps1_fbmn(task_id: str) -> TableTuple:
    """Load FBMN tables from GNPS1. Feature table is required."""
    urls = {key: (template.format(task_id=task_id), sep) for key, (template, sep) in GNPS1_FBMN_URLS.items()}
    with ThreadPoolExecutor(max_workers=3) as pool:
        ft_future = pool.submit(_read_remote_table, *urls["ft"])
        md_future = pool.submit(_read_optional, _read_remote_table, *urls["md"])
        an_future = pool.submit(_read_optional, _read_remote_table, *urls["an"])
        ft = ft_future.result()
        md = md_future.result()
        an = an_future.result()

    return add_metabolite_index(ft), _normalize_metadata(md), an
