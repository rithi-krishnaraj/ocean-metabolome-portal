"""
gnps_client.py
Fetches FBMN and CMN tables from GNPS1 and GNPS2.
Adapted from FBMN-STATS-Webapp/src/fileselection.py.
"""
from __future__ import annotations

import urllib.error
from typing import Optional, Tuple

import pandas as pd
from gnpsdata import taskresult, workflow_fbmn

DEFAULT_EXAMPLE_TASK_ID = "b661d12ba88745639664988329c1363e"

# ---- GNPS1 URL templates ---------------------------------------------------

GNPS1_FBMN_URLS = {
    "ft": "https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=quantification_table_reformatted/&block=main",
    "md": "https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=metadata_merged/&block=main",
    "an": "https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile?task={task_id}&file=DB_result/&block=main",
}

TableTuple = Tuple[pd.DataFrame, Optional[pd.DataFrame], Optional[pd.DataFrame]]


def _normalize_metadata(md_raw: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Return metadata indexed by filename when available."""
    if md_raw is None:
        return None
    if "filename" in md_raw.columns:
        return md_raw.set_index("filename")
    return md_raw


def _add_metabolite_index(ft: pd.DataFrame) -> pd.DataFrame:
    """Create a GNPS-style metabolite index from row ID, m/z and RT."""
    try:
        index = ft.apply(
            lambda x: f'{x["row ID"]}_{round(x["row m/z"], 4)}_{round(x["row retention time"], 2)}',
            axis=1,
        )
        ft.index = index
        ft.index.name = "metabolite"
    except Exception:
        pass
    return ft


# ---------------------------------------------------------------------------
# Public loaders
# ---------------------------------------------------------------------------

def load_fbmn(task_id: str) -> TableTuple:
    """Load FBMN tables using GNPS2 first, then GNPS1 fallback.

    This mirrors the FBMN-STATS flow:
    - Use gnpsdata workflow_fbmn/taskresult for GNPS2.
    - Fall back to GNPS1 when GNPS2 feature table is missing/empty or fails.
    """

    if task_id == DEFAULT_EXAMPLE_TASK_ID:
        return _load_gnps1_fbmn(task_id)

    try:
        ft = workflow_fbmn.get_quantification_dataframe(task_id, gnps2=True)
        md_raw = workflow_fbmn.get_metadata_dataframe(task_id, gnps2=True)
        an = taskresult.get_gnps2_task_resultfile_dataframe(
            task_id, "nf_output/library/merged_results_with_gnps.tsv"
        )

        if ft is None or (isinstance(ft, pd.DataFrame) and ft.empty):
            raise ValueError("Empty result from GNPS2")

        if not isinstance(md_raw, pd.DataFrame):
            md_raw = None
        if not isinstance(an, pd.DataFrame):
            an = None

        ft = _add_metabolite_index(ft)
        return ft, _normalize_metadata(md_raw), an
    except (urllib.error.HTTPError, ValueError, AttributeError, KeyError):
        # GNPS2 failed for this task, so we fall back to GNPS1.
        pass
    except Exception:
        # Keep this broad catch to match the stats app behavior.
        pass

    return _load_gnps1_fbmn(task_id)


def _load_gnps1_fbmn(task_id: str) -> TableTuple:
    """Load FBMN tables from GNPS1. Feature table is required."""
    try:
        ft = pd.read_csv(GNPS1_FBMN_URLS["ft"].format(task_id=task_id))
    except Exception as exc:
        raise RuntimeError(
            f"Could not load feature table from GNPS1 for task '{task_id}'. Error: {exc}"
        ) from exc

    md: Optional[pd.DataFrame]
    try:
        md = pd.read_csv(GNPS1_FBMN_URLS["md"].format(task_id=task_id), sep="\t", index_col="filename")
    except Exception:
        md = None

    an: Optional[pd.DataFrame]
    try:
        an = pd.read_csv(GNPS1_FBMN_URLS["an"].format(task_id=task_id), sep="\t")
    except Exception:
        an = None

    ft = _add_metabolite_index(ft)
    return ft, md, an


def load_cmn(task_id: str) -> TableTuple:
    """Load CMN tables from GNPS2 resultfile URLs."""
    ft_url = (
        "https://gnps2.org/resultfile?task="
        f"{task_id}&file=nf_output/clustering/featuretable_reformatted_precursorintensity.csv"
    )
    md_url = f"https://gnps2.org/resultfile?task={task_id}&file=nf_output/metadata/merged_metadata.tsv"
    an_url = f"https://gnps2.org/resultfile?task={task_id}&file=nf_output/library/merged_results_with_gnps.tsv"

    try:
        ft = pd.read_csv(ft_url)
    except Exception as exc:
        raise RuntimeError(f"Could not load CMN feature table for task '{task_id}'. Error: {exc}") from exc

    if ft is None or ft.empty:
        raise RuntimeError(f"Could not load CMN feature table for task '{task_id}'.")

    try:
        md_raw = pd.read_csv(md_url, sep="\t")
    except Exception:
        md_raw = None

    try:
        an = pd.read_csv(an_url, sep="\t")
    except Exception:
        an = None

    ft = _add_metabolite_index(ft)
    return ft, _normalize_metadata(md_raw), an
