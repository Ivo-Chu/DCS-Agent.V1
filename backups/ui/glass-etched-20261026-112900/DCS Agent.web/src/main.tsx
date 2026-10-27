import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import LogViewer from "./LogViewer";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.parent !== window ? <App /> : <LogViewer />}
  </StrictMode>
);

