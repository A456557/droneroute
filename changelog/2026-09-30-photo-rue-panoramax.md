## Summary

Street-level photo of the selected building in the RNB panel, from the free
open-data Panoramax services (no key): IGN + OSM France instances merged.

## Changes

- New backend proxy `GET /api/streetlevel/nearby?lat=&lon=&radiusM=&limit=`
  (queries both Panoramax instances in parallel, merges/dedupes/sorts by
  distance, 5 min cache; `[]` when unavailable)
- New **Photo rue (Panoramax)** section in the RNB building panel: closest
  photo large, thumbnails to switch, viewer link, distance + capture date
- Explicit messages when there is nothing to show: zone not covered
  (150 m, neither IGN nor OSM France, with a link to contribute) or service
  unreachable — visual aid only, never mission data
