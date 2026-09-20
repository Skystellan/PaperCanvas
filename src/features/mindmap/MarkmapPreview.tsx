import { useEffect, useRef } from "react";
import { Markmap } from "markmap-view";
import type { MindMapNode } from "./model/markmap";

export default function MarkmapPreview({ root }: { root: MindMapNode }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<Markmap | null>(null);

  useEffect(() => {
    const svg = svgRef.current!;
    const map = Markmap.create(svg, {
      autoFit: false,
      duration: 0,
      maxWidth: 112,
      spacingHorizontal: 24,
      spacingVertical: 18,
      paddingX: 6,
      color: () => "#74806f",
      fitRatio: 0.94,
    });
    // D3's default SVG extent reads relative SVGLength values, which fail when
    // a navigation detaches the flex-sized SVG before a queued fit finishes.
    map.zoom.extent(() => [[0, 0], [svg.clientWidth, svg.clientHeight]]);
    mapRef.current = map;
    const fit = () => {
      if (mapRef.current === map && svg.clientWidth && svg.clientHeight) void map.fit();
    };
    void map.setData(root).then(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(svg);
    return () => {
      observer.disconnect();
      mapRef.current = null;
      map.destroy();
    };
  }, [root]);

  return <div className="paper-mind-map__interactive">
    <div className="paper-mind-map__zoom">
      <span>Click a node circle to fold · Drag to pan</span>
      <button type="button" aria-label="Zoom out" onClick={() => void mapRef.current?.rescale(0.8)}>−</button>
      <button type="button" onClick={() => void mapRef.current?.fit()}>Fit</button>
      <button type="button" aria-label="Zoom in" onClick={() => void mapRef.current?.rescale(1.25)}>+</button>
    </div>
    <svg ref={svgRef} role="img" aria-label="Paper mind map diagram" />
  </div>;
}
