## Summary

Route check AI explanations now carry the deterministic findings, a route-check analyst skill, and an explicit map snapshot analysis when the model supports vision.

## Changes

- Route check AI prompt sends the finding list (severity, label, description, target, rule) plus the waypoint track, and captures a reduced map snapshot (960 px JPEG) for visual analysis
- Backend route-check analyst skill: explain deterministic findings without contradicting them, describe the map view explicitly, propose localized actions with target/justification/dataUsed, list missing data and uncertainties
- Vision plumbing for all providers (OpenAI-compatible image_url, Ollama native images) with automatic text-only retry when the model does not support vision; response reports imageAnalyzed
- mapImage validated server-side (JPEG/PNG dataURL under 1.5 MB, 400 otherwise, never persisted); stale versionHash runs the standard prompt
- Mission assistant panel displays action target, justification, and data used when provided
