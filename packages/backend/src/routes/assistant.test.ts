import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantRoutes } from "./assistant.js";

const app = express();
// Même limite que la prod (index.ts) pour laisser passer les dataURL image.
app.use(express.json({ limit: "50mb" }));
app.use("/api/assistant", assistantRoutes);

describe("POST /api/assistant/mission", () => {
  afterEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.GITHUB_MODELS_TOKEN;
    delete process.env.GITHUB_MODELS_MODEL;
    delete process.env.GITHUB_MODELS_ENDPOINT;
    delete process.env.GITHUB_MODELS_API_VERSION;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_URL;
    delete process.env.AI_MODEL;
    vi.restoreAllMocks();
  });

  it("returns a provider error when no AI backend is configured", async () => {
    const res = await request(app)
      .post("/api/assistant/mission")
      .send({
        prompt:
          "Analyse cette mission de cartographie 3D avec bâtiments et dis-moi si elle tient sur une batterie",
        missionName: "Facade Eiffel",
        templateMode: "grid",
        config: {
          autoFlightSpeed: 5,
          maxBatteryMinutes: 10,
        },
        waypoints: [
          {
            index: 0,
            name: "Waypoint 1",
            latitude: 48.8582,
            longitude: 2.2945,
            height: 10,
            speed: 5,
            useGlobalSpeed: true,
            useGlobalHeight: false,
            useGlobalHeadingParam: true,
            useGlobalTurnParam: true,
            gimbalPitchAngle: -90,
            actions: [],
          },
          {
            index: 1,
            name: "Waypoint 2",
            latitude: 48.8595,
            longitude: 2.2945,
            height: 24,
            speed: 5,
            useGlobalSpeed: true,
            useGlobalHeight: false,
            useGlobalHeadingParam: true,
            useGlobalTurnParam: true,
            gimbalPitchAngle: -90,
            actions: [],
          },
        ],
        pois: [],
        obstacles: [{ id: "obs-1", name: "Zone", vertices: [] }],
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain(
      "Mission assistant AI provider is not configured",
    );
  });

  it("returns an external AI analysis when GitHub Models is configured", async () => {
    process.env.AI_PROVIDER = "github-models";
    process.env.GITHUB_MODELS_TOKEN = "test-token";
    process.env.GITHUB_MODELS_MODEL = "openai/gpt-4.1";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer:
                    'Mission "Facade Eiffel": la mission tient mieux si vous gardez le recouvrement fort et une caméra moins nadir pour les façades.',
                  bullets: [
                    "2 waypoints, 0 POI, 1 obstacle.",
                    "Distance estimée: 145 m. Temps de vol estimé: 29 s.",
                    "Plage d'altitude: 10 m à 24 m. Gimbal moyen: -90°.",
                    "Mission Planner: garder une cross-grid et environ 80% de recouvrement.",
                  ],
                  warnings: [
                    "Cartographie 3D: la caméra semble trop verticale.",
                  ],
                  suggestedActions: [
                    {
                      label: "Prévoir une cross-grid",
                      detail:
                        "Ajoutez un second passage croisé pour mieux reconstruire les façades.",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const res = await request(app)
      .post("/api/assistant/mission")
      .send({
        prompt:
          "Analyse cette mission de cartographie 3D avec bâtiments et dis-moi si elle tient sur une batterie",
        missionName: "Facade Eiffel",
        templateMode: "grid",
        config: {
          autoFlightSpeed: 5,
          maxBatteryMinutes: 10,
        },
        waypoints: [
          {
            index: 0,
            name: "Waypoint 1",
            latitude: 48.8582,
            longitude: 2.2945,
            height: 10,
            speed: 5,
            useGlobalSpeed: true,
            useGlobalHeight: false,
            useGlobalHeadingParam: true,
            useGlobalTurnParam: true,
            gimbalPitchAngle: -90,
            actions: [],
          },
          {
            index: 1,
            name: "Waypoint 2",
            latitude: 48.8595,
            longitude: 2.2945,
            height: 24,
            speed: 5,
            useGlobalSpeed: true,
            useGlobalHeight: false,
            useGlobalHeadingParam: true,
            useGlobalTurnParam: true,
            gimbalPitchAngle: -90,
            actions: [],
          },
        ],
        pois: [],
        obstacles: [{ id: "obs-1", name: "Zone", vertices: [] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("github-models");
    expect(res.body.usedModel).toBe("openai/gpt-4.1");
    expect(res.body.answer).toContain("Facade Eiffel");
    expect(
      res.body.suggestedActions.map(
        (action: { label: string }) => action.label,
      ),
    ).toContain("Prévoir une cross-grid");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, requestInit] = fetchMock.mock.calls[0];
    expect(endpoint).toBe(
      "https://models.github.ai/inference/chat/completions",
    );
    expect(requestInit?.method).toBe("POST");
    expect(JSON.parse(String(requestInit?.body)).model).toBe("openai/gpt-4.1");
  });

  it("rejects an empty prompt", async () => {
    const res = await request(app).post("/api/assistant/mission").send({
      prompt: "",
      waypoints: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("prompt must be a non-empty string");
  });

  it("rejects a non-image mapImage dataURL", async () => {
    const res = await request(app).post("/api/assistant/mission").send({
      prompt: "Contrôle le parcours",
      waypoints: [],
      mapImage: "data:image/gif;base64,R0lGODdhAQABAIAAAP",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "mapImage must be a JPEG/PNG dataURL under 1.5 MB",
    );
  });

  it("rejects an oversized mapImage", async () => {
    const res = await request(app)
      .post("/api/assistant/mission")
      .send({
        prompt: "Contrôle le parcours",
        waypoints: [],
        mapImage: `data:image/jpeg;base64,${"a".repeat(1_500_001)}`,
      });

    expect(res.status).toBe(400);
  });

  it("falls back to local rules with imageAnalyzed false when no provider is configured", async () => {
    const res = await request(app)
      .post("/api/assistant/mission")
      .send({
        prompt: "Contrôle le parcours",
        waypoints: [],
        mapImage: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
        routeCheck: {
          versionHash: "stale-hash",
          findings: [
            {
              id: "R-01",
              severity: "info",
              label: "Trace",
              description: "Trace vide.",
              target: "parcours",
            },
          ],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("local-rules");
    expect(res.body.imageAnalyzed).toBe(false);
  });
});
