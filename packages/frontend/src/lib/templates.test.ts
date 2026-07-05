import { describe, expect, it } from "vitest";
import { computeFacadeAltitudes, generateFacade } from "./templates";
import { DEFAULT_FACADE_PARAMS } from "./templates";

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
