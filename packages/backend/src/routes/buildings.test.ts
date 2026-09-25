import { describe, expect, it, beforeEach } from "vitest";
import {
  bdTopoCacheKey,
  buildBdTopoBbox,
  clearBdTopoCache,
  getBdTopoCache,
  pickBdTopoMatch,
  setBdTopoCache,
} from "./buildings";

const feature = (cleabs: string, rnbIds: string | null) => ({
  properties: { cleabs, identifiants_rnb: rnbIds },
});

describe("buildBdTopoBbox", () => {
  it("uses lat,lng order required by WFS 2.0 + EPSG:4326", () => {
    expect(buildBdTopoBbox(43.4449, 1.3939)).toBe(
      "43.4439,1.3929,43.4459,1.3949,urn:ogc:def:crs:EPSG::4326",
    );
  });
});

describe("pickBdTopoMatch", () => {
  const features = [
    feature("BATIMENT0000000347428629", "XJRVKZB42PRS"),
    feature("BATIMENT0000000347427923", "7WZ7VERSBKW3 AUTRE123"),
  ];

  it("matches exact cleabs first", () => {
    expect(
      pickBdTopoMatch(features, {
        bdTopoId: "BATIMENT0000000347427923",
      })?.properties?.["cleabs"],
    ).toBe("BATIMENT0000000347427923");
  });

  it("matches rnbId inside a multi-value identifiants_rnb", () => {
    expect(
      pickBdTopoMatch(features, { rnbId: "AUTRE123" })?.properties?.["cleabs"],
    ).toBe("BATIMENT0000000347427923");
  });

  it("returns undefined when nothing matches", () => {
    expect(pickBdTopoMatch(features, { rnbId: "UNKNOWN" })).toBeUndefined();
    expect(pickBdTopoMatch(features, {})).toBeUndefined();
    expect(pickBdTopoMatch(undefined, { rnbId: "X" })).toBeUndefined();
  });
});

describe("bdTopoCache", () => {
  beforeEach(() => clearBdTopoCache());

  it("keys cleabs matches by id and rnb matches by rnb", () => {
    expect(bdTopoCacheKey({ bdTopoId: "BAT1", rnbId: "RNB1" })).toBe(
      "cleabs:BAT1",
    );
    expect(bdTopoCacheKey({ rnbId: "RNB1" })).toBe("rnb:RNB1");
  });

  it("hits, expires and evicts oldest", () => {
    const building: any = { cleabs: "BAT1" };
    setBdTopoCache("k1", building, 1000);
    expect(getBdTopoCache("k1", 1000 + 1000)).toEqual(building);
    // Positive TTL is 24 h.
    expect(getBdTopoCache("k1", 1000 + 25 * 3600 * 1000)).toBeUndefined();

    setBdTopoCache("neg", null, 2000);
    expect(getBdTopoCache("neg", 2000 + 1000)).toBeNull();
    // Negative TTL is 10 min.
    expect(getBdTopoCache("neg", 2000 + 11 * 60 * 1000)).toBeUndefined();
  });
});
