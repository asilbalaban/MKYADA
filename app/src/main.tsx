import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import {
  initAlwaysOnTop,
  initAutostart,
  initLedMicFeedback,
  initRunInBackground,
  initTheme,
} from "./lib/settings";
import { initLayout } from "./lib/layout";
import { initVariables } from "./lib/variables";
import "./index.css";

const isOverlay = getCurrentWindow().label === "overlay";

if (isOverlay) {
  // The overlay is a transparent, click-through, full-screen, always-on-top
  // window. index.css paints html/body an opaque near-black (`--color-bg`), so
  // if that paints before OverlayView clears it the overlay is a solid black
  // screen covering everything — and on Windows a topmost opaque window with no
  // working content is an inescapable trap. Force it transparent HERE, before
  // React renders (and before any meaningful paint), so it can never be black.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
} else {
  // App-wide side effects belong to the real UI only — the overlay window is a
  // dumb, transparent canvas and must not touch device/autostart/theme state.
  initTheme();
  initLayout();
  initAlwaysOnTop();
  initRunInBackground();
  initAutostart();
  initLedMicFeedback();
  initVariables();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
