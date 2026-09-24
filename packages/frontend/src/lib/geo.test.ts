import { describe, expect, it } from "vitest";
import { buildRnbExtrusionCollection, getObstacleWarnings } from "./geo";

describe("buildRnbExtrusionCollection", () => {
  it("builds closed polygons carrying ids and heights", () => {
    const fc = buildRnbExtrusionCollection([
      {
        rnbId: "A",
        footprint: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
          { lat: 1, lng: 1 },
        ],
        heightM: 24,
      },
    ]);

    expect(fc.features).toHaveLength(1);
    const feature = fc.features[0] as any;
    expect(feature.properties).toEqual({ id: "A", height: 24 });
    const ring = feature.geometry.coordinates[0];
    // [lng, lat] order, explicitly closed.
    expect(ring[0]).toEqual([0, 0]);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it("skips footprints with fewer than 3 vertices", () => {
    const fc = buildRnbExtrusionCollection([
      { rnbId: "B", footprint: [{ lat: 0, lng: 0 }], heightM: 10 },
      { rnbId: "C", footprint: [], heightM: 10 },
    ]);
    expect(fc.features).toHaveLength(0);
  });

  it("returns an empty collection for no buildings", () => {
    expect(buildRnbExtrusionCollection([]).features).toHaveLength(0);
  });
});

describe("getObstacleWarnings with heights", () => {
  const square: [number, number][] = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];
  const obstacle = {
    id: "o1",
    name: "Tower",
    description: "",
    vertices: square,
    minHeightM: 10,
    maxHeightM: 50,
  };

  it("warns when the flight passes through the height band", () => {
    const warnings = getObstacleWarnings(
      [
        { latitude: -1, longitude: 0.5, index: 0, height: 30 },
        { latitude: 2, longitude: 0.5, index: 1, height: 30 },
      ],
      [obstacle],
    );
    expect(warnings.some((w) => w.type === "crosses")).toBe(true);
  });

  it("stays silent when flying above maxHeightM", () => {
    const warnings = getObstacleWarnings(
      [
        { latitude: -1, longitude: 0.5, index: 0, height: 60 },
        { latitude: 2, longitude: 0.5, index: 1, height: 60 },
      ],
      [obstacle],
    );
    expect(warnings).toHaveLength(0);
  });

  it("stays silent when flying below minHeightM", () => {
    const warnings = getObstacleWarnings(
      [
        { latitude: -1, longitude: 0.5, index: 0, height: 5 },
        { latitude: 2, longitude: 0.5, index: 1, height: 5 },
      ],
      [obstacle],
    );
    expect(warnings).toHaveLength(0);
  });

  it("warns for a waypoint inside the polygon within the height band", () => {
    const warnings = getObstacleWarnings(
      [{ latitude: 0.5, longitude: 0.5, index: 0, height: 20 }],
      [obstacle],
    );
    expect(warnings.some((w) => w.type === "inside")).toBe(true);
  });

  it("ignores a waypoint inside the polygon above maxHeightM", () => {
    const warnings = getObstacleWarnings(
      [{ latitude: 0.5, longitude: 0.5, index: 0, height: 80 }],
      [obstacle],
    );
    expect(warnings).toHaveLength(0);
  });
});
