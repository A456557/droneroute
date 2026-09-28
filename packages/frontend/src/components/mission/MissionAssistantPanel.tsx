import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { missionAssistantApi, type MissionAssistantResponse } from "@/lib/api";
import { buildTerrainSnapshot, terrainApi } from "@/lib/terrain";
import { buildSiteSnapshot, siteApi, type SiteSummary } from "@/lib/site";
import { useMissionStore } from "@/store/missionStore";

const SUGGESTED_PROMPTS = [
  "Analyse cette mission et vérifie que le trajet est adapté au terrain.",
  "Est-ce que cette mission tient sur une batterie ?",
  "Que faut-il ajuster pour un scan facade plus propre ?",
  "Pour une cartographie 3D de bâtiments, faut-il une cross-grid ?",
];

export function MissionAssistantPanel() {
  const { missionName, templateMode, config, waypoints, pois, obstacles } =
    useMissionStore();
  const [prompt, setPrompt] = useState(SUGGESTED_PROMPTS[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MissionAssistantResponse | null>(null);
  const [siteSummary, setSiteSummary] = useState<SiteSummary | null>(null);

  const analyzeMission = async () => {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length < 3) {
      toast.error("Saisissez une demande un peu plus précise.");
      return;
    }

    setLoading(true);
    try {
      // Analyse chantier : profil MNT IGN (RGE ALTI) + contexte site
      // (météo Open-Meteo, parcelle APICarto, PLU GPU, zones DGAC).
      let terrain = null;
      let site = null;
      if (waypoints.length > 0) {
        const points = waypoints.map((wp) => ({
          lat: wp.latitude,
          lon: wp.longitude,
        }));
        try {
          const profile = await terrainApi.profile(points);
          terrain = buildTerrainSnapshot(
            waypoints,
            profile.samples,
            profile.source,
          );
        } catch {
          terrain = null;
        }
        try {
          const summary = await siteApi.summary(points);
          setSiteSummary(summary);
          site = buildSiteSnapshot(summary);
        } catch {
          site = null;
        }
      }
      const response = await missionAssistantApi.analyzeMission({
        prompt: trimmedPrompt,
        missionName,
        templateMode,
        config,
        waypoints,
        pois,
        obstacles,
        terrain,
        site,
      });
      setResult(response);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Impossible d'analyser la mission pour le moment.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Mission assistant</p>
        <p className="text-muted-foreground leading-relaxed">
          Assistant serveur branché sur la mission en cours + MNT IGN (RGE
          ALTI), météo Open-Meteo, parcelle APICarto, PLU (GPU) et zones DGAC —
          le tout en open-source (Licence Ouverte). Il vérifie que le trajet
          drone est adapté au chantier via un modèle open-source (Ollama +
          Mistral en local).
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SUGGESTED_PROMPTS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setPrompt(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={4}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="Exemple: propose une version plus courte de cette mission pour garder une bonne couverture."
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {waypoints.length} waypoints, {pois.length} POI, {obstacles.length}{" "}
          obstacle
          {obstacles.length > 1 ? "s" : ""}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={analyzeMission}
          disabled={loading}
        >
          {loading ? "Analyse..." : "Analyser"}
        </Button>
      </div>

      {result && (
        <div className="space-y-3 rounded-md border border-border bg-black/10 p-3">
          {siteSummary && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {siteSummary.meteo && (
                <span className="rounded border border-border/70 px-2 py-0.5">
                  🌬️ {siteSummary.meteo.label}, vent{" "}
                  {siteSummary.meteo.windMs?.toFixed(1) ?? "?"} m/s
                  {siteSummary.meteo.precipitationMm != null &&
                    siteSummary.meteo.precipitationMm > 0 &&
                    `, pluie ${siteSummary.meteo.precipitationMm.toFixed(1)} mm`}
                </span>
              )}
              {siteSummary.parcelle?.commune && (
                <span className="rounded border border-border/70 px-2 py-0.5">
                  🏗️ {siteSummary.parcelle.commune} §
                  {siteSummary.parcelle.section ?? "?"} n°
                  {siteSummary.parcelle.numero ?? "?"}
                </span>
              )}
              {(siteSummary.urbanisme?.documentType ||
                siteSummary.urbanisme?.zoneLibelle) && (
                <span className="rounded border border-border/70 px-2 py-0.5">
                  📋 {siteSummary.urbanisme.documentType ?? "Urba"} · zone{" "}
                  {siteSummary.urbanisme.zoneLibelle ?? "?"}
                </span>
              )}
              {siteSummary.airspace &&
                (siteSummary.airspace.prohibited > 0 ||
                  siteSummary.airspace.restricted > 0) && (
                  <span className="rounded border border-amber-500/50 px-2 py-0.5 text-amber-300">
                    ⚠️ DGAC : {siteSummary.airspace.prohibited} interdite(s),{" "}
                    {siteSummary.airspace.restricted} restreinte(s)
                  </span>
                )}
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">Réponse</p>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {result.source}
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              {result.answer}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="font-medium text-foreground">Résumé mission</p>
            <ul className="space-y-1 text-muted-foreground list-disc pl-4">
              {result.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium text-amber-300">Points d'attention</p>
              <ul className="space-y-1 text-muted-foreground list-disc pl-4">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="font-medium text-foreground">Actions suggérées</p>
            <div className="space-y-2">
              {result.suggestedActions.map((action) => (
                <div
                  key={action.label}
                  className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2"
                >
                  <p className="font-medium text-foreground">{action.label}</p>
                  {action.target ? (
                    <p className="mt-1 text-xs text-sky-300">
                      Cible : {action.target}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground mt-1 leading-relaxed">
                    {action.detail}
                  </p>
                  {action.justification ? (
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      Pourquoi : {action.justification}
                    </p>
                  ) : null}
                  {action.dataUsed && action.dataUsed.length > 0 ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Données : {action.dataUsed.join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
