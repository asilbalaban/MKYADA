import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAlwaysOnTop, initTheme } from "./lib/settings";
import { initLayout } from "./lib/layout";
import "./index.css";

initTheme();
initLayout();
initAlwaysOnTop();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
