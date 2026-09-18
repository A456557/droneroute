# DroneRoute - Application Specification

## Overview

DroneRoute is a full-stack web application for visually creating DJI drone waypoint missions
on an interactive map, exporting them as WPML-compliant KMZ files, and managing saved
missions. It supports Points of Interest (POIs) that waypoints can orient toward, obstacle
polygons with conflict warnings, mission templates (orbit, grid, facade, pencil), mission
sharing via public links, airspace restriction overlays, French building-data workflows
(RNB / BD TOPO / BDNB), an AI mission assistant, and direct KMZ upload to DJI RC
controllers over USB.

The map stack is 100% open-source and keyless: MapLibre GL renders OpenFreeMap vector
tiles (streets + building footprints), Esri World Imagery (satellite), and AWS Terrarium
terrain (3D relief). Address search uses the French BAN geocoder. No Google Maps API key
is required.

## Architecture

```
droneroute/
├── packages/
│   ├── shared/     # TypeScript types shared between frontend & backend
│   ├── backend/    # Express API server (KMZ gen, persistence, auth, AI, buildings)
│   ├── frontend/   # React SPA (map, waypoint editor, mission config)
│   └── cli/        # `droneroute` CLI: upload KMZ to DJI RC controllers via USB (adb)
├── e2e/            # Playwright functional tests (Chromium)
├── Dockerfile      # Multi-stage build for self-hosting
├── docker-compose.yml
├── playwright.config.ts
└── SPEC.md         # This file
```

**Monorepo** managed with npm workspaces. Single `npm install` at root.

## Tech Stack

| Layer      | Technology                                                             |
| ---------- | ---------------------------------------------------------------------- |
| Frontend   | React 19, TypeScript, Vite 8                                           |
| Map        | MapLibre GL 2 + react-map-gl 8, OpenFreeMap vector tiles, Esri imagery |
| Search     | BAN (Base Adresse Nationale) geocoder, no key                          |
| UI         | shadcn/ui + Tailwind CSS v4, lucide-react, sonner                      |
| State      | Zustand 5                                                              |
| Backend    | Node.js 22, Express 5, TypeScript, tsx (dev)                           |
| KMZ Gen    | archiver (ZIP) + XML string templates                                  |
| KMZ Parse  | jszip + fast-xml-parser                                                |
| Database   | SQLite via better-sqlite3                                              |
| Auth       | bcryptjs + jsonwebtoken (JWT); Google OAuth login in cloud mode        |
| AI         | Server-side provider: GitHub Models or any OpenAI-compatible endpoint  |
| CLI        | commander + @inquirer/prompts + chalk, adb for USB upload              |
| E2E tests  | Playwright + Chromium (`npm run test:e2e`)                             |
| Unit tests | Vitest (`supertest` for API routes)                                    |
| Deployment | Docker (multi-stage, Alpine, volume for data), Traefik reverse proxy   |

## DJI WPML KMZ Format

A KMZ is a ZIP archive containing:

```
mission.kmz
├── template.kml      # User-editable mission parameters
├── waylines.wpml     # Executable flight instructions
└── res/              # Resources (reference images, etc.)
```

Both files use KML extended with DJI WPML namespace:

- KML: `http://www.opengis.net/kml/2.2`
- WPML: `http://www.dji.com/wpmz/1.0.2`

### Supported Drones

| Model             | droneEnumValue | Payloads                         |
| ----------------- | -------------- | -------------------------------- |
| DJI M300 RTK      | 60             | H20, H20T, H20N, PSDK            |
| DJI M30           | 67 (sub 0)     | M30 Camera                       |
| DJI M30T          | 67 (sub 1)     | M30T Camera                      |
| DJI Mavic 3E      | 77 (sub 0)     | M3E Camera                       |
| DJI Mavic 3T      | 77 (sub 1)     | M3T Camera                       |
| DJI Mavic 3M      | 77 (sub 2)     | M3M Camera                       |
| DJI M350 RTK      | 89             | H20, H20T, H20N, H30, H30T, PSDK |
| DJI Mavic 3D      | 91 (sub 0)     | M3D Camera                       |
| DJI Mavic 3TD     | 91 (sub 1)     | M3TD Camera                      |
| DJI Mini 4 Pro \* | 100            | Mini 4 Pro Camera                |

\* Consumer drone; WPML format may not import into DJI Fly.

## Data Model

All shared types live in `packages/shared/src/types.ts`.

### PointOfInterest

```typescript
interface PointOfInterest {
  id: string; // UUID
  name: string; // User-assigned label
  latitude: number;
  longitude: number;
  height: number; // Altitude in meters
}
```

POIs are placed on the map and can be referenced by waypoints via the `towardPOI`
heading mode. When a waypoint uses `towardPOI`, it stores the `poiId` linking to
which POI the drone nose should face during flight toward/at that waypoint.

### Obstacle

```typescript
interface Obstacle {
  id: string; // UUID
  name: string; // User-assigned label
  description: string; // Free-text notes
  vertices: [number, number][]; // Array of [latitude, longitude] pairs
}
```

Obstacles are polygonal areas drawn on the map representing no-fly zones, buildings,
towers, or other hazards. They are persisted with the mission and visible on shared
missions. When the flight path crosses an obstacle polygon, the affected segment is
highlighted in red and a warning count appears in the footer. Obstacles are a
DroneRoute-only planning concept and are **not** exported to the DJI KMZ file.

### Waypoint

```typescript
interface Waypoint {
  index: number; // 0-based, determines flight order
  name: string;
  latitude: number;
  longitude: number;
  height: number; // Meters (per heightMode)
  speed: number; // m/s
  useGlobalSpeed: boolean;
  useGlobalHeight: boolean;
  useGlobalHeadingParam: boolean;
  useGlobalTurnParam: boolean;
  headingMode?: HeadingMode;
  headingAngle?: number; // -180..180 degrees
  poiId?: string; // Reference to POI when headingMode = "towardPOI"
  turnMode?: TurnMode;
  turnDampingDist?: number;
  gimbalPitchAngle: number; // -120..45 degrees (-90 = nadir)
  actions: WaypointAction[];
}
```

Waypoints are **sortable** - users can drag-and-drop to reorder them in the sidebar.
Reordering updates the `index` field and changes the flight path sequence.
Defaults for new waypoints live in `DEFAULT_WAYPOINT` (30 m height, 7 m/s,
-45° gimbal).

### MissionConfig

```typescript
interface MissionConfig {
  droneEnumValue: number;
  droneSubEnumValue: number;
  payloadEnumValue: number;
  flyToWaylineMode: FlyToWaylineMode; // "safely" | "pointToPoint"
  finishAction: FinishAction;
  exitOnRCLost: "goContinue" | "executeLostAction";
  executeRCLostAction: RCLostAction;
  takeOffSecurityHeight: number;
  globalTransitionalSpeed: number; // m/s
  autoFlightSpeed: number; // m/s
  maxBatteryMinutes: number;
  heightMode: HeightMode; // "EGM96" | "relativeToStartPoint" | "aboveGroundLevel"
  globalHeadingMode: HeadingMode;
  globalTurnMode: TurnMode;
  gimbalPitchMode: GimbalPitchMode; // "manual" | "usePointSetting"
}
```

### Mission

```typescript
interface Mission {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  userId?: string;
  config: MissionConfig;
  waypoints: Waypoint[];
  pois: PointOfInterest[];
  obstacles: Obstacle[];
}
```

### SharedMission

Public read-only view of a mission shared via token link (`/shared/:token`).
Same payload as `Mission` plus `shareToken` and optional `ownerEmail`. Recipients
can preview it, clone it into their account (auth required), or export the KMZ.

### UserPreferences

```typescript
interface UserPreferences {
  unitSystem: "metric" | "imperial";
  visualization: {
    viewMode: "2d" | "3d";
    mapStyle: "satellite" | "street";
  };
  missionDefaults: MissionConfig; // Defaults applied to new missions
}
```

Persisted per user (`user_preferences` table) and editable from the account panel.

### MapViewState

```typescript
interface MapViewState {
  latitude: number;
  longitude: number;
  zoom: number;
}
```

`DEFAULT_MAP_VIEW` (Labarthe-sur-Lèze, FR — 43.4524351, 1.4005078, zoom 13) is used
until the backend `/api/config` value (env `DEFAULT_MAP_VIEW`) loads.

### WaypointAction

Actions are executed sequentially when the drone reaches the waypoint.

| Action             | Description                         | Key Parameters                          |
| ------------------ | ----------------------------------- | --------------------------------------- |
| takePhoto          | Capture a photo                     | payloadPositionIndex, fileSuffix        |
| startRecord        | Start video recording               | payloadPositionIndex, fileSuffix        |
| stopRecord         | Stop video recording                | payloadPositionIndex                    |
| gimbalRotate       | Rotate gimbal                       | pitch/yaw/roll angles, rotateMode       |
| gimbalEvenlyRotate | Smooth gimbal tilt to this waypoint | pitch angle, payloadPositionIndex       |
| rotateYaw          | Rotate aircraft heading             | aircraftHeading, pathMode (CW/CCW)      |
| hover              | Hover in place                      | hoverTime (seconds)                     |
| zoom               | Zoom camera                         | focalLength (mm)                        |
| focus              | Focus camera                        | isPointFocus, focusX/Y, isInfiniteFocus |

### Heading Modes

| Mode             | Behavior                                         |
| ---------------- | ------------------------------------------------ |
| followWayline    | Nose follows flight direction                    |
| manually         | User controls heading live                       |
| fixed            | Maintains yaw set at waypoint                    |
| smoothTransition | Custom yaw angle, interpolated between waypoints |
| towardPOI        | Nose faces a specific Point of Interest          |

### Turn Modes

| Mode                                     | Behavior                        |
| ---------------------------------------- | ------------------------------- |
| coordinateTurn                           | Banked turn, no stop            |
| toPointAndStopWithDiscontinuityCurvature | Straight line, stops at WP      |
| toPointAndStopWithContinuityCurvature    | Curve flight, stops at WP       |
| toPointAndPassWithContinuityCurvature    | Curve flight, passes through WP |

## Features

### Map Interaction (MapLibre, no API key)

- **Basemaps** — OpenFreeMap `bright` vector style in Street mode (roads +
  building footprints); Esri World Imagery in Satellite mode
- **2D / 3D views** — 3D pitches the camera and enables AWS Terrarium terrain
  relief plus extruded OpenFreeMap buildings; animated transition both ways
- **Click to add waypoints/POIs/obstacles** — Toolbar modes (`W`/`P`/`B`) plus
  orbit/grid/facade/pencil template drag interactions
- **Drag markers** — Reposition waypoints, POIs, and obstacle vertices by dragging
- **Flight path** — Dashed blue segments (red where the path crosses an obstacle),
  green dashed lines from `towardPOI` waypoints to their POI, red heading ticks,
  camera-frustum footprint for the selected waypoint
- **Address search** — BAN (Base Adresse Nationale) geocoder with result picker
  that flies the map to the match; no key required
- **Airspace overlay** — Restriction zones fetched per viewport from
  country providers (DGAC/France, ENAIRE/Spain, NATS/UK); prohibited zones in
  red, restricted in orange, with hover details
- **RNB buildings layer** — French building footprints (RNB registry) with
  selection, BD TOPO matching, and BDNB enrichment (fault-tolerant: a failing
  upstream table degrades to partial data, never a 502)
- **Building workflows** — Facade-scan and 3D-reconstruction mission generation
  from a selected building, facade copilot recommendations, reconstruction demo
- **Mission templates** — Orbit, grid survey, facade scan, and freehand pencil
  path, all previewed live on the map before applying
- **Keyboard shortcuts** — `W` waypoint, `P` POI, `O`/`G`/`F`/`Z` templates,
  `B` obstacle, `Esc` cancel, `Delete` remove selection

### Sidebar

- **Mission name** - Editable text input
- **Toolbar** - Save, Export KMZ, Import KMZ buttons
- **Waypoints section** (collapsible)
  - Sorted list showing index, altitude, speed, coordinate preview
  - **Drag-and-drop reordering** - Grab handle to change flight order
  - Click to select, X to delete
  - Action count badge
- **POIs section** (collapsible)
  - List of POIs with name, coordinates, height badge
  - Click to select and expand inline editor (name, height, coords)
  - X to delete (clears `poiId` references on waypoints automatically)
- **Obstacles section** (collapsible)
  - List of obstacles with name, vertex count badge
  - Click to select and highlight on map; double-click to rename
  - Inline editor for name, description
  - X to delete
- **Mission Config section** (collapsible)
  - Drone model + payload selector
  - Flight speed, takeoff height
  - Height reference mode
  - Heading mode, turn mode
  - Fly-to mode, finish action, RC-lost action
  - Transitional speed
- **Waypoint Editor section** (auto-expands on selection)
  - Altitude, speed, gimbal pitch
  - Heading mode (with POI selector when `towardPOI`)
  - Turn mode
  - Coordinate display
  - Action editor (add/remove/configure actions)
- **Footer stats bar**
  - Waypoint count, POI count, and obstacle count
  - Obstacle warning count (when flight path crosses obstacles)
  - Estimated total distance (Haversine) and flight time
  - Time is calculated per-segment using each waypoint's speed
    (or global `autoFlightSpeed` when `useGlobalSpeed` is true)

### Missions, Sharing & Admin

- **Save & load** — Authenticated users persist missions to SQLite; "My routes"
  page lists, renames, and deletes them
- **Share links** — `POST /api/missions/:id/share` mints a token link
  (`/shared/:token`); public preview page with stats, in-editor opening, clone
  to account, and direct KMZ export; `DELETE .../share` revokes
- **Back office** (cloud mode, admin only) — List users, ban/unban,
  promote/demote admins
- **Preferences** — Unit system, 2D/3D + street/satellite defaults, and mission
  defaults synced per user
- **Mission assistant** — Server-side AI copilot (`POST /api/assistant/mission`)
  answering planning questions with mission stats; GitHub Models or any
  OpenAI-compatible endpoint, selected via env
- **CLI upload** — `npx droneroute mission.kmz` pushes the KMZ to a USB-connected
  DJI RC controller (adb autodetect)

### Backend API

| Method   | Path                                   | Description                                        |
| -------- | -------------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/health`                          | Health check                                       |
| `GET`    | `/api/config`                          | Public config (self-hosted flag, map view)         |
| `POST`   | `/api/auth/register`                   | Register new user                                  |
| `POST`   | `/api/auth/login`                      | Login, returns JWT                                 |
| `POST`   | `/api/auth/google`                     | Google OAuth login (cloud mode)                    |
| `POST`   | `/api/auth/change-password`            | Change password (self-hosted only)                 |
| `GET`    | `/api/missions`                        | List user's missions (auth)                        |
| `GET`    | `/api/missions/:id`                    | Get single mission                                 |
| `POST`   | `/api/missions`                        | Create mission                                     |
| `PUT`    | `/api/missions/:id`                    | Update mission                                     |
| `DELETE` | `/api/missions/:id`                    | Delete mission (auth, owner)                       |
| `POST`   | `/api/missions/:id/share`              | Enable sharing, returns token + URL                |
| `DELETE` | `/api/missions/:id/share`              | Revoke sharing                                     |
| `GET`    | `/api/shared/:token`                   | Public shared mission                              |
| `POST`   | `/api/shared/:token/clone`             | Clone shared mission (auth)                        |
| `POST`   | `/api/kmz/generate`                    | Generate KMZ from POST body (≥2 WPs)               |
| `GET`    | `/api/kmz/download/:missionId`         | Download KMZ for saved mission                     |
| `POST`   | `/api/kmz/import`                      | Upload KMZ, parse to JSON                          |
| `GET`    | `/api/airspace/zones`                  | Restriction zones for a bounding box               |
| `GET`    | `/api/airspace/providers`              | Available country providers                        |
| `GET`    | `/api/buildings/rnb`                   | RNB buildings for a bounding box                   |
| `POST`   | `/api/buildings/bdtopo-match`          | Match building against BD TOPO                     |
| `POST`   | `/api/buildings/bdnb-enrich`           | BDNB enrichment (partial data on upstream failure) |
| `POST`   | `/api/buildings/detect`                | Detect nearest building footprint                  |
| `POST`   | `/api/buildings/recommend-facade-scan` | Facade-scan copilot recommendation                 |
| `POST`   | `/api/assistant/mission`               | AI mission assistant answer                        |
| `GET`    | `/api/preferences`                     | Get user preferences (auth)                        |
| `PUT`    | `/api/preferences`                     | Save user preferences (auth)                       |
| `GET`    | `/api/admin/users`                     | List users (admin)                                 |
| `POST`   | `/api/admin/users/:id/ban`             | Ban user (admin)                                   |
| `POST`   | `/api/admin/users/:id/unban`           | Unban user (admin)                                 |
| `POST`   | `/api/admin/users/:id/promote`         | Grant admin (admin)                                |
| `POST`   | `/api/admin/users/:id/demote`          | Revoke admin (admin)                               |

Rate limiting applies globally plus stricter limits on auth, KMZ, airspace,
and assistant routes. Uploads are capped at 50 MB.

### KMZ Generation

The backend generates a valid DJI WPML KMZ containing:

1. **template.kml** - Mission config + waypoints with `useGlobal*` flags,
   action groups, and POI heading references
2. **waylines.wpml** - Execution file with explicit per-waypoint speed,
   heading, turn params, and computed POI angles
3. **res/** - Empty resource directory

When a waypoint uses `towardPOI` heading mode, the backend computes the
bearing from the waypoint to the referenced POI and emits it as a
`waypointPoiPoint` element with the POI's coordinates. Geometry is validated
server-side before generation (minimum 2 waypoints).

### KMZ Import

Upload a `.kmz` file to parse it back into editable mission data:

- Extracts `template.kml` from the ZIP
- Parses mission config, waypoints, and actions
- Extracts POIs from `waypointPoiPoint` elements in per-waypoint heading params
- De-duplicates POIs sharing the same coordinates
- Returns JSON with `config`, `waypoints`, and `pois` ready to load into the editor

## Database Schema (SQLite)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,              -- NULL for Google-only accounts
  google_id TEXT,                  -- NULL unless linked
  email_verified INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT,                    -- NULL for anonymous missions
  config TEXT NOT NULL,            -- JSON
  waypoints TEXT NOT NULL,         -- JSON
  pois TEXT NOT NULL DEFAULT '[]', -- JSON
  obstacles TEXT NOT NULL DEFAULT '[]', -- JSON (added by migration)
  share_token TEXT UNIQUE,         -- NULL unless shared
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY,
  preferences TEXT NOT NULL DEFAULT '{}', -- JSON (UserPreferences)
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Self-Hosting with Docker

### Quick Start

```bash
docker compose up -d
```

The app is available at `http://droneroute.localhost` via Traefik reverse proxy (port 80).
The Traefik dashboard is at `http://localhost:8080`.

> **Note:** Traefik v3.6+ is required for compatibility with Docker Engine 29+.
> Earlier Traefik versions (v3.3, v3.4) ship with a Go Docker SDK that starts API
> negotiation at v1.24, which is rejected by Docker Engine 29+ (minimum API v1.44).

### Configuration

| Environment Variable                     | Default                            | Description                            |
| ---------------------------------------- | ---------------------------------- | -------------------------------------- |
| `PORT`                                   | `3001`                             | Server port                            |
| `JWT_SECRET`                             | `change-this-secret-in-production` | JWT signing secret                     |
| `DB_PATH`                                | `/app/data/droneroute.db`          | SQLite database path                   |
| `SELF_HOSTED`                            | `true`                             | Single-account personal instance mode  |
| `CORS_ORIGIN`                            | _(unset)_                          | Allowed origins for split deployments  |
| `ADMIN_EMAIL`                            | _(unset)_                          | Admin user (cloud mode only)           |
| `GOOGLE_CLIENT_ID`                       | _(unset)_                          | Google OAuth login (cloud mode only)   |
| `AI_PROVIDER`                            | _(unset)_                          | `github-models` or `openai-compatible` |
| `GITHUB_MODELS_TOKEN`                    | _(unset)_                          | Token with `models:read` scope         |
| `GITHUB_MODELS_MODEL`                    | _(unset)_                          | e.g. `openai/gpt-4.1`                  |
| `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | _(unset)_                          | OpenAI-compatible endpoint             |
| `DEFAULT_MAP_VIEW`                       | `43.4524351,1.4005078,13`          | `lat,lng[,zoom]` shown on load         |

No map API key is required: tiles (OpenFreeMap, Esri), terrain (AWS Terrarium),
and search (BAN) are all keyless.

### Data Persistence

SQLite database is stored in a Docker volume (`droneroute-data`) mounted at
`/app/data`. This persists across container restarts and rebuilds.

### Build

```bash
docker build -t droneroute .
docker run -d -p 3001:3001 -v droneroute-data:/app/data droneroute
```

## Development

### Prerequisites

- Node.js 22+
- npm 10+

### Setup

```bash
npm install          # Install all workspace deps
npm run build -w packages/shared  # Build shared types (required before backend build)
npm run dev          # Start backend (3001) + frontend (5173) concurrently
```

Frontend proxies `/api` requests to the backend via Vite dev server.

### Building for Production

```bash
npm install
npm run build -w packages/shared    # Shared types first
npm run build -w packages/backend   # Backend TypeScript → dist/
npm run build -w packages/frontend  # Frontend tsc + Vite → dist/
npm run build -w packages/cli      # CLI TypeScript → dist/
```

The shared package compiles TypeScript types to `packages/shared/dist/` so the
backend's compiled JS can import them at runtime without needing `tsx`.

### Testing

```bash
npm run test -w packages/backend   # Vitest unit + API tests (supertest)
npm run test -w packages/frontend  # Vitest unit tests
npm run test:e2e                    # Playwright/Chromium functional tests (e2e/)
```

The e2e suite (`e2e/smoke.spec.ts`) boots against the dev servers and verifies:
OpenFreeMap tiles load with zero Google requests, waypoint placement + valid KMZ
download, basemap/satellite/3D switching, and BAN search.

### Project Structure

```
packages/
  shared/
    src/types.ts                     # All TypeScript types and constants
    tsconfig.json                    # Compiles to dist/ for backend runtime
  backend/src/
    index.ts                       # Express app entry (+ /api/health, /api/config)
    models/db.ts                   # SQLite setup + migrations
    middleware/                    # auth, rateLimit
    lib/wpml.ts                    # WPML XML builders
    lib/config.ts                  # Env config (incl. DEFAULT_MAP_VIEW parsing)
    routes/auth.ts                 # Email + Google OAuth login, password change
    routes/missions.ts             # Mission CRUD
    routes/shared.ts               # Share/unshare/clone/public fetch
    routes/kmz.ts                  # KMZ gen/download/import endpoints
    routes/airspace.ts             # Restriction zones + providers
    routes/assistant.ts            # AI mission copilot endpoint
    routes/buildings.ts            # RNB / BD TOPO / BDNB / detect / facade-scan
    routes/preferences.ts          # Per-user preferences
    routes/admin.ts                # Back-office user management
    services/kmzGenerator.ts       # archiver-based KMZ builder
    services/kmzParser.ts          # jszip + XML parser
    services/authService.ts        # JWT + bcrypt
    services/assistantAi.ts        # AI provider abstraction
    services/missionValidation.ts  # Server-side geometry validation
    services/airspace/             # Country providers (dgac, enaire, nats)
  frontend/src/
    main.tsx                       # Entry point
    App.tsx                        # Root layout (sidebar + map) + shortcuts
    store/                         # Zustand stores (mission, auth, config, preferences, airspace)
    lib/                           # api client, geo, templates, units
    components/
      map/
        MapView.tsx                # MapLibre map container (2D/3D, single engine)
        reactMapOverlays.tsx       # RNB layer, 2D interactions, 3D controller
        AirspaceOverlay.tsx        # Restriction zones + tooltips
        MapToolbar.tsx             # Add/WP/POI/obstacle/template tools
        MapSearch.tsx              # (in MapView) BAN address search
        TemplateConfigPanel.tsx    # Template parameter editors
      waypoint/                    # Sortable list + waypoint/action editors
      mission/                     # Mission config, POI/obstacle lists
      routes/                      # My-routes page + shared-mission page
      auth/                        # Login, register, account, admin UI
  cli/src/
    index.ts                       # `droneroute <mission.kmz>` entry (commander)
    device.ts / adb.ts             # Controller detection over USB
    volumes.ts                     # Mounted-storage fallback detection
    upload.ts                      # KMZ placement into mission slots
    constants.ts                   # WPML/controller paths
  e2e/smoke.spec.ts                # Playwright functional tests
```

### UI Layout

```
+------------------------------------------------------------------+
| [drone] DroneRoute   [Mission Name Input]                           |
| [Save] [Export KMZ] [Import]                                     |
+------------------+-----------------------------------------------+
| v WAYPOINTS (3)  |                                               |
| [=] 1  30m 7m/s  |                                               |
| [=] 2  30m 7m/s  |        Interactive Map                        |
| [=] 3  30m 7m/s  |        (MapLibre + OpenFreeMap, no key)        |
|                  |                                     [Add WP]  |
| v POIS (1)       |        o---1---2---3  (flight path) [Add POI] |
| [*] Tower        |        |             [Obstacle]     [Clear]    |
|                  |        * POI                                   |
| v OBSTACLES (1)  |        /---\  obstacle polygon                 |
| [▲] Building A   |        \---/                                   |
|                  |                                               |
| > MISSION CONFIG |                                               |
|                  |                                               |
| v EDIT WP 2      |                                               |
| Alt: [30] m      |                                               |
| Speed: [7] m/s   |                                               |
| Gimbal: [-45] d  |                                               |
| Heading: towardPOI|                                              |
|   POI: [Tower v] |                                               |
| Actions:         |                                               |
|  * Take Photo  x |                                               |
|  [+ Add Action]  |                                               |
+------------------+-----------------------------------------------+
| 3 waypoints | 1 POI | ~340m / 48s                                    |
+------------------------------------------------------------------+
```
