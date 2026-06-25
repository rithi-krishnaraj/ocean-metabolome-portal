"""
gnps2_client.py
Fetches FBMN metadata files from the GNPS2 public API.
All network I/O is isolated here; no Flask/processor logic.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import TYPE_CHECKING, Dict, Optional

import requests

if TYPE_CHECKING:
    from data_processor import DataProcessor

GNPS2_BASE = "https://gnps2.org"
REQUEST_TIMEOUT = 30  # seconds

# GNPS2 FBMN metadata paths – tried in order until one returns a valid TSV.
# Primary path confirmed from the GNPS2 nextflow workflow output structure.
METADATA_PATHS = [
    "nf_output/metadata/merged_metadata.tsv",   # GNPS2 FBMN / CMN (correct path)
    "metadata_mapping",                          # legacy fallbacks
    "metadata.tsv",
    "metadata.txt",
    "workflow/metadata_mapping",
]

QUANTIFICATION_PATHS = [
    "nf_output/clustering/featuretable_reformatted.csv",
    "nf_output/clustering/featuretable_reformatted_precursorintensity.csv",
    "nf_output/quantification_table_reformatted/",
]

ANNOTATION_PATHS = [
    "nf_output/library/merged_results_with_gnps.tsv",
    "nf_output/library/all_matches.tsv",
]


class GNPS2Client:
    """Thin client for the GNPS2 public REST API."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_task_status(self, task_id: str) -> Dict:
        """Return the raw status JSON for a GNPS2 task."""
        url = f"{GNPS2_BASE}/status?task={task_id}"
        resp = requests.get(url, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        return resp.json()

    def fetch_metadata_bytes(self, task_id: str) -> Optional[bytes]:
        """Try each known path and return the raw file bytes, or None."""
        for rel_path in METADATA_PATHS:
            url = f"{GNPS2_BASE}/resultfile?task={task_id}&file={rel_path}"
            try:
                resp = requests.get(url, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 200 and len(resp.content) > 0:
                    # Sanity check: looks like a TSV (has tab characters)
                    snippet = resp.content[:512].decode("utf-8", errors="replace")
                    if "\t" in snippet:
                        return resp.content
            except requests.RequestException:
                continue
        return None

    def fetch_quantification_bytes(self, task_id: str) -> Optional[bytes]:
        """Try each known quantification table path and return raw bytes, or None."""
        for rel_path in QUANTIFICATION_PATHS:
            url = f"{GNPS2_BASE}/resultfile?task={task_id}&file={rel_path}"
            try:
                resp = requests.get(url, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 200 and len(resp.content) > 50:
                    return resp.content
            except requests.RequestException:
                continue
        return None

    def fetch_annotation_bytes(self, task_id: str) -> Optional[bytes]:
        """Try each known annotation path and return raw bytes, or None."""
        for rel_path in ANNOTATION_PATHS:
            url = f"{GNPS2_BASE}/resultfile?task={task_id}&file={rel_path}"
            try:
                resp = requests.get(url, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 200 and len(resp.content) > 0:
                    snippet = resp.content[:512].decode("utf-8", errors="replace")
                    if "\t" in snippet:
                        return resp.content
            except requests.RequestException:
                continue
        return None

    def fetch_and_import(
        self,
        task_id: str,
        processor: "DataProcessor",
        save_dir: Optional[Path] = None,
        custom_name: Optional[str] = None,
    ) -> Dict:
        """
        Fetch the feature table, metadata, and annotation for *task_id* from GNPS2
        and ingest them into *processor*.  Returns a result dict (may contain "error" key).
        """
        # 0. Duplicate check – don't re-import an already loaded task
        existing = processor.find_dataset_by_task_id(task_id)
        if existing:
            return {
                "duplicate": True,
                "dataset_id": existing["id"],
                "name": existing["name"],
                "rows": existing["rows"],
                "task_id": task_id,
            }
        # 1. Check task exists and is finished (best-effort; don't block on unknown status strings)
        try:
            info = self.get_task_status(task_id)
            status = info.get("status", "UNKNOWN")
            if status.upper() in {"FAILED", "ERROR"}:
                return {
                    "error": (
                        f"Task {task_id} has failed on GNPS2 (status: {status}). "
                        "Please check the GNPS2 job page for details."
                    )
                }
        except requests.RequestException:
            pass

        # 2. Download metadata (required), feature table and annotation (best-effort)
        md_raw = self.fetch_metadata_bytes(task_id)
        if md_raw is None:
            return {
                "error": (
                    f"Could not retrieve a metadata file for task {task_id}. "
                    "The task may not have a standard metadata mapping file, or "
                    "the file format is not tab-separated. "
                    "Please download the metadata file manually and upload it via the form."
                )
            }

        ft_raw = self.fetch_quantification_bytes(task_id)
        an_raw = self.fetch_annotation_bytes(task_id)

        # 3. Ingest
        name = custom_name or f"GNPS2 Task {task_id}"
        try:
            result = processor.load_dataset(
                md_bytes=md_raw,
                ft_bytes=ft_raw,
                an_bytes=an_raw,
                name=name,
                task_id=task_id,
                save_dir=save_dir,
                ft_filename=f"gnps2_{task_id}_ft.csv" if ft_raw is not None else None,
                md_filename=f"gnps2_{task_id}_md.txt",
                an_filename=f"gnps2_{task_id}_an.tsv" if an_raw is not None else None,
            )
        except ValueError as exc:
            return {"error": str(exc)}

        result["task_id"] = task_id
        return result
