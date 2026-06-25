"""
Ocean Metabolome Portal – Flask backend
Serves the admin UI, the WebGL frontend static files, and the REST API.
All data aggregation and calculations live in data_processor.py;
this file only handles routing and request/response logic.
"""

import io
import os
import re
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

from data_processor import DataProcessor
from gnps2_client import GNPS2Client
from gnps1_client import GNPS1Client

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path="",
    template_folder="templates",
)

# Limit uploads to 50 MB
# app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # removed – no file size limit

ALLOWED_EXTENSIONS = {"txt", "tsv", "csv"}
TASK_ID_RE = re.compile(r"^[a-f0-9]{32}$", re.IGNORECASE)  # GNPS2 task IDs are MD5 hex

processor = DataProcessor(data_dir=str(DATA_DIR))
gnps2 = GNPS2Client()
gnps1 = GNPS1Client()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------------------------------------------------------------------------
# Frontend routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/admin")
def admin():
    stats = processor.get_stats()
    datasets = processor.get_datasets()
    return render_template("admin.html", stats=stats, datasets=datasets)


# ---------------------------------------------------------------------------
# REST API – read endpoints
# ---------------------------------------------------------------------------

@app.route("/api/locations")
def api_locations():
    """Return aggregated sample locations, optionally filtered."""
    filters = {
        "region": request.args.get("region") or None,
        "year": request.args.get("year") or None,
        "ecosystem": request.args.get("ecosystem") or None,
        "depth_bucket": request.args.get("depth_bucket") or None,
        "dataset_id": request.args.get("dataset_id") or None,
    }
    return jsonify(processor.get_locations(filters))


@app.route("/api/datasets")
def api_datasets():
    return jsonify(processor.get_datasets())


@app.route("/api/stats")
def api_stats():
    return jsonify(processor.get_stats())


@app.route("/api/filters")
def api_filters():
    """Return distinct values for each filterable column."""
    return jsonify(processor.get_filter_options())


@app.route("/api/metabolite-points")
def api_metabolite_points():
    """Return metabolite-level map points from final concatenated tables."""
    filters = {
        "region": request.args.get("region") or None,
        "year": request.args.get("year") or None,
        "ecosystem": request.args.get("ecosystem") or None,
        "depth_bucket": request.args.get("depth_bucket") or None,
        "dataset_id": request.args.get("dataset_id") or None,
        "metadata_key": request.args.get("metadata_key") or None,
        "metadata_value": request.args.get("metadata_value") or None,
        "color_by": request.args.get("color_by") or None,
    }
    return jsonify(processor.get_metabolite_points(filters))


# ---------------------------------------------------------------------------
# REST API – write endpoints
# ---------------------------------------------------------------------------

@app.route("/api/stage/upload", methods=["POST"])
def api_stage_upload():
    """Stage an uploaded dataset (ft + md required, annotation optional) for data-prep before saving."""
    ft_file = request.files.get("ft_file")
    md_file = request.files.get("md_file")
    an_file = request.files.get("an_file")

    if not ft_file or not ft_file.filename:
        return jsonify({"error": "Feature quantification table is required (ft_file)"}), 400
    if not md_file or not md_file.filename:
        return jsonify({"error": "Metadata table is required (md_file)"}), 400
    if not allowed_file(ft_file.filename):
        return jsonify({"error": "Feature table: file type not allowed. Use .txt, .tsv, or .csv"}), 400
    if not allowed_file(md_file.filename):
        return jsonify({"error": "Metadata file: file type not allowed. Use .txt, .tsv, or .csv"}), 400
    if an_file and an_file.filename and not allowed_file(an_file.filename):
        return jsonify({"error": "Annotation file: file type not allowed. Use .txt, .tsv, or .csv"}), 400

    name = (request.form.get("name") or md_file.filename).strip()[:120]
    ft_bytes = ft_file.read()
    md_bytes = md_file.read()
    an_bytes = an_file.read() if (an_file and an_file.filename) else None

    try:
        result = processor.stage_dataset(md_bytes, ft_bytes, an_bytes, name)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 422

    return jsonify(result), 200


@app.route("/api/stage/gnps", methods=["POST"])
def api_stage_gnps():
    """Fetch files from GNPS for a task ID and stage them for data-prep before saving."""
    body = request.get_json(silent=True) or {}
    task_id = (body.get("task_id") or "").strip()
    custom_name = (body.get("name") or "").strip()[:120] or None

    if not task_id:
        return jsonify({"error": "task_id is required"}), 400
    if not TASK_ID_RE.match(task_id):
        return jsonify({"error": "Invalid task_id format (expected 32-char hex string)"}), 400

    # Try GNPS2 first, then GNPS1
    md_raw = gnps2.fetch_metadata_bytes(task_id)
    if md_raw is not None:
        ft_raw = gnps2.fetch_quantification_bytes(task_id)
        an_raw = gnps2.fetch_annotation_bytes(task_id)
        source = "GNPS2"
    else:
        md_raw = gnps1.fetch_metadata_bytes(task_id)
        ft_raw = gnps1.fetch_quantification_bytes(task_id)
        an_raw = gnps1.fetch_annotation_bytes(task_id)
        source = "GNPS1"

    if md_raw is None:
        return jsonify({
            "error": f"Could not retrieve a metadata file for task {task_id} from GNPS. "
                     "Check the task ID or download files manually."
        }), 422
    if ft_raw is None:
        return jsonify({
            "error": f"Feature quantification table not found for task {task_id} in {source}. "
                     "This file is required."
        }), 422

    name = custom_name or task_id
    try:
        result = processor.stage_dataset(md_raw, ft_raw, an_raw, name, task_id=task_id)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 422

    result["source"] = source
    return jsonify(result), 200


@app.route("/api/stage/table-preview")
def api_stage_table_preview():
    """Return one paginated page from a staged table for the admin preview UI."""
    stage_id = (request.args.get("stage_id") or "").strip()
    table = (request.args.get("table") or "").strip()
    page = request.args.get("page", default=1, type=int)
    page_size = request.args.get("page_size", default=10, type=int)

    if not stage_id:
        return jsonify({"error": "stage_id is required"}), 400
    if table not in {"ft", "md", "an", "ft_an"}:
        return jsonify({"error": "table must be one of: ft, md, an, ft_an"}), 400

    result = processor.get_staged_table_page(
        stage_id=stage_id,
        table_name=table,
        page=page,
        page_size=page_size,
    )
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result), 200


@app.route("/api/stage/table-download")
def api_stage_table_download():
    """Download a full staged table from the admin preview UI."""
    stage_id = (request.args.get("stage_id") or "").strip()
    table = (request.args.get("table") or "").strip()

    if not stage_id:
        return jsonify({"error": "stage_id is required"}), 400
    if table not in {"ft", "md", "an", "ft_an"}:
        return jsonify({"error": "table must be one of: ft, md, an, ft_an"}), 400

    result = processor.get_staged_table_download(stage_id=stage_id, table_name=table)
    if "error" in result:
        return jsonify(result), 404

    return send_file(
        io.BytesIO(result["content"]),
        mimetype=result["mimetype"],
        as_attachment=True,
        download_name=result["filename"],
    )


@app.route("/api/commit", methods=["POST"])
def api_commit():
    """Commit a staged dataset with optional blank removal and imputation, then save permanently."""
    body = request.get_json(silent=True) or {}
    stage_id = (body.get("stage_id") or "").strip()
    if not stage_id:
        return jsonify({"error": "stage_id is required"}), 400

    name = (body.get("name") or "").strip()[:120] or None
    blank_attribute = body.get("blank_attribute") or None
    blank_values = body.get("blank_values") or None
    blank_cutoff = float(body.get("blank_cutoff") or 0.3)
    impute = bool(body.get("impute", False))

    if blank_values and not isinstance(blank_values, list):
        blank_values = [blank_values]

    ft_key   = (body.get("ft_key")   or "").strip() or None
    an_key   = (body.get("an_key")   or "").strip() or None
    name_key = (body.get("name_key") or "").strip() or None

    result = processor.commit_staged(
        stage_id=stage_id,
        name=name,
        blank_attribute=blank_attribute,
        blank_values=blank_values or None,
        blank_cutoff=blank_cutoff,
        impute=impute,
        ft_key=ft_key,
        an_key=an_key,
        name_key=name_key,
        save_dir=DATA_DIR,
    )
    if "error" in result:
        return jsonify(result), 422
    return jsonify(result), 201


# ---------------------------------------------------------------------------
# Legacy direct-ingest endpoints (kept for backward compatibility)
# ---------------------------------------------------------------------------

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Legacy: stage + immediately commit a manual upload (no data-prep). Use /api/stage/upload instead."""
    ft_file = request.files.get("ft_file")
    md_file = request.files.get("md_file")
    an_file = request.files.get("an_file")

    if not ft_file or not ft_file.filename:
        return jsonify({"error": "Feature quantification table is required (ft_file)"}), 400
    if not md_file or not md_file.filename:
        return jsonify({"error": "Metadata table is required (md_file)"}), 400
    if not allowed_file(ft_file.filename) or not allowed_file(md_file.filename):
        return jsonify({"error": "File type not allowed. Use .txt, .tsv, or .csv"}), 400

    name = (request.form.get("name") or md_file.filename).strip()[:120]
    ft_bytes = ft_file.read()
    md_bytes = md_file.read()
    an_bytes = an_file.read() if (an_file and an_file.filename) else None

    try:
        staged = processor.stage_dataset(md_bytes, ft_bytes, an_bytes, name)
        result = processor.commit_staged(stage_id=staged["stage_id"], save_dir=DATA_DIR)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 422

    return jsonify(result), 201


@app.route("/api/gnps2/import", methods=["POST"])
def api_gnps2_import():
    """Legacy direct-import: fetch and immediately ingest from GNPS2/GNPS1."""
    body = request.get_json(silent=True) or {}
    task_id = (body.get("task_id") or "").strip()
    custom_name = (body.get("name") or "").strip()[:120] or None

    if not task_id or not TASK_ID_RE.match(task_id):
        return jsonify({"error": "Valid 32-char hex task_id is required"}), 400

    result = gnps2.fetch_and_import(task_id, processor, save_dir=DATA_DIR, custom_name=custom_name)
    if result.get("duplicate"):
        return jsonify(result), 409
    if "error" not in result:
        return jsonify(result), 201

    result = gnps1.fetch_and_import(task_id, processor, save_dir=DATA_DIR, custom_name=custom_name)
    if "error" in result:
        return jsonify(result), 422
    return jsonify(result), 201


@app.route("/api/gnps1/import", methods=["POST"])
def api_gnps1_import():
    """Legacy direct-import: fetch and immediately ingest from GNPS1."""
    body = request.get_json(silent=True) or {}
    task_id = (body.get("task_id") or "").strip()
    custom_name = (body.get("name") or "").strip()[:120] or None

    if not task_id or not TASK_ID_RE.match(task_id):
        return jsonify({"error": "Valid 32-char hex task_id is required"}), 400

    result = gnps1.fetch_and_import(task_id, processor, save_dir=DATA_DIR, custom_name=custom_name)
    if "error" in result:
        return jsonify(result), 422
    return jsonify(result), 201


@app.route("/api/datasets/<dataset_id>", methods=["PATCH"])
def api_rename_dataset(dataset_id: str):
    """Rename a loaded dataset."""
    if not re.match(r"^[a-f0-9]{8}$", dataset_id, re.IGNORECASE):
        return jsonify({"error": "Invalid dataset_id"}), 400
    body = request.get_json(silent=True) or {}
    new_name = (body.get("name") or "").strip()[:120]
    if not new_name:
        return jsonify({"error": "name is required"}), 400
    result = processor.rename_dataset(dataset_id, new_name)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route("/api/datasets/<dataset_id>/final-table-preview")
def api_dataset_final_table_preview(dataset_id: str):
    if not re.match(r"^[a-f0-9]{8}$", dataset_id, re.IGNORECASE):
        return jsonify({"error": "Invalid dataset_id"}), 400
    page = request.args.get("page", default=1, type=int)
    page_size = request.args.get("page_size", default=25, type=int)
    result = processor.get_final_table_page(dataset_id, page=page, page_size=page_size)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result), 200


@app.route("/api/datasets/<dataset_id>/final-table-download")
def api_dataset_final_table_download(dataset_id: str):
    if not re.match(r"^[a-f0-9]{8}$", dataset_id, re.IGNORECASE):
        return jsonify({"error": "Invalid dataset_id"}), 400
    result = processor.get_final_table_download(dataset_id)
    if "error" in result:
        return jsonify(result), 404
    return send_file(
        io.BytesIO(result["content"]),
        mimetype=result["mimetype"],
        as_attachment=True,
        download_name=result["filename"],
    )


@app.route("/api/datasets/<dataset_id>", methods=["DELETE"])
def api_delete_dataset(dataset_id: str):
    """Remove a dataset from the portal (does not delete the file on disk)."""
    # Sanitise: dataset_id is an 8-char hex string
    if not re.match(r"^[a-f0-9]{8}$", dataset_id, re.IGNORECASE):
        return jsonify({"error": "Invalid dataset_id"}), 400

    result = processor.remove_dataset(dataset_id)
    if "error" in result:
        return jsonify(result), 404

    return jsonify(result)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(_):
    return jsonify({"error": "Not found"}), 404


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Ocean Metabolome Portal running at http://localhost:5000")
    print("  Map   →  http://localhost:5000/")
    print("  Admin →  http://localhost:5000/admin")
    app.run(debug=True, host="0.0.0.0", port=5000)
