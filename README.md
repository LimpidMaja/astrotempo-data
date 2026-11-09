# Astrotempo live data

The live data that [astrotempo.com](https://astrotempo.com/) reads, fetched on a schedule by
[`.github/workflows/data.yml`](.github/workflows/data.yml) and published at
<https://limpidmaja.github.io/astrotempo-data/>:

- `live/*.json`: each file with a `meta` block (source, source URL, licence, credit, time fetched);
  `live/index.json` lists them all.
- `live.tar.gz`: the same files with the NASA photos, for the site's daily build.

| File | Source | Terms | Updated |
| --- | --- | --- | --- |
| `satellites.json` | [CelesTrak GP data](https://celestrak.org/NORAD/documentation/gp-data-formats.php) | CelesTrak usage policy | every 4 hours |
| `smallbodies.json` | [NASA/JPL Small-Body Database Query API](https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html) | US government data | daily |
| `neo-approaches.json` | [NASA/JPL CNEOS Close-Approach Data API](https://ssd-api.jpl.nasa.gov/doc/cad.html) | US government data | daily |
| `spacecraft.json` | [JPL Horizons System](https://ssd.jpl.nasa.gov/horizons/) | US government data | daily |
| `nasa.json`, photos | [NASA news feeds and Photojournal](https://science.nasa.gov/photojournal/) | [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/): credit NASA, no endorsement implied | daily |

How the jobs behave:

- A file is replaced only when the new data passes validation; otherwise the last good file is kept and an issue
  is opened.
- CelesTrak is asked at most once per 4 hours and never retried after a non-200 reply (its usage policy).
- Small-body elements are requested with `full-prec=1`.
- The list of spacecraft comes from <https://astrotempo.com/data/spacecraft-sources.json>, or from
  `spacecraft-sources.json` here when the site cannot be reached.

Run locally: `node scripts/fetch-live.mjs satellites --out=live` (jobs: `smallbodies neo satellites nasa spacecraft`).
