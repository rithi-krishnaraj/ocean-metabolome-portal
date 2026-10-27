# Ocean Metabolome Portal

Interactive world map for marine dissolved organic matter (DOM) metabolomics data, powered by GNPS2 Feature-Based Molecular Networking (FBMN).

**Domain:** ocean-metabolome-portal.org

## Admin access

Uploading, saving and deleting datasets require an admin login, checked by the backend. Set the password in `.env` at the repository root:

```
ADMIN_PASSWORD=choose-a-strong-password
```

Docker Compose passes this file to the backend (`env_file`), and a local `uvicorn` run reads it directly. The password is never sent to the browser bundle. To change it, edit `.env` and restart the backend; existing admin logins then stop working.

## Molecular Formulas & Van Krevelen Plots

The Van Krevelen and Carbon Oxidation State plots resolve molecular formulas from the annotation table (`an.parquet`) in this priority order:

1. **`molecular_formula` column** — highest confidence (SIRIUS/ZODIAC or GNPS library match)
2. **InChI** — formula extracted from the InChI string
3. **SMILES** — converted via RDKit (optional: `pip install rdkit`)
4. **MSBuddy** — m/z-only predictions already present in the uploaded annotation table (rows whose `SpectrumID` starts with `MSB_` or whose `Compound_Name` starts with `MSBuddy:`). Lowest confidence; excluded by default, enable via the "Include MSBuddy-predicted formulas" checkbox on either plot.

The carbon oxidation state is the nominal oxidation state of carbon, NOSC = (2·O + 3·N + 2·S − 5·P − H + halogens) / C (LaRowe & Van Cappellen, 2011).

Check per-dataset coverage at `GET /api/datasets/{safe_name}/formula-coverage`.

### Enabling ZODIAC (recommended upstream step)

ZODIAC re-ranks SIRIUS molecular-formula candidates using dataset-wide network relationships, typically improving correct formula identification by 10–20%. It runs **inside SIRIUS on raw MS/MS spectra** — it cannot run in this portal, which stores processed tables only.

To use it:

1. Run **SIRIUS GUI**: compute all compounds together; ZODIAC runs as part of the *Formula Identification* step.
2. Or **SIRIUS CLI**: `sirius --input spectra.mgf --output results formula zodiac fingerprint structure canopus`
3. Export the annotation table (with a `molecular_formula` column) and upload it to the portal (Admin → manual upload, or via a GNPS task that includes SIRIUS results).

