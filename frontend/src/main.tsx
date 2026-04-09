import React from "react";
import ReactDOM from "react-dom/client";
import { syncThemeFromStorage } from "./theme-sync";
import "./styles.css";
import { AuthShell } from "./ui/AuthShell";

syncThemeFromStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthShell />
  </React.StrictMode>
);

