import { useEffect, useRef, useState, type RefObject } from "react";
import {
  applyGroupEffects,
  DEFAULT_BASEMAP,
  redactUrlCredentials,
  useAppStore,
} from "@geolibre/core";
import type { StyleSpecification, Popup } from "mapbox-gl";
import type { MapEngine } from "./map-engine";
import { MapboxEngine, redactMapboxError } from "./mapbox-engine";
import { prepareMapboxStandard } from "./mapbox-standard-style";
import { styleUsesUnsupportedSource } from "./mapbox-layers";
import { resolveMapStyle } from "./map-controller";

export interface MapboxCanvasProps {
  accessToken: string;
  viewId?: string;
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
}

/** The namespace and its CSS load only when a Mapbox pane is mounted. */
export function MapboxCanvas({ accessToken, viewId, engineRef, onEngineReady }: MapboxCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const readyCallback = useRef(onEngineReady);
  readyCallback.current = onEngineReady;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let engine: MapboxEngine | undefined;
    let cleanup = () => {};
    setError(null);
    void Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")])
      .then(async ([module]) => {
        if (cancelled || !container.current) return;
        const gl = module.default;
        const state = useAppStore.getState();
        const pane = state.secondaryMapViews.find((p) => p.id === viewId);
        const view =
          viewId && !state.mapLayout.syncView ? (pane?.view ?? state.mapView) : state.mapView;
        const resolvedStyle = (url: string): string | StyleSpecification => {
          const style = resolveMapStyle(url);
          if (typeof style === "string") return style;
          // The offline PMTiles basemap resolves to a style whose source uses
          // the `pmtiles://` protocol, registered with maplibre-gl only. Mapbox
          // has no handler for it, so fall back rather than load a blank map.
          if (styleUsesUnsupportedSource(style)) {
            console.warn(
              `Basemap "${redactUrlCredentials(url)}" uses a MapLibre-only source protocol; the Mapbox renderer falls back to the default basemap.`,
            );
            return DEFAULT_BASEMAP;
          }
          const { projection, ...rest } = style;
          return {
            ...rest,
            ...(projection ? { projection: { name: projection.type } } : {}),
          } as StyleSpecification;
        };
        const initialStyle = await prepareMapboxStandard(
          resolvedStyle(state.preferences.map.mapboxStyleUrl ?? state.basemapStyleUrl),
          accessToken,
        );
        if (cancelled || !container.current) return;
        const map = new gl.Map({
          container: container.current,
          accessToken,
          ...view,
          style: initialStyle,
          projection: state.preferences.map.projection,
          attributionControl: false,
          preserveDrawingBuffer: true,
        });
        engine = new MapboxEngine(map, gl, accessToken);
        const current = engine;
        let applying = false;
        let popup: Popup | undefined;
        const update = (next: typeof state, previous?: typeof state) => {
          if (cancelled) return;
          const targetPane = next.secondaryMapViews.find((p) => p.id === viewId);
          const previousPane = previous?.secondaryMapViews.find((p) => p.id === viewId);
          applying = true;
          try {
            if (
              !previous ||
              (next.preferences.map.mapboxStyleUrl ?? next.basemapStyleUrl) !==
                (previous.preferences.map.mapboxStyleUrl ?? previous.basemapStyleUrl)
            ) {
              if (previous)
                current.setResolvedStyle(
                  resolvedStyle(next.preferences.map.mapboxStyleUrl ?? next.basemapStyleUrl),
                );
            }
            if (!previous || next.preferences.map !== previous.preferences.map)
              current.applyMapPreferences(next.preferences.map);
            if (!previous || next.basemapVisible !== previous.basemapVisible)
              current.setBasemapVisible(next.basemapVisible);
            if (!previous || next.basemapOpacity !== previous.basemapOpacity)
              current.setBasemapOpacity(next.basemapOpacity);
            if (!previous || next.blankBackgroundColor !== previous.blankBackgroundColor)
              current.setBlankBackgroundColor(next.blankBackgroundColor);
            if (
              !previous ||
              next.layers !== previous.layers ||
              next.layerGroups !== previous.layerGroups ||
              targetPane?.layerVisibility !== previousPane?.layerVisibility
            ) {
              const layers = targetPane
                ? next.layers.map((layer) => ({
                    ...layer,
                    visible: targetPane.layerVisibility[layer.id] ?? layer.visible,
                  }))
                : next.layers;
              current.syncLayers(applyGroupEffects(layers, next.layerGroups));
            }
            if (
              !previous ||
              next.mapView !== previous.mapView ||
              targetPane?.view !== previousPane?.view ||
              next.mapLayout.syncView !== previous.mapLayout.syncView
            ) {
              current.applyView(
                viewId && !next.mapLayout.syncView
                  ? (targetPane?.view ?? next.mapView)
                  : next.mapView,
              );
            }
            if (
              !viewId &&
              (!previous ||
                next.selectedFeatureId !== previous.selectedFeatureId ||
                next.selectedLayerId !== previous.selectedLayerId)
            ) {
              current.highlightFeature(
                next.layers.find((l) => l.id === next.selectedLayerId),
                next.selectedFeatureId,
              );
            }
            if (previous && next.identifyLayerId !== previous.identifyLayerId) popup?.remove();
          } finally {
            applying = false;
          }
        };
        const unsubscribe = useAppStore.subscribe(update);
        cleanup = unsubscribe;
        update(state);
        update(useAppStore.getState(), state);
        map.on("moveend", () => {
          if (applying || cancelled) return;
          const next = useAppStore.getState(),
            camera = current.readView();
          // Shared view first (as SecondaryMapCanvas does): each setter notifies
          // subscribers separately, and a synchronized pane reading the changed
          // pane against a stale `mapView` would jump to the old camera first.
          if (!viewId || next.mapLayout.syncView) next.setMapView(camera, true);
          if (viewId) next.setSecondaryMapView(viewId, camera, true);
        });
        map.on("mousemove", (e) => {
          if (!viewId) useAppStore.getState().setPointerCoords(e.lngLat.toArray());
        });
        map.on("mouseout", () => {
          if (!viewId) useAppStore.getState().setPointerCoords(null);
        });
        map.on("click", (e) => {
          if (viewId) return;
          const next = useAppStore.getState();
          if (!next.identifyLayerId) return;
          const match = current.identifyFeatures(
            e.lngLat.toArray(),
            next.layers.some((l) => l.id === next.identifyLayerId)
              ? next.identifyLayerId
              : undefined,
          )[0];
          popup?.remove();
          if (!match) {
            next.selectFeature(null);
            return;
          }
          next.selectLayer(match.layerId);
          next.selectFeature(match.featureId);
          const content = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = next.layers.find((l) => l.id === match.layerId)?.name ?? "";
          content.append(title);
          for (const [key, value] of Object.entries(match.properties)) {
            const row = document.createElement("div");
            row.textContent = `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
            content.append(row);
          }
          popup = new gl.Popup({ maxWidth: "360px" })
            .setLngLat(e.lngLat)
            .setDOMContent(content)
            .addTo(map);
        });
        map.on("load", () => {
          if (cancelled) return;
          if (engineRef) engineRef.current = current;
          readyCallback.current?.();
        });
        const resize = new ResizeObserver(() => map.resize());
        resize.observe(container.current);
        const status = window.setInterval(() => {
          const errors = current.getRenderStatus().errors;
          setError(errors.length ? errors.join("; ") : null);
        }, 1000);
        cleanup = () => {
          unsubscribe();
          resize.disconnect();
          window.clearInterval(status);
          popup?.remove();
        };
      })
      .catch((error) => {
        if (!cancelled) setError(redactMapboxError(String(error)));
      });
    return () => {
      cancelled = true;
      cleanup();
      if (engineRef && engineRef.current === engine) engineRef.current = null;
      engine?.destroy();
    };
  }, [accessToken, viewId, engineRef]);
  return (
    <div className="relative h-full w-full" data-testid="mapbox-canvas">
      <div ref={container} className="h-full w-full" />
      {error && (
        <div
          role="alert"
          className="absolute bottom-10 end-2 z-10 max-h-32 max-w-[75%] overflow-auto rounded border border-input bg-background p-2 text-xs text-foreground shadow"
        >
          {error}
        </div>
      )}
    </div>
  );
}
