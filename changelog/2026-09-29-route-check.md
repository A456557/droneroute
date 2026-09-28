## Summary

New Route check section: deterministic pre-export route controls with a versioned report, map-located findings, previewable suggestions, and optional AI explanations.

## Changes

- Deterministic checks (R-01 to R-10) reusing existing rules: waypoint validity, segment continuity, obstacle conflicts (2D/3D), RNB building height, facade coherence, airspace zones, terrain clearance, template params, distance and battery
- Versioned report: any relevant mission change marks the previous report as stale ("À recalculer")
- Findings with map locate, suggestions with preview (no mutation), apply after confirmation with version guard, ignore with trace
- AI explanations only when a provider is configured, validated responses, otherwise "Suggestions IA indisponibles"
- Configurable blocking rules for export (disabled by default, export policy unchanged)
- Shared flight stats helper in lib/geo, reused by App
- MIN_PENCIL_PATH_LENGTH_M centralized in lib/templates
