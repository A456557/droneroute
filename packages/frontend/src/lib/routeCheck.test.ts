import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MissionConfig, Obstacle, Waypoint } from "@droneroute/shared";
import {
  containsBannedClaim,
  hashRouteSnapshot,
  runRouteChecks,
  type RouteCheckInput,
} from "./routeCheck";
import {
  isReportStale,
  setFacadeContextProvider,
  useRouteCheckStore,
} from "@/store/routeCheckStore";
import { useMissionStore } from "@/store/missionStore";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    missionAssistantApi: {
      analyzeMission: vi.fn(),
    },
  };
});

vi.mock("@/lib/terrain", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/terrain")>();
  return {
    ...original,
    terrainApi: {
      profile: vi.fn(),
      drape: (original.terrainApi as any).drape,
    },
  };
});

import { missionAssistantApi } from "@/lib/api";
import { terrainApi } from "@/lib/terrain";

const analyzeMock = missionAssistantApi.analyzeMission as unknown as ReturnType<
  typeof vi.fn
>;
const profileMock = terrainApi.profile as unknown as ReturnType<typeof vi.fn>;

function makeWaypoint(overrides: Partial<Waypoint> = {}): Waypoint {
  return {
    index: 0,
    name: "WP",
    latitude: 43.45,
    longitude: 1.4,
    height: 30,
    speed: 5,
    useGlobalSpeed: false,
    useGlobalHeight: false,
    useGlobalHeadingParam: false,
    useGlobalTurnParam: false,
    gimbalPitchAngle: -45,
    actions: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MissionConfig> = {}): MissionConfig {
  return {
    droneEnumValue: 0,
    droneSubEnumValue: 0,
    payloadEnumValue: 0,
    flyToWaylineMode: "safely" as any,
    finishAction: "goHome" as any,
    exitOnRCLost: "goContinue",
    executeRCLostAction: "hover" as any,
    takeOffSecurityHeight: 20,
    globalTransitionalSpeed: 5,
    autoFlightSpeed: 5,
    maxBatteryMinutes: 25,
    heightMode: "relativeToStartPoint" as any,
    globalHeadingMode: "fixed" as any,
    globalTurnMode: "clockwise" as any,
    gimbalPitchMode: "manual" as any,
    ...overrides,
  };
}

function baseInput(overrides: Partial<RouteCheckInput> = {}): RouteCheckInput {
  return {
    waypoints: [
      makeWaypoint({ index: 0, latitude: 43.45, longitude: 1.4 }),
      makeWaypoint({ index: 1, latitude: 43.451, longitude: 1.401 }),
    ],
    pois: [],
    obstacles: [],
    config: makeConfig(),
    templateMode: null,
    facade: null,
    airspace: { enabled: false, zones: [] },
    terrain: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setFacadeContextProvider(null);
  useRouteCheckStore.setState({
    report: null,
    running: false,
    aiRunning: false,
    previewWaypoints: null,
    previewSuggestionId: null,
    focusRequest: null,
    lastError: null,
  });
  useMissionStore.getState().clearMission();
  profileMock.mockRejectedValue(new Error("MNT injoignable"));
});

describe("version du parcours", () => {
  it("même instantané = même version, modification = version différente", () => {
    const input = baseInput();
    const hash = hashRouteSnapshot(input);
    expect(hashRouteSnapshot(baseInput())).toBe(hash);
    const changed = baseInput({
      waypoints: [
        makeWaypoint({ index: 0, latitude: 43.45, longitude: 1.4 }),
        makeWaypoint({ index: 1, latitude: 43.452, longitude: 1.402 }),
      ],
    });
    expect(hashRouteSnapshot(changed)).not.toBe(hash);
  });

  it("le rapport devient périmé après modification", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    const mission = useMissionStore.getState();
    mission.loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: baseInput().waypoints,
    });
    await useRouteCheckStore.getState().runCheck();
    const report = useRouteCheckStore.getState().report;
    expect(report).not.toBeNull();
    expect(isReportStale(report)).toBe(false);
    mission.loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: [
        ...baseInput().waypoints,
        makeWaypoint({ index: 2, latitude: 43.453, longitude: 1.403 }),
      ],
    });
    expect(isReportStale(useRouteCheckStore.getState().report)).toBe(true);
  });
});

describe("obstacles connus", () => {
  it("produit un constat localisé sur le waypoint en conflit", () => {
    const obstacle: Obstacle = {
      id: "o1",
      name: "Tour",
      description: "",
      vertices: [
        [43.449, 1.399],
        [43.449, 1.403],
        [43.453, 1.403],
        [43.453, 1.399],
      ],
      minHeightM: 0,
      maxHeightM: 50,
    };
    const { findings } = runRouteChecks(baseInput({ obstacles: [obstacle] }));
    const conflict = findings.find(
      (f) => f.checkId === "R-04" && f.severity === "error",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.target.kind).toBe("waypoint");
    if (conflict?.target.kind === "waypoint") {
      expect(conflict.target.index).toBe(0);
    }
  });
});

describe("parcelle cadastrale du scan façade (R-11)", () => {
  const facadeBase = {
    active: true,
    templateMode: "facade",
    buildingRnbId: "RNB123",
    buildingHeightM: 20,
    heightSource: "BD TOPO",
    segmentId: "segment-0",
    segmentLengthM: 20,
    distanceM: 15,
    numRows: 4,
    numColumns: 8,
  };
  // Anneau autour des waypoints de base (43.45, 1.4).
  const ring: [number, number][] = [
    [43.449, 1.399],
    [43.449, 1.403],
    [43.453, 1.403],
    [43.453, 1.399],
  ];

  it("confirme quand tous les waypoints restent dans la parcelle", () => {
    const { findings } = runRouteChecks(
      baseInput({
        templateMode: "facade",
        facade: {
          ...facadeBase,
          parcelPolygon: ring,
          parcelLabel: "Test section A n°1",
        },
      }),
    );
    const finding = findings.find((f) => f.checkId === "R-11");
    expect(finding?.severity).toBe("info");
  });

  it("avertit avec les numéros quand un waypoint sort de la parcelle", () => {
    const { findings } = runRouteChecks(
      baseInput({
        waypoints: [
          makeWaypoint({ index: 0, latitude: 43.45, longitude: 1.4 }),
          makeWaypoint({ index: 1, latitude: 43.46, longitude: 1.41 }),
        ],
        templateMode: "facade",
        facade: {
          ...facadeBase,
          parcelPolygon: ring,
          parcelLabel: "Test section A n°1",
        },
      }),
    );
    const finding = findings.find((f) => f.checkId === "R-11");
    expect(finding?.severity).toBe("warning");
    expect(finding?.label).toContain("1 waypoint hors parcelle");
    expect(finding?.description).toContain("n°2");
  });

  it("ne produit rien sans polygone de parcelle", () => {
    const { findings } = runRouteChecks(
      baseInput({ templateMode: "facade", facade: { ...facadeBase } }),
    );
    expect(findings.some((f) => f.checkId === "R-11")).toBe(false);
  });
});

describe("hauteur de bâtiment absente", () => {
  it("avertit sans conclure favorablement", () => {
    const { findings } = runRouteChecks(
      baseInput({
        templateMode: "facade",
        facade: {
          active: true,
          templateMode: "facade",
          buildingRnbId: "RNB123",
          buildingHeightM: null,
          heightSource: null,
          segmentId: "segment-0",
          segmentLengthM: 20,
          distanceM: 15,
          numRows: 4,
          numColumns: 8,
        },
      }),
    );
    const heightFinding = findings.find((f) => f.checkId === "R-05");
    expect(heightFinding?.severity).toBe("warning");
    expect(
      findings.some(
        (f) =>
          f.severity === "info" &&
          /au-dessus du bâtiment|survol.*possible/i.test(
            `${f.label} ${f.description}`,
          ),
      ),
    ).toBe(false);
  });
});

describe("suggestions", () => {
  function duplicateMission() {
    useMissionStore.getState().loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: [
        makeWaypoint({ index: 0, latitude: 43.45, longitude: 1.4 }),
        makeWaypoint({ index: 1, latitude: 43.45, longitude: 1.4 }),
      ],
    });
  }

  it("la prévisualisation ne modifie pas la mission", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    duplicateMission();
    await useRouteCheckStore.getState().runCheck();
    const store = useRouteCheckStore.getState();
    const suggestion = store.report?.suggestions.find(
      (s) => s.kind === "remove-waypoint",
    );
    expect(suggestion).toBeDefined();
    store.previewSuggestion(suggestion!.id);
    expect(useRouteCheckStore.getState().previewWaypoints).toHaveLength(1);
    // Mission intacte : toujours 2 waypoints.
    expect(useMissionStore.getState().waypoints).toHaveLength(2);
  });

  it("refuse l'application sans confirmation", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    duplicateMission();
    await useRouteCheckStore.getState().runCheck();
    const store = useRouteCheckStore.getState();
    const suggestion = store.report?.suggestions.find(
      (s) => s.kind === "remove-waypoint",
    );
    store.applySuggestion(suggestion!.id, false);
    expect(useMissionStore.getState().waypoints).toHaveLength(2);
    expect(
      useRouteCheckStore
        .getState()
        .report?.suggestions.find((s) => s.id === suggestion!.id)?.status,
    ).toBe("proposed");
  });

  it("refuse l'application sur une version périmée", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    duplicateMission();
    await useRouteCheckStore.getState().runCheck();
    const suggestion = useRouteCheckStore
      .getState()
      .report?.suggestions.find((s) => s.kind === "remove-waypoint");
    // Le parcours change après le rapport.
    useMissionStore.getState().loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: [
        makeWaypoint({ index: 0, latitude: 43.45, longitude: 1.4 }),
        makeWaypoint({ index: 1, latitude: 43.46, longitude: 1.41 }),
      ],
    });
    useRouteCheckStore.getState().applySuggestion(suggestion!.id, true);
    expect(useMissionStore.getState().waypoints).toHaveLength(2);
    expect(useMissionStore.getState().waypoints[1].latitude).toBeCloseTo(43.46);
  });

  it("applique après confirmation sur la bonne version", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    duplicateMission();
    await useRouteCheckStore.getState().runCheck();
    const suggestion = useRouteCheckStore
      .getState()
      .report?.suggestions.find((s) => s.kind === "remove-waypoint");
    useRouteCheckStore.getState().applySuggestion(suggestion!.id, true);
    expect(useMissionStore.getState().waypoints).toHaveLength(1);
    expect(isReportStale(useRouteCheckStore.getState().report)).toBe(true);
  });
});

describe("IA indisponible ou invalide", () => {
  it("affiche les constats déterministes sans fournisseur", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse locale.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: "regles-locales",
    });
    useMissionStore.getState().loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: baseInput().waypoints,
    });
    await useRouteCheckStore.getState().runCheck();
    const report = useRouteCheckStore.getState().report;
    expect(report).not.toBeNull();
    expect(report!.ai.status).toBe("unavailable");
    expect(report!.findings.length).toBeGreaterThan(0);
  });

  it("écarte une réponse IA invalide sans casser le rapport", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Ce vol est sûr et autorisé.",
      bullets: "pas-un-tableau",
      warnings: [],
      suggestedActions: [],
      source: "ollama",
      usedModel: "qwen",
    });
    useMissionStore.getState().loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: baseInput().waypoints,
    });
    await useRouteCheckStore.getState().runCheck();
    const report = useRouteCheckStore.getState().report;
    expect(report).not.toBeNull();
    expect(report!.ai.status).toBe("invalid");
    expect(report!.findings.length).toBeGreaterThan(0);
  });
});

describe("libellés", () => {
  it("ne présente jamais l'analyse comme une autorisation de vol", async () => {
    analyzeMock.mockResolvedValue({
      answer: "Analyse.",
      bullets: [],
      warnings: [],
      suggestedActions: [],
      source: "local-rules",
      usedModel: null,
    });
    useMissionStore.getState().loadMission({
      name: "Test",
      config: makeConfig(),
      waypoints: baseInput().waypoints,
    });
    await useRouteCheckStore.getState().runCheck();
    const report = useRouteCheckStore.getState().report!;
    const texts = [
      ...report.findings.flatMap((f) => [f.label, f.description]),
      ...report.suggestions.flatMap((s) => [s.label, s.justification]),
    ];
    for (const text of texts) {
      expect(containsBannedClaim(text)).toBe(false);
    }
  });
});
