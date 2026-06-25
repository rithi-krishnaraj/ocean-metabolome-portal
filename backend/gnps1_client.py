"""
gnps1_client.py
Fetches FBMN metadata from the classic GNPS1 (proteomics2.ucsd.edu) API.
Only the metadata file is retrieved; no feature-table or network data needed.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Dict, Optional

import requests

if TYPE_CHECKING:
    from data_processor import DataProcessor

GNPS1_BASE = "https://proteomics2.ucsd.edu/ProteoSAFe/DownloadResultFile"
REQUEST_TIMEOUT = 30  # seconds

GNPS1_RESULT_BLOCKS = {
    "metadata":      "metadata_merged/",
    "quantification": "quantification_table_reformatted/",
    "annotation":    "DB_result/",
}


class GNPS1Client:
    """Thin client for the classic GNPS1 public download API."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def _fetch_block(self, task_id: str, block_file: str) -> Optional[bytes]:
        """Download a single result-block file from GNPS1."""
        url = f"{GNPS1_BASE}?task={task_id}&file={block_file}&block=main"
        try:
            resp = requests.get(url, timeout=REQUEST_TIMEOUT)
        except requests.RequestException:
            return None
        if resp.status_code != 200 or len(resp.content) == 0:
            return None
        return resp.content

    def fetch_metadata_bytes(self, task_id: str) -> Optional[bytes]:
        """Download the merged metadata TSV. Returns raw bytes or None."""
        raw = self._fetch_block(task_id, GNPS1_RESULT_BLOCKS["metadata"])
        if raw is None:
            return None
        snippet = raw[:512].decode("utf-8", errors="replace")
        if "\t" not in snippet:
            return None
        return raw

    def fetch_quantification_bytes(self, task_id: str) -> Optional[bytes]:
        """Download the reformatted quantification table. Returns raw bytes or None."""
        return self._fetch_block(task_id, GNPS1_RESULT_BLOCKS["quantification"])

    def fetch_annotation_bytes(self, task_id: str) -> Optional[bytes]:
        """Download the DB annotation results. Returns raw bytes or None."""
        raw = self._fetch_block(task_id, GNPS1_RESULT_BLOCKS["annotation"])
        if raw is None:
            return None
        snippet = raw[:512].decode("utf-8", errors="replace")
        if "\t" not in snippet:
            return None
        return raw

    def fetch_and_import(
        self,
        task_id: str,
        processor: "DataProcessor",
        save_dir: Optional[Path] = None,
        custom_name: Optional[str] = None,
    ) -> Dict:
        """
        Fetch the GNPS1 feature table, metadata, and annotation for *task_id*
        and ingest them into *processor*.
        Returns a result dict (contains "error" key on failure).
        """
        # 0. Duplicate check
        existing = processor.find_dataset_by_task_id(task_id)
        if existing:
            return {
                "duplicate": True,
                "dataset_id": existing["id"],
                "name": existing["name"],
                "rows": existing["rows"],
                "task_id": task_id,
            }

        md_raw = self.fetch_metadata_bytes(task_id)
        if md_raw is None:
            return {
                "error": (
                    f"Could not retrieve a metadata file from GNPS1 for task {task_id}. "
                    "Possible causes: the task ID is incorrect, the job is not an FBMN job, "
                    "or the GNPS1 server is unreachable. "
                    "You can also download the metadata file manually and upload it via the form."
                )
            }

        ft_raw = self.fetch_quantification_bytes(task_id)
        an_raw = self.fetch_annotation_bytes(task_id)

        name = custom_name or f"GNPS1 Task {task_id}"
        try:
            result = processor.load_dataset(
                md_bytes=md_raw,
                ft_bytes=ft_raw,
                an_bytes=an_raw,
                name=name,
                task_id=task_id,
                save_dir=save_dir,
                ft_filename=f"gnps1_{task_id}_ft.txt" if ft_raw is not None else None,
                md_filename=f"gnps1_{task_id}_md.txt",
                an_filename=f"gnps1_{task_id}_an.tsv" if an_raw is not None else None,
            )
        except ValueError as exc:
            return {"error": str(exc)}

        result["task_id"] = task_id
        return result
