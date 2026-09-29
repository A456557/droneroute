import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streetlevelRoutes } from "./streetlevel.js";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/api/streetlevel", streetlevelRoutes);

function panoramaxFeature(id: string, lon: number, lat: number) {
  return {
    id,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      datetime: "2024-10-07T05:52:14+00:00",
      license: "etalab-2.0",
    },
    assets: {
      thumb: { href: `https://panoramax.ign.fr/api/pictures/${id}/thumb.jpg` },
      sd: { href: `https://panoramax.ign.fr/api/pictures/${id}/sd.jpg` },
    },
  };
}

function geojsonResponse(features: unknown[]) {
  return new Response(JSON.stringify({ features }), {
    status: 200,
    headers: { "Content-Type": "application/geo+json" },
  });
}

describe("GET /api/streetlevel/nearby", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges both Panoramax instances sorted by distance with viewer links", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("openstreetmap.fr")) {
        return Promise.resolve(
          geojsonResponse([panoramaxFeature("near-id", 2.3523, 48.8567)]),
        );
      }
      return Promise.resolve(
        geojsonResponse([
          panoramaxFeature("far-id", 2.3522, 48.8576),
          { id: "broken-id" },
        ]),
      );
    });

    const res = await request(app).get(
      "/api/streetlevel/nearby?lat=48.8566&lon=2.3522&radiusM=150&limit=6",
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toContain("Panoramax");
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos[0].id).toBe("near-id");
    expect(res.body.photos[0].source).toBe("Panoramax OSM France");
    expect(res.body.photos[0].viewerUrl).toBe(
      "https://panoramax.openstreetmap.fr/?focus=pic&pic=near-id",
    );
    expect(res.body.photos[0].thumbUrl).toContain("/thumb.jpg");
    expect(res.body.photos[0].distanceM).toBeLessThanOrEqual(150);
    expect(res.body.photos[1].source).toBe("Panoramax IGN");
    expect(res.body.photos[1].viewerUrl).toBe(
      "https://panoramax.ign.fr/?focus=pic&pic=far-id",
    );
  });

  it("returns [] when both instances are unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const res = await request(app).get(
      "/api/streetlevel/nearby?lat=48.85&lon=2.35",
    );
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([]);
  });

  it("still returns photos when a single instance is down", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("openstreetmap.fr")) {
        return Promise.reject(new Error("down"));
      }
      return Promise.resolve(
        geojsonResponse([panoramaxFeature("ign-id", 2.3601, 48.8601)]),
      );
    });
    const res = await request(app).get(
      "/api/streetlevel/nearby?lat=48.86&lon=2.36",
    );
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0].id).toBe("ign-id");
  });

  it("rejects invalid coordinates", async () => {
    const res = await request(app).get("/api/streetlevel/nearby?lat=abc");
    expect(res.status).toBe(400);
  });
});
