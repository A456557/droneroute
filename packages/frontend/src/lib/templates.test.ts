import { describe, expect, it } from "vitest";
import { computeFacadeAltitudes, generateFacade } from "./templates";
import { DEFAULT_FACADE_PARAMS } from "./templates";
import type { FacadeParams } from "./templates";

describe("computeFacadeAltitudes", () => {
  it("starts at minAltitude and ends at maxAltitude with ascending values", () => {
    const altitudes = computeFacadeAltitudes(1, 20, 5);
    expect(altitudes[0]).toBe(1);
    expect(altitudes[altitudes.length - 1]).toBe(20);
    expect(altitudes).toEqual([1, 6, 11, 15, 20]);
  });

  it("returns a single altitude when numRows = 1", () => {
    const altitudes = computeFacadeAltitudes(1, 20, 1);
    expect(altitudes).toEqual([1]);
  });

  it("handles inverted min/max safely", () => {
    const altitudes = computeFacadeAltitudes(20, 1, 5);
    expect(altitudes[0]).toBe(1);
    expect(altitudes[altitudes.length - 1]).toBe(20);
    expect(altitudes).toEqual([1, 6, 11, 15, 20]);
  });
});

describe("generateFacade altitude ordering", () => {
  it("generates facade waypoints in vertical order starting at minAltitude", () => {
    const params = {
      ...DEFAULT_FACADE_PARAMS,
      point1: [48, 2] as [number, number],
      point2: [48, 2.001] as [number, number],
      distanceM: 20,
      minAltitude: 1,
      maxAltitude: 20,
      numRows: 5,
      numColumns: 2,
      addPhotos: false,
    };

    const result = generateFacade(params);
    const rowHeights = result.waypoints.reduce<Record<number, number[]>>(
      (acc, wp, index) => {
        const row = Math.floor(index / params.numColumns);
        acc[row] = acc[row] ?? [];
        acc[row].push(wp.height);
        return acc;
      },
      {},
    );

    expect(rowHeights[0]).toEqual([1, 1]);
    expect(rowHeights[4]).toEqual([20, 20]);
    expect(Object.values(rowHeights).map((heights) => heights[0])).toEqual([
      1, 6, 11, 15, 20,
    ]);
  });

  it("supports a single column and still starts at minAltitude", () => {
    const params = {
      ...DEFAULT_FACADE_PARAMS,
      point1: [48, 2] as [number, number],
      point2: [48.001, 2] as [number, number],
      distanceM: 20,
      minAltitude: 1,
      maxAltitude: 20,
      numRows: 5,
      numColumns: 1,
      addPhotos: false,
    };

    const result = generateFacade(params);
    const rowHeights = result.waypoints.reduce<Record<number, number[]>>(
      (acc, wp, index) => {
        const row = index;
        acc[row] = [wp.height];
        return acc;
      },
      {},
    );

    expect(result.waypoints).toHaveLength(5);
    expect(rowHeights[0]).toEqual([1]);
    expect(rowHeights[4]).toEqual([20]);
    expect(Object.values(rowHeights).map((heights) => heights[0])).toEqual([
      1, 6, 11, 15, 20,
    ]);
  });
});

describe("generateFacade parcel constraint", () => {
  // Mur N-S : offset 90° (est). distanceM 20 m → ~0.000273° de longitude.
  const base: FacadeParams = {
    ...DEFAULT_FACADE_PARAMS,
    point1: [48.85, 2.35],
    point2: [48.8501, 2.35],
    distanceM: 20,
    minAltitude: 8,
    maxAltitude: 20,
    numRows: 2,
    numColumns: 3,
    addPhotos: false,
  };

  it("returns a null parcel report without a polygon (unchanged behavior)", () => {
    const result = generateFacade(base);
    expect(result.waypoints).toHaveLength(6);
    expect(result.parcelReport).toBeNull();
  });

  it("ignores a degenerate polygon", () => {
    const result = generateFacade({
      ...base,
      parcelPolygon: [
        [48.85, 2.35],
        [48.8501, 2.35],
      ],
    });
    expect(result.parcelReport).toBeNull();
  });

  it("keeps waypoints when the parcel contains the whole scan", () => {
    const plain = generateFacade(base);
    const withParcel = generateFacade({
      ...base,
      parcelPolygon: [
        [48.8499, 2.349],
        [48.8502, 2.349],
        [48.8502, 2.351],
        [48.8499, 2.351],
      ],
      parcelLabel: "Test section A n°1",
    });
    expect(
      withParcel.waypoints.map((wp) => [wp.latitude, wp.longitude]),
    ).toEqual(plain.waypoints.map((wp) => [wp.latitude, wp.longitude]));
    expect(withParcel.parcelReport).toMatchObject({
      parcelProvided: true,
      parcelLabel: "Test section A n°1",
      totalCount: 6,
      insideCount: 6,
      adjustedCount: 0,
      outsideIndexes: [],
    });
  });

  it("pulls waypoints back inside a narrow parcel", () => {
    // Parcelle de 10 m à l'est du mur : le recul de 20 m sort, le
    // resserrement ramène chaque waypoint dans la parcelle (marge 2 m).
    const result = generateFacade({
      ...base,
      parcelPolygon: [
        [48.8499, 2.3499],
        [48.8502, 2.3499],
        [48.8502, 2.35015],
        [48.8499, 2.35015],
      ],
    });
    const report = result.parcelReport;
    expect(report?.parcelProvided).toBe(true);
    expect(report?.totalCount).toBe(6);
    expect(report?.outsideIndexes).toEqual([]);
    expect(report?.insideCount).toBe(6);
    expect(report?.adjustedCount).toBe(6);
    for (const wp of result.waypoints) {
      // Recul effectif ≤ ~8 m (bord est 2.35015 moins marge 2 m).
      expect(wp.longitude).toBeLessThan(2.3502);
      expect(wp.longitude).toBeGreaterThan(2.35);
    }
  });

  it("flags waypoints that cannot fit even at minimum standoff", () => {
    // Parcelle de 4 m autour du mur : le recul mini (5 m) sort encore.
    const result = generateFacade({
      ...base,
      parcelPolygon: [
        [48.8499, 2.34997],
        [48.8502, 2.34997],
        [48.8502, 2.35003],
        [48.8499, 2.35003],
      ],
    });
    const report = result.parcelReport;
    expect(report?.totalCount).toBe(6);
    expect(report?.outsideIndexes).toHaveLength(6);
    expect(report?.insideCount).toBe(0);
    expect(report?.adjustedCount).toBe(6);
  });
});
