# Ocean Metabolome Portal

Interactive world map for marine dissolved organic matter (DOM) metabolomics data, powered by GNPS2 Feature-Based Molecular Networking (FBMN).

**Domain:** ocean-metabolome-portal.org

---

## Architecture

```
ocean-metabolome-portal/
├── backend/                  # Python / Flask
│   ├── app.py                # HTTP routes only (thin layer)
│   ├── data_processor.py     # All calculations: parsing, aggregation, filtering
│   ├── gnps2_client.py       # GNPS2 REST API integration
│   ├── requirements.txt
│   ├── data/                 # Uploaded metadata files (auto-created)
│   └── templates/
│       └── admin.html        # HTML admin interface (server-rendered by Flask)
│
└── frontend/                 # Served as static files by Flask
    ├── index.html            # WebGL globe portal (public-facing)
    ├── css/styles.css
    └── js/
        ├── main.js           # Entry point: wires globe + UI + API
        ├── globe.js          # WebGL globe (Three.js – rendering only)
        ├── ui.js             # DOM / UI controller
        └── api.js            # Backend API client (fetch wrappers)
```

**Separation of concerns:**
- `backend/` → all data processing, aggregation, and business logic
- `frontend/` → rendering and interaction only; receives pre-aggregated JSON from the API
- The admin HTML page (`/admin`) is rendered server-side by Flask; the WebGL map (`/`) is a static ES-module app

---

## Setup

### Prerequisites

- Python 3.10+
- pip

### Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### Start the server

```bash
cd backend
python app.py
```

The server starts on **http://localhost:5000**.

| URL | Description |
|-----|-------------|
| `http://localhost:5000/` | Interactive WebGL globe map |
| `http://localhost:5000/admin` | Dataset management (upload / GNPS2 import) |
| `http://localhost:5000/api/*` | REST API (JSON) |

---

## Adding data

### Option A – Upload a metadata file (Admin UI)

1. Open `http://localhost:5000/admin`
2. Choose your `.txt` / `.tsv` file and click **Upload**

### Option B – Import from GNPS2

1. Submit your FBMN workflow on [gnps2.org](https://gnps2.org) and wait for the job to finish
2. Copy the 32-character hex Task ID from the job URL
3. Open `http://localhost:5000/admin`, paste the Task ID, click **Import from GNPS2**

### Option C – Drop files manually

Copy any `.txt` / `.tsv` metadata file into `backend/data/`.  
The portal picks up new files on the next server restart.

---

## Expected file format

Tab-separated values (`.txt` or `.tsv`) with **at minimum**:

| Column | Required | Description |
|--------|----------|-------------|
| `ATTRIBUTE_Latitude` | ✓ | Decimal degrees (e.g. `33.1485688`) |
| `ATTRIBUTE_Longitude` | ✓ | Decimal degrees (e.g. `-117.3329169`) |
| `ATTRIBUTE_region` | — | Geographic region label |
| `ATTRIBUTE_ecosystem` | — | Ecosystem type (Coastal, Open Ocean, …) |
| `ATTRIBUTE_Year` | — | Collection year |
| `ATTRIBUTE_Depth` | — | Depth in metres |
| `ATTRIBUTE_Depth_bucket` | — | Depth range label |
| `ATTRIBUTE_type` | — | `SAMPLE` or `BLANK` (BLANK rows are excluded from the map) |
| `MassIVE ID` | — | MassIVE / GNPS dataset accession |

Multiple files can be loaded simultaneously; the portal merges them.

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/locations` | Aggregated sample locations (GeoJSON-like) |
| `GET` | `/api/locations?region=X&year=2022&ecosystem=Coastal&depth_bucket=…&dataset_id=…` | Filtered locations |
| `GET` | `/api/datasets` | List of loaded datasets |
| `GET` | `/api/stats` | Global counts |
| `GET` | `/api/filters` | Distinct values for each filter dimension |
| `POST` | `/api/upload` | Upload a new metadata file (`multipart/form-data`) |
| `POST` | `/api/gnps2/import` | Import from GNPS2 (`{"task_id": "…"}`) |
| `DELETE` | `/api/datasets/<id>` | Remove a dataset |

---

## Production deployment

1. Set `debug=False` in `app.py`
2. Serve with Gunicorn: `gunicorn -w 4 app:app`
3. Put Nginx or Caddy in front for HTTPS and static-file serving
4. Point the domain `ocean-metabolome-portal.org` to your server
