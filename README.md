# Ocean Metabolome Portal

Interactive world map for marine dissolved organic matter (DOM) metabolomics data, powered by GNPS2 Feature-Based Molecular Networking (FBMN).

**Domain:** ocean-metabolome-portal.org

## Molecular Formulas & Van Krevelen Plots

The Van Krevelen and Carbon Oxidation State plots resolve molecular formulas from the annotation table (`an.parquet`) in this priority order:

1. **`molecular_formula` column** — highest confidence (SIRIUS/ZODIAC or GNPS library match)
2. **InChI** — formula extracted from the InChI string
3. **SMILES** — converted via RDKit (optional: `pip install rdkit`)
4. **MSBuddy** — m/z-only predictions from the in-portal `/annotate` endpoint (lowest confidence; excluded by default, enable via the "Include MSBuddy-predicted formulas" toggle)

Check per-dataset coverage at `GET /api/datasets/{safe_name}/formula-coverage`.

### Enabling ZODIAC (recommended upstream step)

ZODIAC re-ranks SIRIUS molecular-formula candidates using dataset-wide network relationships, typically improving correct formula identification by 10–20%. It runs **inside SIRIUS on raw MS/MS spectra** — it cannot run in this portal, which stores processed tables only.

To use it:

1. Run **SIRIUS GUI**: compute all compounds together; ZODIAC runs as part of the *Formula Identification* step.
2. Or **SIRIUS CLI**: `sirius --input spectra.mgf --output results formula zodiac fingerprint structure canopus`
3. Export the annotation table (with a `molecular_formula` column) and upload it to the portal (Admin → manual upload, or via a GNPS task that includes SIRIUS results).

