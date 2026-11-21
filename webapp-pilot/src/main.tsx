// SPDX-License-Identifier: MIT
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/pilot.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register offline Service Worker for installable PWA support
if (typeof window !== "undefined" && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}
