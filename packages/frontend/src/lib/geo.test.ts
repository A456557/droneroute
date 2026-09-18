import { describe, expect, it } from "vitest";
import { buildRnbExtrusionCollection } from "./geo";

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
