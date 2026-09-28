## Summary

Fixes building facade scan altitudes, which started at a hardcoded 8 m with a +8/+12 m roof margin regardless of the building (a 3 m wall was scanned between 8 and 12 m).

## Changes

- New computeBuildingScanAltitudes helper: start near the ground
  (20% of height, 1 to 5 m) up to the roofline plus ~25% margin
  (2 to 8 m), capped at 100 m — e.g. 3 m → 1..5 m, 30 m → 5..38 m
- Building scan presets (standard/dense) use these altitudes
