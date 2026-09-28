## Summary

Facade scan flight plans are now kept inside the building's cadastral parcel limits, with a route-check rule (R-11) reporting leftovers.

## Changes

- Site summary exposes the parcel polygon (outer ring, APICarto cadastre,
  capped at 256 points); the AI snapshot still receives names only
- generateFacade pulls back any waypoint outside the parcel (2 m edge
  margin) toward the wall, never below a 5 m minimum standoff, and
  recomputes the gimbal on the effective standoff; per-segment parcel
  report (inside/adjusted/outside)
- Building scan preview and apply use the selected building's parcel;
  toasts report pulled-back counts and warn on remaining outsiders
- R-11 (warning, never blocking): waypoints outside the parcel listed by
  number as possible neighboring-parcel overflight
