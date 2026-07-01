# Building Photogrammetry Mission Planning

Generate deterministic drone waypoints for building image capture before flight.

This algorithm is a mission planner, not a reconstruction pipeline. It uses the same building geometry that drives the info bubble metrics, especially polygon segment lengths and building height, to produce camera poses for facade capture, roof capture, and optional oblique coverage.

## Goal

Input:

- A building footprint in a local cartesian system.
- A building height.
- Camera parameters.
- Mission overlap and standoff parameters.

Output:

- An ordered list of waypoints.
- Each waypoint contains drone position and camera orientation for image capture.

## Scope

First version:

- Ordered polygon footprint.
- Each polygon segment is treated as one facade to inspect.
- Constant facade distance.
- Nadir roof grid.
- Optional corner oblique shots.

Second version:

- Concave polygon visibility safeguards.
- Adaptive facade distance per side.
- Smarter roof clipping for complex roofs or setbacks.

## Input types

```ts
type Point2 = {
  x: number;
  y: number;
};

type Building = {
  polygon: Point2[];
  height: number;
};

type Camera = {
  sensorWidthMm: number;
  sensorHeightMm: number;
  focalMm: number;
  imageWidthPx: number;
  imageHeightPx: number;
};

type MissionParams = {
  facadeOverlapX: number;
  facadeOverlapZ: number;
  roofFrontOverlap: number;
  roofSideOverlap: number;
  facadeDistance: number;
  roofClearance: number;
  includeOblique: boolean;
};

type Waypoint = {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  capture: boolean;
  target: {
    x: number;
    y: number;
    z: number;
  };
  kind: "facade" | "roof" | "oblique";
  metadata?: Record<string, number | string | boolean>;
};
```

## Inputs derived from the info bubble

The planner should use the geometry source, not the rendered HTML text, but the values exposed in the info bubble are exactly the values that drive the mission logic:

- Polygon segment lengths: each segment corresponds to one facade strip to capture.
- Building height: defines the number of vertical facade rows.
- Width, length, perimeter, and approximate area: useful for preview, QA, and roof planning summaries.

Important rule:

- No facade is skipped.
- If the polygon has `N` segments, the facade planner produces `N` facade sub-missions.
- Each facade sub-mission is parameterized by that segment length and the common building height.

## Assumptions

- Coordinates are already projected into a local metric coordinate system.
- Polygon vertices are ordered around the footprint.
- The drone can hold position and yaw accurately enough for the requested overlap.
- Altitude reference is local ground level at the building base.
- Camera optical axis is aligned with gimbal pitch and aircraft yaw.
- Lens distortion is either negligible for planning or handled elsewhere.

## Design notes from photogrammetry practice

The planning choices below follow standard photogrammetry capture principles:

- Use overlapping imagery so adjacent photos share enough visual features.
- Combine horizontal facade imagery with nadir roof imagery.
- Add oblique corner shots when stronger tie points are needed at roof-wall transitions.
- Keep camera intrinsics stable during one mission.
- If execution hardware supports RTK or PPK, positional accuracy improves, but that is outside the planner itself.

## Camera geometry

The planner converts camera intrinsics into ground or facade coverage dimensions.

### Horizontal and vertical field of view

$$
fovX = 2 \arctan\left(\frac{sensorWidthMm}{2 \cdot focalMm}\right)
$$

$$
fovY = 2 \arctan\left(\frac{sensorHeightMm}{2 \cdot focalMm}\right)
$$

### Visible width and height at distance d

For a camera looking approximately perpendicular to a facade at distance $d$:

$$
coverageX(d) = 2d \tan\left(\frac{fovX}{2}\right)
$$

$$
coverageZ(d) = 2d \tan\left(\frac{fovY}{2}\right)
$$

For a nadir roof capture at altitude $h$ above the roof plane:

$$
roofCoverageX(h) = 2h \tan\left(\frac{fovX}{2}\right)
$$

$$
roofCoverageY(h) = 2h \tan\left(\frac{fovY}{2}\right)
$$

### Step size from overlap

If overlap is $o$, the waypoint spacing is:

$$
step = coverage \cdot (1 - o)
$$

This is used horizontally and vertically on facades and on both roof grid axes.

## Output orientation convention

- `yawDeg`: aircraft heading in degrees, where the drone faces the target point.
- `pitchDeg`: gimbal pitch in degrees.
- `0` means horizontal.
- `-90` means nadir.
- `rollDeg`: always `0` in this planner.

## High-level strategy

1. Normalize the footprint.
2. Derive facade capture strips from each polygon edge.
3. Derive a nadir roof grid over the footprint bounding box or a rotated rectangle frame.
4. Optionally add corner oblique shots.
5. Order the waypoints to reduce transit distance.

In other words, the footprint segments shown in the info bubble are not just display metrics. They are the facade mission primitives.

## Core reusable helpers

```ts
function distance2D(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function polygonCentroid(points: Point2[]): Point2 {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    cx += (current.x + next.x) * cross;
    cy += (current.y + next.y) * cross;
  }

  const areaFactor = twiceArea || 1;
  return {
    x: cx / (3 * areaFactor),
    y: cy / (3 * areaFactor),
  };
}

function normalize(vx: number, vy: number): { x: number; y: number } {
  const length = Math.hypot(vx, vy) || 1;
  return { x: vx / length, y: vy / length };
}

function yawToTargetDeg(from: Point2, to: Point2): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function pitchToTargetDeg(horizontalDistance: number, dz: number): number {
  return (Math.atan2(dz, horizontalDistance) * 180) / Math.PI;
}
```

## Facade planning

Facade capture is generated edge by edge.

Each edge is one facade.

If the building polygon contains `N` ordered segments, the planner generates `N` facade capture groups. This is the key revision of the planner: facade inspection is not a generic orbit around the building, but a deterministic per-facade scan derived from the segment lengths already exposed to the user.

For each edge:

1. Compute the edge tangent.
2. Compute the outward normal.
3. Offset the camera track by `facadeDistance` along that outward normal.
4. Create a horizontal strip of shots along the offset segment.
5. Repeat vertically across several altitude bands until the facade is covered.

### Using segment lengths and building height

For facade `i`:

- `L_i` is the length of polygon segment `i`.
- `H` is `building.height`.

At facade distance `d`, compute visible image width and height on the facade plane:

$$
coverageX_i = coverageX(d)
$$

$$
coverageZ_i = coverageZ(d)
$$

Then derive the horizontal and vertical step sizes:

$$
stepX_i = coverageX_i \cdot (1 - facadeOverlapX)
$$

$$
stepZ_i = coverageZ_i \cdot (1 - facadeOverlapZ)
$$

The number of horizontal capture columns for facade `i` is:

$$
cols_i = \max\left(1, \left\lceil\frac{\max(0, L_i - coverageX_i)}{stepX_i}\right\rceil + 1\right)
$$

The number of vertical capture rows is:

$$
rows = \max\left(1, \left\lceil\frac{\max(0, H - coverageZ_i)}{stepZ_i}\right\rceil + 1\right)
$$

The number of facade waypoints for that side is:

$$
facadeWaypointCount_i = cols_i \cdot rows
$$

Total facade waypoints over the full building are:

$$
facadeWaypointCountTotal = \sum_{i=1}^{N} facadeWaypointCount_i
$$

This is the direct link between the info bubble dimensions and the generated mission.

### Choosing the outward normal

If the polygon winding is counter-clockwise, the interior lies to the left of each directed edge. The outward normal is therefore the right normal:

$$
outward = (t_y, -t_x)
$$

where $t = (t_x, t_y)$ is the unit tangent from vertex $i$ to vertex $i + 1$.

If polygon winding is clockwise, invert that normal.

### Facade strip spacing

At `facadeDistance = d`:

$$
facadeStepX = coverageX(d) \cdot (1 - facadeOverlapX)
$$

$$
facadeStepZ = coverageZ(d) \cdot (1 - facadeOverlapZ)
$$

### Facade altitude bands

To cover a facade of height `building.height`, place camera heights so the visible vertical windows overlap and cover from near ground to roofline.

Recommended band centers:

$$
z_0 = \frac{coverageZ(d)}{2}
$$

$$
z_n = z_0 + n \cdot facadeStepZ
$$

Continue until the top of the last window exceeds building height.

Clamp the first and last rows so that:

- The lowest frame still sees the lower facade.
- The highest frame reaches slightly above the roofline.

Recommended implementation detail:

- Compute row centers from the formula above.
- Then re-center the row sequence so the first and last image footprints are balanced against the bottom and top of the facade.
- This avoids leaving a thin uncovered strip near the ground or near the roof parapet.

### Facade target point

For a waypoint at horizontal sample `s` on edge `AB` and altitude `z`, point the camera to the corresponding point on the wall plane:

- Target XY is the projection back from the camera to the original edge sample.
- Target Z is clamped into `[0, building.height]`.

This yields:

- `yawDeg` toward the facade sample.
- `pitchDeg` toward the target point.

For standard facade inspection, the default target is the center of the local photo window on that wall. That keeps each image approximately orthogonal to the facade and makes overlap easier to predict.

### Facade pseudocode

```ts
function planFacadeWaypoints(
  building: Building,
  camera: Camera,
  params: MissionParams,
): Waypoint[] {
  const waypoints: Waypoint[] = [];
  const winding = signedPolygonArea(building.polygon) >= 0 ? "ccw" : "cw";
  const fovX = 2 * Math.atan(camera.sensorWidthMm / (2 * camera.focalMm));
  const fovY = 2 * Math.atan(camera.sensorHeightMm / (2 * camera.focalMm));
  const coverageX = 2 * params.facadeDistance * Math.tan(fovX / 2);
  const coverageZ = 2 * params.facadeDistance * Math.tan(fovY / 2);
  const stepX = Math.max(coverageX * (1 - params.facadeOverlapX), 0.5);
  const stepZ = Math.max(coverageZ * (1 - params.facadeOverlapZ), 0.5);

  for (let index = 0; index < building.polygon.length; index += 1) {
    const a = building.polygon[index];
    const b = building.polygon[(index + 1) % building.polygon.length];
    const edgeLength = distance2D(a, b);
    const tangent = normalize(b.x - a.x, b.y - a.y);
    const normal =
      winding === "ccw"
        ? { x: tangent.y, y: -tangent.x }
        : { x: -tangent.y, y: tangent.x };

    const horizontalSamples = sampleCenteredLinearPositions(
      edgeLength,
      coverageX,
      stepX,
    );
    const altitudeSamples = sampleCenteredFacadeAltitudes(
      building.height,
      coverageZ,
      stepZ,
    );

    for (let rowIndex = 0; rowIndex < altitudeSamples.length; rowIndex += 1) {
      const z = altitudeSamples[rowIndex];
      for (
        let columnIndex = 0;
        columnIndex < horizontalSamples.length;
        columnIndex += 1
      ) {
        const s = horizontalSamples[columnIndex];
        const wallPoint = {
          x: a.x + tangent.x * s,
          y: a.y + tangent.y * s,
        };
        const cameraPoint = {
          x: wallPoint.x + normal.x * params.facadeDistance,
          y: wallPoint.y + normal.y * params.facadeDistance,
        };
        const targetZ = z;
        const yawDeg = yawToTargetDeg(cameraPoint, wallPoint);
        const pitchDeg = pitchToTargetDeg(params.facadeDistance, targetZ - z);

        waypoints.push({
          x: cameraPoint.x,
          y: cameraPoint.y,
          z,
          yawDeg,
          pitchDeg,
          rollDeg: 0,
          capture: true,
          target: { x: wallPoint.x, y: wallPoint.y, z: targetZ },
          kind: "facade",
          metadata: {
            edgeIndex: index,
            edgeLength,
            rowIndex,
            columnIndex,
            facadeWaypointCount:
              horizontalSamples.length * altitudeSamples.length,
          },
        });
      }
    }
  }

  return serpentineByEdgeAndAltitude(waypoints);
}
```

### Practical facade note

The default facade inspection mode is intentionally simple and robust:

- one capture matrix per segment,
- constant standoff distance per segment,
- near-orthogonal viewing direction to the wall,
- serpentine traversal inside each facade.

A more advanced variant can tilt the first and last rows slightly to increase bottom-edge and roof-edge robustness, but the base mission should already cover every facade from segment length and height alone.

## Roof planning

Roof coverage is generated as a nadir grid at altitude:

$$
roofAltitude = building.height + roofClearance
$$

### Roof footprint frame

For rectangular buildings:

- Use the principal footprint axes.
- Align grid rows with the longest building axis.

For arbitrary polygons:

- Use the minimum rotated rectangle or principal component frame.
- Generate a regular grid over that frame.
- Keep only camera centers whose vertical projection lies inside the footprint polygon.

### Roof grid spacing

At height `roofClearance` above the roof plane:

$$
roofStepX = roofCoverageX(roofClearance) \cdot (1 - roofSideOverlap)
$$

$$
roofStepY = roofCoverageY(roofClearance) \cdot (1 - roofFrontOverlap)
$$

The names `front` and `side` are kept from flight planning vocabulary. In implementation they simply map to the two roof grid axes.

### Roof pseudocode

```ts
function planRoofWaypoints(
  building: Building,
  camera: Camera,
  params: MissionParams,
): Waypoint[] {
  const roofWaypoints: Waypoint[] = [];
  const fovX = 2 * Math.atan(camera.sensorWidthMm / (2 * camera.focalMm));
  const fovY = 2 * Math.atan(camera.sensorHeightMm / (2 * camera.focalMm));
  const coverageX = 2 * params.roofClearance * Math.tan(fovX / 2);
  const coverageY = 2 * params.roofClearance * Math.tan(fovY / 2);
  const stepX = Math.max(coverageX * (1 - params.roofSideOverlap), 0.5);
  const stepY = Math.max(coverageY * (1 - params.roofFrontOverlap), 0.5);
  const frame = computeRoofPlanningFrame(building.polygon);
  const samples = sampleFrameGrid(frame, stepX, stepY);

  for (const sample of samples) {
    if (!pointInPolygon(sample, building.polygon)) {
      continue;
    }

    roofWaypoints.push({
      x: sample.x,
      y: sample.y,
      z: building.height + params.roofClearance,
      yawDeg: frame.primaryAxisYawDeg,
      pitchDeg: -90,
      rollDeg: 0,
      capture: true,
      target: { x: sample.x, y: sample.y, z: building.height },
      kind: "roof",
    });
  }

  return serpentineGrid(roofWaypoints, frame);
}
```

## Optional oblique and corner shots

Oblique shots improve tie points near roof edges and facade transitions.

Recommended first version:

- One shot per exterior corner.
- Camera positioned outside the corner bisector.
- Altitude around `0.6 * building.height` to `0.8 * building.height`.
- Gimbal pitched toward the upper facade and roof edge, typically between `-20` and `-45` degrees.

### Corner placement

At each corner vertex:

1. Compute the two outward normals of adjacent edges.
2. Sum and normalize them to form an outward bisector.
3. Offset the camera from the corner by `facadeDistance` to `1.5 * facadeDistance`.
4. Aim at a target point near the corner at height `0.75 * building.height`.

### Oblique pseudocode

```ts
function planObliqueWaypoints(
  building: Building,
  params: MissionParams,
): Waypoint[] {
  const waypoints: Waypoint[] = [];
  const winding = signedPolygonArea(building.polygon) >= 0 ? "ccw" : "cw";

  for (let index = 0; index < building.polygon.length; index += 1) {
    const prev =
      building.polygon[
        (index - 1 + building.polygon.length) % building.polygon.length
      ];
    const current = building.polygon[index];
    const next = building.polygon[(index + 1) % building.polygon.length];
    const inA = normalize(current.x - prev.x, current.y - prev.y);
    const inB = normalize(next.x - current.x, next.y - current.y);
    const outwardA =
      winding === "ccw" ? { x: inA.y, y: -inA.x } : { x: -inA.y, y: inA.x };
    const outwardB =
      winding === "ccw" ? { x: inB.y, y: -inB.x } : { x: -inB.y, y: inB.x };
    const bisector = normalize(
      outwardA.x + outwardB.x,
      outwardA.y + outwardB.y,
    );
    const radius = params.facadeDistance * 1.25;
    const cameraPoint = {
      x: current.x + bisector.x * radius,
      y: current.y + bisector.y * radius,
    };
    const target = {
      x: current.x,
      y: current.y,
      z: building.height * 0.75,
    };
    const yawDeg = yawToTargetDeg(cameraPoint, current);
    const horizontalDistance = Math.hypot(
      target.x - cameraPoint.x,
      target.y - cameraPoint.y,
    );
    const pitchDeg = pitchToTargetDeg(
      horizontalDistance,
      target.z - building.height * 0.7,
    );

    waypoints.push({
      x: cameraPoint.x,
      y: cameraPoint.y,
      z: building.height * 0.7,
      yawDeg,
      pitchDeg,
      rollDeg: 0,
      capture: true,
      target,
      kind: "oblique",
      metadata: { cornerIndex: index },
    });
  }

  return waypoints;
}
```

## Complete mission assembly

```ts
function generateBuildingPhotogrammetryMission(
  building: Building,
  camera: Camera,
  params: MissionParams,
): Waypoint[] {
  validateInputs(building, camera, params);

  const facadeWaypoints = planFacadeWaypoints(building, camera, params);
  const roofWaypoints = planRoofWaypoints(building, camera, params);
  const obliqueWaypoints = params.includeOblique
    ? planObliqueWaypoints(building, params)
    : [];

  return optimizeMissionOrder([
    ...facadeWaypoints,
    ...roofWaypoints,
    ...obliqueWaypoints,
  ]);
}
```

## Ordering strategy

Use deterministic ordering so the same input produces the same mission.

Recommended default:

1. Facades first.
2. Roof second.
3. Obliques last.

Inside each group:

- Use serpentine ordering for strip and grid traversal.
- Preserve clockwise or counter-clockwise edge order around the building.
- Reverse every second row inside one facade to reduce deadhead travel.
- Finish one facade before moving to the next facade.

## Rectangle as a validation case

Rectangular buildings remain the easiest case for validation and UI debugging, but they are only a special case of the segment-based facade planner.

Implementation approach:

1. Fit a rotated rectangle from the polygon.
2. Use the two long sides and two short sides as facade edges.
3. Use the rectangle center and orientation as the roof planning frame.
4. Generate four corner obliques if enabled.

Benefits:

- Predictable coverage.
- Simpler waypoint ordering.
- Easy debugging in UI.
- Good QA fixture for the general polygon algorithm.

## Polygon implementation details

For arbitrary polygons, generate facade strips independently per edge.

This is the default planning model for facade inspection.

Each ordered segment in the building footprint is one facade unit:

1. read its length,
2. compute its column count,
3. reuse the building height to compute the row count,
4. emit a local waypoint matrix for that facade,
5. move to the next segment.

Additional safeguards:

- Skip edges shorter than a minimum threshold, for example `2 m`.
- Merge very short adjacent edges when they are almost collinear.
- Reject camera positions that fall inside the footprint.
- For concave polygons, test line of sight from camera point to wall target and drop clearly obstructed shots.

Recommended metadata per waypoint should always retain the `edgeIndex` so the UI can say which facade a photo belongs to.

## Validation rules

Reject or adjust invalid inputs early.

- `polygon.length >= 3`
- `height > 0`
- `facadeDistance > 0`
- `roofClearance > 0`
- overlaps must satisfy `0 <= overlap < 1`
- camera dimensions and focal length must be positive

Useful clamps:

- minimum horizontal and vertical step of `0.5 m`
- minimum facade altitude of `1.5 m` if ground clearance is required
- optional maximum mission point count to avoid pathological outputs

## Recommended metadata on each waypoint

Include enough metadata so the UI can explain why a point exists.

```ts
type WaypointMetadata = {
  sequence: number;
  edgeIndex?: number;
  rowIndex?: number;
  columnIndex?: number;
  cornerIndex?: number;
  stripLengthM?: number;
  source: "building-photogrammetry";
};
```

## Example mission flow

For a polygonal building with `height = 18 m`:

1. Read every polygon segment length from the same geometry used to populate the info bubble.
2. Treat every segment as one facade to inspect.
3. For each facade, compute a horizontal photo count from segment length and facade overlap.
4. Compute a common vertical photo count from building height and vertical overlap.
5. Generate a local waypoint matrix for that facade.
6. Repeat facade by facade until all wall segments are covered.
7. Generate a nadir roof grid at `18 + roofClearance`.
8. Add corner oblique shots if enabled.
9. Order all points serpentine by facade, then by row.

## Why this algorithm is reusable

- It separates camera geometry from footprint geometry.
- It separates facade, roof, and oblique generators.
- It works in any projected local coordinate system.
- It maps naturally from user-visible building metrics to mission waypoints.
- It can later emit DJI waypoints, app-specific mission points, or preview-only camera poses.

## Suggested next implementation step

Implement these pure functions in a geometry-focused module:

- `generateBuildingPhotogrammetryMission`
- `planFacadeWaypoints`
- `planRoofWaypoints`
- `planObliqueWaypoints`
- `computeRoofPlanningFrame`
- `pointInPolygon`
- `optimizeMissionOrder`

That keeps the planner deterministic, testable, and independent from map rendering or flight export.
