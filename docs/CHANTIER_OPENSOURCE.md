# DroneRoute Chantier — socle 100% open-source (V1)

Objet : analyse de chantier + vol adapté au terrain + vérification IA du trajet.

## Cartes 2D (Licence Ouverte 2.0, sans clé)

- **Plan IGN v2** (vue street) — WMTS Géoplateforme :
  `GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2` (PM, PNG)
- **BD ORTHO 20 cm** (vue satellite) — WMTS Géoplateforme :
  `ORTHOIMAGERY.ORTHOPHOTOS` (PM, JPEG)
- Fallback mondial : OpenFreeMap "bright" (OSM) pour le partage hors France.
- Fichiers : `packages/frontend/src/components/map/MapView.tsx` (`IGN_PLAN_STYLE`, `IGN_ORTHO_STYLE`).

Capabilities : `https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`

## Carte 3D

- **MapLibre GL JS** (BSD-3-Clause, déjà en place) + relief Terrarium pour la visualisation.
- **Altitudes métier (France)** : MNT **RGE ALTI 1 m / 5 m** (défaut `ign_rge_alti_wld`)
  et **LiDAR HD** quand disponible, via l'API de calcul altimétrique :
  `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json`
  - `https://data.geopf.fr/altimetrie/resources`
- Le MNT IGN WMTS n'étant pas encodé Terrarium/Mapbox, il transite par le
  proxy backend `/api/terrain` (cache 6 h, 5 req/s max IGN) au lieu du raster-dem.

## Données (data.gouv.fr / Géoplateforme, Licence Ouverte)

| Besoin chantier                     | Source                                           | Accès                                                                              |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Relief / terrassement / drapage AGL | RGE ALTI, BD ALTI, LiDAR HD (MNT/MNS/nuages)     | API altimétrie + `data.geopf.fr`                                                   |
| Bâtiments / hauteurs / obstacles    | BD TOPO V3 `batiment` (champ hauteur), RNB, BDNB | déjà via `/api/buildings` (WFS `data.geopf.fr`, `api.beta.gouv.fr`, `api.bdnb.io`) |
| Adresses / accès chantier           | BAN / BAN+                                       | géocodeur existant                                                                 |
| Fonds / ortho / plan                | Plan IGN, BD ORTHO                               | WMTS ci-dessus                                                                     |
| Parcelles / PLU (phase 2)           | GPU / Cadastre (PCI)                             | WFS Géoplateforme                                                                  |
| Zones vol (phase 2)                 | DGAC (déjà), ENaire/NATS                         | `/api/airspace`                                                                    |

## Vol adapté au terrain

- Backend : `packages/backend/src/services/terrain.ts` + `routes/terrain.ts`
  - `GET /api/terrain/elevation?lat&lon`
  - `POST /api/terrain/profile` `{ points[] }` → altitudes sol
  - `POST /api/terrain/drape` `{ waypoints[{lat,lon,heightM}], targetAglM }` → hauteurs absolues + stats relief/AGL
  - `GET /api/terrain/resources`
- Frontend : `packages/frontend/src/lib/terrain.ts`
  - Bouton **"Adapter au terrain"** dans `ElevationGraph` (AGL 5–500 m, défaut 40 m) : drape chaque waypoint à `sol + AGL`.
  - Le profil MNT est joint à l'analyse IA.

## Contexte site chantier (phase 2)

- Backend : `services/site.ts` + `POST /api/site/summary { points[] }`
  - **Météo** : Open-Meteo `current` (vent/rafales m/s, pluie mm, code WMO) — CC-BY 4.0, sans clé, cache 10 min.
  - **Parcelle** : APICarto `cadastre/parcelle` (commune, section, n°, contenance) — Licence Ouverte.
  - **Urbanisme** : APICarto GPU `document` (PLU/PLUi/CC…) + `zone-urba` (libellé, type de zone).
  - **Espace aérien** : providers existants (DGAC via WFS Géoplateforme, Enaire, NATS) — compte les zones contenant le centroïde.
- IA : snapshots `site` joints à `/api/assistant/mission` + warnings (vent > 10 m/s, rafales > 15 m/s, pluie > 1 mm, zone interdite/restreinte).
- **Sans IA configurée**, l'analyse reste disponible en repli `local-rules` (règles déterministes seules, HTTP 200).
- Frontend : `lib/site.ts`, chips météo/parcelle/PLU/DGAC dans `MissionAssistantPanel`.

## Analyse IA — vérifie que le trajet est adapté au terrain

- Moteur **100% open-source local** : **Ollama + Mistral** (`AI_PROVIDER=ollama`,
  `AI_API_URL=http://localhost:11434/v1/chat/completions` ou `http://ollama:…` en Docker,
  `AI_MODEL=mistral:latest`). Lancement : `ollama serve && ollama pull mistral`.
  Le backend parle OpenAI-compatible, donc Llama 3.1 / Qwen 2.5 / Codestral marchent aussi.
- Règles déterministes (sans LLM) conservées : AGL min < 15 m, relief > 30 m
  → drapage requis, MNT partiel, autonomie, segments longs, gimbal façade/grid-3D.
- Fichiers : `services/assistantAi.ts` (provider `ollama`), `routes/assistant.ts`
  (snapshot terrain + warnings), `MissionAssistantPanel.tsx` (envoie le profil MNT).

## Lancer

```bash
# App (image)
docker compose up -d
# → http://droneroute.localhost/

# IA locale (optionnel)
ollama serve & ollama pull mistral
# .env : AI_PROVIDER=ollama / AI_MODEL=mistral:latest
# ou : docker compose --profile ollama up -d
```
