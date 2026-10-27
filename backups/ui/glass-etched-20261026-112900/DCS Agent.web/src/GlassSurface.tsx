import LiquidGlass from "liquid-glass-react";
import { useEffect, useRef, useState } from "react";

const STILL = { x: 0, y: 0 };

/** Keep the official optics behind the controls so text and hit targets stay sharp. */
export function GlassSurface({ radius = 14, scale = 70 }: { radius?: number; scale?: number }) {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState("");
  useEffect(() => {
    const element = surface.current!;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(Math.round(width) + "x" + Math.round(height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={surface} className="dcs-liquid-surface" aria-hidden="true">
    {size && <LiquidGlass key={size} className="dcs-liquid-optics" mode="standard"
      displacementScale={scale} blurAmount={0.0625} saturation={140}
      aberrationIntensity={2} elasticity={0} cornerRadius={radius}
      padding="0" globalMousePos={STILL} mouseOffset={STILL}
      style={{ position: "absolute", top: "50%", left: "50%", width: "100%", height: "100%" }}>
      <span />
    </LiquidGlass>}
  </div>;
}
