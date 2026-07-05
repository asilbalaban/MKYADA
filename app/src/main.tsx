import React from "react";
import ReactDOM from "react-dom/client";
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

initTheme();
initLayout();
initAlwaysOnTop();
initRunInBackground();
initAutostart();
initLedMicFeedback();
initVariables();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
