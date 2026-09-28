## Summary

Fixes an intermittent black screen when switching map backgrounds with the cadastre overlay on.

## Changes

- The cadastre raster source used a background-dependent id; react-map-gl
  throws "source id changed" on id change, unmounting the whole map
  (black screen). The id is now stable ("cadastre-pci") and the
  black/white style follows the background via `key` (clean remount)
- Verified with a Playwright probe: background switches, 3D, cadastre
  toggle, zooms and drag keep the canvas alive (0% black frames)
