import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { missionAssistantApi, type MissionAssistantResponse } from "@/lib/api";
import { useMissionStore } from "@/store/missionStore";

const SUGGESTED_PROMPTS = [
  "Analyse cette mission et propose 3 améliorations.",
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

  const analyzeMission = async () => {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length < 3) {
      toast.error("Saisissez une demande un peu plus précise.");
      return;
    }

    setLoading(true);
    try {
      const response = await missionAssistantApi.analyzeMission({
        prompt: trimmedPrompt,
        missionName,
        templateMode,
        config,
        waypoints,
        pois,
        obstacles,
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
          Assistant serveur branché sur la mission en cours. Il résume la
          trajectoire, signale les points faibles et propose les prochains
          ajustements, avec les règles Mission Planner injectées comme contexte
          de mission.
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
                  <p className="text-muted-foreground mt-1 leading-relaxed">
                    {action.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
