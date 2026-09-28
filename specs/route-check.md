# Route check

Check the current route before exporting it, without changing the mission.

## What you can do

- **Run a route check** once the route has at least 2 waypoints. Below that,
  the button stays disabled and tells you why.
- **Read the findings**: each one names the waypoint, segment, or area
  involved and offers a "Voir sur la carte" button to fly to it.
- **Preview a suggestion** without changing anything, then **apply** it
  (after confirmation), **ignore** it, or edit manually.
- **Re-run the check** at any time. If the route changed since the last
  report, the old report is marked stale ("À recalculer") and never
  presented as current.
- **Read AI explanations** when an AI provider is configured. Without one,
  the deterministic report still works and says "Suggestions IA
  indisponibles".

## How it works

### Checks performed

- Waypoint validity (coordinates, altitude 1 to 500 m, speed, camera target).
- Segment continuity (duplicate back-to-back points can be removed).
- Known obstacle conflicts, in 2D and in 3D when obstacle heights are set.
  Flying above a known obstacle top is reported as clear.
- RNB building height: when unknown, the report says so and never concludes
  that flying over is possible.
- Facade scan consistency (reference building, selected wall, valid
  parameters). Fine spacing thresholds are not configured, so that part
  stays unverified.
- Airspace zones (when the airspace layer is enabled): prohibited zones
  raise errors, restricted zones raise warnings. No altitude filtering
  (incompatible references) and no provider update date is available.
- Terrain clearance from the IGN MNT: a route below the ground is an error.
  Small clearances are reported without judgement (no threshold configured).
- Template parameters (orbit, grid, facade, pencil minimum length).
- Distance and battery: estimated duration against the configured battery.
  Without a battery value, autonomy stays unverified.

### Global result

- **Bloqué**: a blocking rule failed (obstacle conflict, prohibited zone,
  or terrain collision — each can be toggled; export blocking itself is off
  by default).
- **À vérifier**: warnings or important unverified items remain.
- **Aucune anomalie détectée dans les données contrôlées**: everything
  checkable is fine.
- An outdated report is always labelled **À recalculer**.

## Good to know

- The analysis never authorizes a flight. It prepares the route; you stay
  the only decision-maker.
- AI suggestions are explanations only: they never modify the mission and
  a single AI suggestion never blocks export.
- AI explanations receive the deterministic findings, a route-check analyst
  skill, and a reduced map snapshot: the model explicitly describes what it
  sees, flags potential visual inconsistencies as uncertain, and localizes
  each action (target, justification, data used). A 2D capture never proves
  3D clearance. Without vision support, the analysis falls back to text
  only and reports that the image was not analyzed.
- Export behavior is unchanged unless you enable "Bloquer l'export en cas
  d'échec bloquant".
- R-11 checks that a facade scan stays inside the building's cadastral
  parcel (2 m edge margin): waypoints outside are a warning (possible
  neighboring-parcel overflight), never blocking. The parcel is resolved
  automatically at check time (mission centroid) when the facade context
  has none, so the finding — and the AI explanation, which must call out
  every overstep explicitly — always covers the parcel check.
