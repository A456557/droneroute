import { create } from "zustand";
import { DEFAULT_MAP_VIEW, type MapViewState } from "@droneroute/shared";
import { api } from "@/lib/api";

interface ConfigState {
  selfHosted: boolean;
  googleClientId: string | null;
  googleMapsApiKey: string;
  defaultMapView: MapViewState;
  loaded: boolean;
  fetchConfig: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  selfHosted: true,
  googleClientId: null,
  googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "",
  defaultMapView: DEFAULT_MAP_VIEW,
  loaded: false,

  fetchConfig: async () => {
    try {
      const res = await api.get<{
        selfHosted: boolean;
        googleClientId?: string;
        googleMapsApiKey?: string;
        defaultMapView?: MapViewState;
      }>("/config");
      set({
        selfHosted: res.selfHosted,
        googleClientId: res.googleClientId ?? null,
        googleMapsApiKey:
          res.googleMapsApiKey ??
          import.meta.env.VITE_GOOGLE_MAPS_API_KEY ??
          "",
        defaultMapView: res.defaultMapView ?? DEFAULT_MAP_VIEW,
        loaded: true,
      });
    } catch {
      // Fallback to self-hosted if config endpoint fails
      set({
        selfHosted: true,
        googleClientId: null,
        googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "",
        defaultMapView: DEFAULT_MAP_VIEW,
        loaded: true,
      });
    }
  },
}));
