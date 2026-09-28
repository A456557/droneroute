import {
  AlertTriangle,
  Ban,
  Check,
  Eye,
  EyeOff,
  Info,
  MapPin,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMissionStore } from "@/store/missionStore";
import { isReportStale, useRouteCheckStore } from "@/store/routeCheckStore";
import type { RouteFinding, RouteSuggestion } from "@/lib/routeCheck";
import { formatDurationFr, targetPosition } from "@/lib/routeCheck";

function StatusBadge({ status }: { status: string }) {
  if (status === "blocked") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
        <Ban className="h-3 w-3" /> Bloqué
      </span>
    );
  }
  if (status === "review") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <ShieldAlert className="h-3 w-3" /> À vérifier
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
      <ShieldCheck className="h-3 w-3" /> Aucune anomalie détectée dans les
      données contrôlées
    </span>
  );
}

function SeverityIcon({ severity }: { severity: RouteFinding["severity"] }) {
  if (severity === "error")
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  if (severity === "warning")
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />;
  if (severity === "unverified")
    return <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <Info className="h-3.5 w-3.5 shrink-0 text-sky-300" />;
}

function FindingCard({ finding }: { finding: RouteFinding }) {
  const {
    ignoreFinding,
    requestFocus,
    previewSuggestion,
    clearPreview,
    ignoreSuggestion,
    applySuggestion,
    previewSuggestionId,
    report,
  } = useRouteCheckStore();
  const suggestion: RouteSuggestion | undefined = report?.suggestions.find(
    (s) => s.id === finding.suggestionId,
  );
  const isPreviewed =
    suggestion != null && previewSuggestionId === suggestion.id;
  const position = targetPosition(finding.target);

  const handleApply = () => {
    if (!suggestion) return;
    if (
      window.confirm(
        `Appliquer « ${suggestion.label} » ? La mission sera modifiée et le rapport deviendra périmé.`,
      )
    ) {
      applySuggestion(suggestion.id, true);
    }
  };

  const handleManual = () => {
    clearPreview();
    if (position) {
      requestFocus({
        lat: position.lat,
        lng: position.lng,
        waypointIndex:
          finding.target.kind === "waypoint" ? finding.target.index : undefined,
      });
    }
    toast.info("Modifiez manuellement, puis relancez le contrôle.");
  };

  return (
    <div
      className={`rounded-md border px-2.5 py-2 ${
        finding.status === "ignored"
          ? "border-border/50 opacity-60"
          : "border-border/70 bg-background/40"
      }`}
    >
      <div className="flex items-start gap-2">
        <SeverityIcon severity={finding.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{finding.label}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {finding.description}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Règle : {finding.rule} · Source : {finding.dataSource.source}
            {finding.dataSource.updatedAt
              ? ` (${finding.dataSource.updatedAt})`
              : " (date de mise à jour non fournie)"}
          </p>
          {finding.missing.length > 0 && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Manquant : {finding.missing.join(", ")}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {position && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() =>
                  requestFocus({
                    lat: position.lat,
                    lng: position.lng,
                    waypointIndex:
                      finding.target.kind === "waypoint"
                        ? finding.target.index
                        : undefined,
                  })
                }
              >
                <MapPin className="mr-1 h-3 w-3" /> Voir sur la carte
              </Button>
            )}
            {finding.status !== "ignored" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] text-muted-foreground"
                onClick={() => ignoreFinding(finding.id)}
              >
                <EyeOff className="mr-1 h-3 w-3" /> Ignorer
              </Button>
            ) : (
              <span className="text-[10px] text-muted-foreground">Ignoré</span>
            )}
          </div>
          {suggestion && suggestion.status === "proposed" && (
            <div className="mt-2 rounded border border-primary/30 bg-primary/5 px-2 py-1.5">
              <p className="text-[11px] font-medium text-foreground">
                Suggestion : {suggestion.label}
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {suggestion.justification}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Données utilisées : {suggestion.dataUsed.join(", ")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {suggestion.previewWaypoints && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() =>
                      isPreviewed
                        ? clearPreview()
                        : previewSuggestion(suggestion.id)
                    }
                  >
                    <Eye className="mr-1 h-3 w-3" />
                    {isPreviewed ? "Masquer l'aperçu" : "Prévisualiser"}
                  </Button>
                )}
                {suggestion.kind === "remove-waypoint" ? (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={handleApply}
                  >
                    <Check className="mr-1 h-3 w-3" /> Appliquer
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={handleManual}
                  >
                    Modifier manuellement
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-muted-foreground"
                  onClick={() => ignoreSuggestion(suggestion.id)}
                >
                  <X className="mr-1 h-3 w-3" /> Ignorer
                </Button>
              </div>
            </div>
          )}
          {suggestion?.status === "applied" && (
            <p className="mt-1 text-[10px] text-emerald-400">
              Appliquée : le parcours a changé, relancez le contrôle.
            </p>
          )}
          {suggestion?.status === "ignored" && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Suggestion ignorée.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function RouteCheckPanel() {
  const waypoints = useMissionStore((s) => s.waypoints);
  const {
    report,
    running,
    aiRunning,
    blockingRules,
    setBlockingRules,
    blockExport,
    setBlockExport,
    runCheck,
    clearReport,
  } = useRouteCheckStore();
  const stale = isReportStale(report);
  const canRun = waypoints.length >= 2 && !running;
  const disabledReason =
    waypoints.length < 2
      ? "Ajoutez au moins 2 waypoints pour contrôler le parcours."
      : null;

  const errors = report?.findings.filter((f) => f.severity === "error") ?? [];
  const warnings =
    report?.findings.filter((f) => f.severity === "warning") ?? [];
  const unverified =
    report?.findings.filter((f) => f.severity === "unverified") ?? [];
  const infos = report?.findings.filter((f) => f.severity === "info") ?? [];

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Contrôle du parcours
        </p>
        <p className="leading-relaxed text-muted-foreground">
          Vérifie le trajet actuel avant export : règles déterministes, puis
          suggestions IA si un fournisseur est configuré. Vous restez seul
          décisionnaire : rien n'est modifié sans votre confirmation.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canRun}
          title={disabledReason ?? "Lancer le contrôle du parcours actuel"}
          onClick={() => void runCheck()}
        >
          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
          {running
            ? "Contrôle…"
            : report
              ? "Relancer le contrôle"
              : "Contrôler le parcours"}
        </Button>
        {report && (
          <Button type="button" variant="ghost" size="sm" onClick={clearReport}>
            Effacer
          </Button>
        )}
      </div>
      {disabledReason && (
        <p className="text-[11px] text-muted-foreground">{disabledReason}</p>
      )}

      {report && (
        <div className="space-y-3">
          {stale ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              Parcours modifié depuis ce rapport : à recalculer. L'ancien
              rapport ne s'applique plus au nouveau trajet.
            </div>
          ) : (
            <StatusBadge status={report.globalStatus} />
          )}

          <div className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            {report.summary.waypointCount} waypoints ·{" "}
            {Math.round(report.summary.distanceM)} m ·{" "}
            {formatDurationFr(report.summary.durationS)} · version{" "}
            <span className="font-mono">{report.versionHash}</span>
          </div>

          {errors.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
          {warnings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
          {unverified.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
          {infos.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}

          <div className="space-y-1.5 rounded-md border border-border/70 bg-background/40 px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Sparkles className="h-3.5 w-3.5" /> Suggestions IA
            </p>
            {aiRunning && (
              <p className="text-[11px] text-muted-foreground">
                Analyse IA en cours…
              </p>
            )}
            {!aiRunning && report.ai.status === "unavailable" && (
              <p className="text-[11px] text-muted-foreground">
                Suggestions IA indisponibles
                {report.ai.reason ? ` : ${report.ai.reason}` : "."}
              </p>
            )}
            {!aiRunning && report.ai.status === "invalid" && (
              <p className="text-[11px] text-amber-200">
                Analyse IA écartée
                {report.ai.reason ? ` : ${report.ai.reason}` : "."} Les
                contrôles déterministes ci-dessus restent valables.
              </p>
            )}
            {!aiRunning && report.ai.status === "ok" && (
              <div className="space-y-2">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {report.ai.explanation}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {report.ai.imageAnalyzed
                    ? "Vue cartographique analysée par le modèle."
                    : "Vue cartographique non analysée (modèle sans vision ou image indisponible) : constats texte uniquement."}
                </p>
                {report.ai.actions.map((action) => (
                  <div
                    key={action.label}
                    className="rounded border border-border/60 px-2 py-1.5"
                  >
                    <p className="text-[11px] font-medium text-foreground">
                      {action.label}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                      {action.detail}
                    </p>
                    {action.target && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Cible : {action.target}
                      </p>
                    )}
                    {action.justification && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Pourquoi : {action.justification}
                      </p>
                    )}
                    {action.dataUsed && action.dataUsed.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Données utilisées : {action.dataUsed.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">
                  Pistes explicatives uniquement : l'IA ne modifie pas la
                  mission et ne valide aucun vol
                  {report.ai.source
                    ? ` (${report.ai.source}${report.ai.usedModel ? `, ${report.ai.usedModel}` : ""})`
                    : ""}
                  .
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1.5 rounded-md border border-border/70 bg-background/40 px-2.5 py-2">
            <p className="text-[11px] font-medium text-foreground">
              Règles bloquantes
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={blockExport}
                onChange={(e) => setBlockExport(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Bloquer l'export en cas d'échec bloquant
            </label>
            {(
              [
                ["obstacleConflict", "Conflit obstacle"],
                ["prohibitedAirspace", "Zone interdite"],
                ["terrainCollision", "Collision relief"],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground"
              >
                <input
                  type="checkbox"
                  checked={blockingRules[key]}
                  onChange={(e) =>
                    setBlockingRules({ [key]: e.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-primary"
                />
                {label}
              </label>
            ))}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Aucune politique de blocage d'export n'existait : ces
              interrupteurs sont la configuration en attente de validation
              métier. L'export n'est refusé que si vous l'activez et qu'un
              constat bloquant porte sur la version actuelle. Une suggestion IA
              seule ne bloque jamais l'export.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
