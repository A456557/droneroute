import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { AppWrapper } from "./AppWrapper";
// Styles MapLibre obligatoires : sans eux, les classes anchor-center des
// marqueurs ne s'appliquent pas et chaque marqueur est décalé en bas
// à droite de son point (moitié de sa taille).
import "maplibre-gl/dist/maplibre-gl.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppWrapper />
    <Toaster theme="dark" position="bottom-center" richColors />
  </StrictMode>,
);
