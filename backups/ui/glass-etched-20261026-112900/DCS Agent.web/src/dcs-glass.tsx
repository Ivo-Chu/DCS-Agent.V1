import { createRoot } from "react-dom/client";
import { GlassSurface } from "./GlassSurface";
import css from "./liquid-glass.css?inline";

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

// Runs in the DCS document: its backdrop includes the actual DCS page behind the iframe.
function mount(panel: HTMLElement) {
  const host = document.createElement("div");
  host.className = "dcs-agent-liquid-host";
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;border-radius:inherit";
  panel.prepend(host);
  const root = createRoot(host);
  root.render(<GlassSurface radius={24} />);
  return () => { root.unmount(); host.remove(); };
}
Object.assign(window, { DcsAgentGlass: { mount } });
