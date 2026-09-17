import { create } from "zustand";
import { DEFAULT_MAP_VIEW, type MapViewState } from "@droneroute/shared";
import { api } from "@/lib/api";

interface ConfigState {
  selfHosted: boolean;
  googleClientId: string | null;
  defaultMapView: MapViewState;
  loaded: boolean;
  fetchConfig: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  selfHosted: true,
  googleClientId: null,
  defaultMapView: DEFAULT_MAP_VIEW,
  loaded: false,

  fetchConfig: async () => {
    try {
      const res = await api.get<{
        selfHosted: boolean;
        googleClientId?: string;
        defaultMapView?: MapViewState;
      }>("/config");
      set({
        selfHosted: res.selfHosted,
        googleClientId: res.googleClientId ?? null,
        defaultMapView: res.defaultMapView ?? DEFAULT_MAP_VIEW,
        loaded: true,
      });
    } catch {
      // Fallback to self-hosted if config endpoint fails
      set({
        selfHosted: true,
        googleClientId: null,
        defaultMapView: DEFAULT_MAP_VIEW,
        loaded: true,
      });
    }
  },
}));
