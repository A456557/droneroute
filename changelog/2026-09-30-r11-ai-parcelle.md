## Summary

The parcel check (R-11) is now resolved automatically at check time and explicitly covered by the AI analysis.

## Changes

- runCheck resolves the cadastral parcel at the mission centroid when
  the facade context has none (loaded facade mission without a selected
  building), so R-11 always runs on real waypoints
- AI prompt carries an explicit parcel instruction whenever R-11 fires,
  and the backend route-check skill requires confirming or calling out
  the R-11 finding (never ignoring it)
- Shared parcel helpers (normalizeParcelPolygon, formatParcelLabel)
