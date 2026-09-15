import type * as mapboxgl from "mapbox-gl";
import type * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import type {
  MapEngine,
  MapEngineCapabilities,
  MapRenderSurface,
  FlyToCamera,
  BuiltInMapControl,
  IdentifiedFeature,
  ManualPlacementOptions,
  ExtentDrawingOptions,
  MapExtent,
} from "./map-engine";
import {
  compileMapboxLayer,
  isMapboxPluginLayer,
  DEFAULT_MAPBOX_TEXT_FONT,
  type MapboxLayerPlan,
} from "./mapbox-layers";
import { resolveTextFontFromStyleLayers } from "./text-font";
import { getLayerBounds } from "./geojson-loader";
import { captureEngineImage } from "./map-capture";
import { drawExtentOnCanvas } from "./extent-drawing";
import {
  prepareMapboxStandard,
  isMapboxStandard,
  STANDARD_OPACITY,
  STANDARD_BLANK_COLOR,
} from "./mapbox-standard-style";
import { arcgisOpacity } from "./arcgis-vector-style";

export const MAPBOX_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  styleSpec: true,
  nativeMapInstance: false,
  customLayers: false,
  terrain: true,
  picking: true,
  onMapDrawing: true,
  domControls: true,
});

export function redactMapboxError(message: string): string {
  return message
    .replace(/([?&]access_token=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b(?:pk|sk)\.[\w.-]+/g, "[redacted]");
}

/** Mapbox owns its own native objects; getMap deliberately remains MapLibre-only. */
export class MapboxEngine implements MapEngine {
  readonly kind = "mapbox" as const;
  readonly capabilities = MAPBOX_CAPABILITIES;
  private map: mapboxgl.Map | null;
  private surface: MapRenderSurface | null;
  private layers: GeoLibreLayer[] = [];
  private plans = new Map<string, MapboxLayerPlan>();
  private previous = new Map<string, GeoLibreLayer>();
  private errors = new Map<string, string>();
  private basemap: mapboxgl.LayerSpecification[] = [];
  // Label font borrowed from the basemap: a style only serves its own glyphs.
  private textFont: string[] = DEFAULT_MAPBOX_TEXT_FONT;
  private basemapVisible = true;
  private basemapOpacity = 1;
  private styleRequest = 0;
  private blankColor: string | null = null;
  private terrain = false;
  private exaggeration = 1;
  private preferences: MapPreferences | null = null;
  private pluginControls = new Map<maplibregl.IControl, mapboxgl.IControl>();
  private controls = new Map<
    BuiltInMapControl,
    { control: mapboxgl.IControl; visible: boolean; position: maplibregl.ControlPosition }
  >();
  private disposers = new Set<() => void>();
  private storyOpacities = new Map<string, number>();
  private rotating = false;
  private syncPending = false;
  private basemapPending = false;
  private flushLayers = () => {
    if (this.syncPending) this.syncLayers(this.layers);
    if (this.basemapPending) this.applyBasemap();
  };

  constructor(
    map: mapboxgl.Map,
    private gl: typeof mapboxgl.default,
    private accessToken = "",
  ) {
    this.map = map;
    this.surface = {
      getCanvas: () => map.getCanvas(),
      getContainer: () => map.getContainer(),
      getBearing: () => map.getBearing(),
      project: (p) => map.project(p),
      unproject: (p) => map.unproject(p),
      redraw: () => map.triggerRepaint(),
    };
    map.on("style.load", this.styleLoaded);
    map.on("error", this.onError);
    map.on("sourcedata", this.onSourceData);
    map.on("idle", this.flushLayers);
    this.addNativeControl("navigation", new gl.NavigationControl());
    this.addNativeControl("fullscreen", new gl.FullscreenControl());
    this.addNativeControl("scale", new gl.ScaleControl(), "bottom-left");
    this.addNativeControl("attribution", new gl.AttributionControl(), "bottom-right");
    if (map.isStyleLoaded()) this.styleLoaded();
  }
  getMap(): null {
    return null;
  }
  /** Typed escape hatch for integrations explicitly declaring Mapbox support. */
  getMapboxMap(): mapboxgl.Map | null {
    return this.map;
  }
  private onError = (event: { error: Error; sourceId?: string }) => {
    this.errors.set(event.sourceId ?? "map", redactMapboxError(event.error.message));
  };
  /**
   * A source error is stored under the source id and must not outlive the
   * failure: Mapbox emits `sourcedata` for metadata, visibility and error
   * changes too, so only a completed `content` load clears the entry.
   */
  private onSourceData = (event: {
    sourceId?: string;
    sourceDataType?: "metadata" | "content" | "visibility" | "error";
    isSourceLoaded?: boolean;
  }) => {
    if (event.sourceId && event.sourceDataType === "content" && event.isSourceLoaded)
      this.errors.delete(event.sourceId);
  };
  private styleLoaded = () => {
    const map = this.map;
    if (!map) return;
    this.plans.clear();
    this.previous.clear();
    this.errors.clear();
    this.basemap = structuredClone(map.getStyle()?.layers ?? []);
    this.textFont = resolveTextFontFromStyleLayers(
      this.basemap as { type: string; layout?: Record<string, unknown> }[],
      DEFAULT_MAPBOX_TEXT_FONT,
    );
    if (this.preferences) this.applyMapPreferences(this.preferences);
    this.applyBasemap();
    this.setBlankBackgroundColor(this.blankColor);
    this.setTerrainEnabled(this.terrain);
    this.syncLayers(this.layers);
  };
  destroy(): void {
    if (!this.map) return;
    this.styleRequest++;
    this.stopCamera();
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.map.off("style.load", this.styleLoaded);
    this.map.off("error", this.onError);
    this.map.off("sourcedata", this.onSourceData);
    this.map.off("idle", this.flushLayers);
    this.map.remove();
    this.pluginControls.clear();
    this.map = null;
    this.surface = null;
    this.plans.clear();
    this.previous.clear();
  }
  readView(): MapViewState {
    const map = this.map;
    return map
      ? {
          center: map.getCenter().toArray(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
          ...(this.getViewBounds() ? { bbox: this.getViewBounds()! } : {}),
        }
      : { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 };
  }
  applyView(view: MapViewState): void {
    const old = this.readView();
    if (
      Math.abs(old.center[0] - view.center[0]) < 1e-8 &&
      Math.abs(old.center[1] - view.center[1]) < 1e-8 &&
      Math.abs(old.zoom - view.zoom) < 1e-8 &&
      old.bearing === view.bearing &&
      old.pitch === view.pitch
    )
      return;
    this.map?.jumpTo(this.constrainView(view));
  }
  easeToView(view: MapViewState): void {
    this.map?.easeTo(this.constrainView(view));
  }
  /**
   * Clamp a view to the project's zoom, pitch and world-copy preferences ahead
   * of the camera move, as the MapLibre engine does: the native constraints
   * still enforce the limits, but correcting an out-of-range saved camera
   * after the jump shows as a one-frame snap.
   */
  private constrainView(view: MapViewState): {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const minZoom = p ? clamp(p.minZoom, 0, 24) : 0;
    const maxZoom = p ? Math.max(minZoom, clamp(p.maxZoom, 0, 24)) : 24;
    return {
      center: [
        !p || p.renderWorldCopies ? view.center[0] : clamp(view.center[0], -180, 180),
        clamp(view.center[1], -85, 85),
      ],
      zoom: clamp(view.zoom, minZoom, maxZoom),
      bearing: view.bearing,
      pitch: clamp(view.pitch, 0, p ? clamp(p.maxPitch, 0, 85) : 85),
    };
  }
  readCameraAltitude(): number | null {
    const p = this.map?.getFreeCameraOptions().position;
    return p ? p.toAltitude() : null;
  }
  flyTo(camera: FlyToCamera): void {
    this.map?.flyTo({ duration: 800, ...camera });
  }
  flyToView(location: StoryChapterLocation): void {
    this.flyTo(location);
  }
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
  ): void {
    this.stopCamera();
    this.map?.[animation]({ ...location, duration: 800 });
    if (rotate && this.map) {
      this.rotating = true;
      this.map.once("moveend", this.rotate);
    }
  }
  private rotate = () => {
    if (!this.rotating || !this.map) return;
    this.map.once("moveend", this.rotate);
    this.map.easeTo({ bearing: this.map.getBearing() + 120, duration: 20000, easing: (t) => t });
  };
  zoomIn(): void {
    this.map?.zoomIn();
  }
  zoomOut(): void {
    this.map?.zoomOut();
  }
  resetNorth(): void {
    this.map?.resetNorth();
  }
  resetNorthPitch(): void {
    this.map?.resetNorthPitch();
  }
  resetPitch(): void {
    this.map?.easeTo({ pitch: 0, duration: 1000 });
  }
  fitBounds(bounds: MapExtent): void {
    this.map?.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, maxZoom: 14, duration: 800 },
    );
  }
  fitLayer(layer: GeoLibreLayer): void {
    const bounds = getLayerBounds(layer);
    if (bounds) this.fitBounds(bounds);
    else {
      const center = layer.metadata.center;
      if (
        Array.isArray(center) &&
        center.length >= 2 &&
        center.slice(0, 2).every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        this.map?.flyTo({
          center: [center[0] as number, center[1] as number],
          zoom: typeof layer.metadata.zoom === "number" ? layer.metadata.zoom : 16,
          // Match MapController.fitLayer: a tileset is looked at in perspective.
          ...(layer.type === "3d-tiles" ? { pitch: Math.max(this.map.getPitch(), 60) } : {}),
        });
      }
    }
  }
  readProjection(): MapProjection {
    return this.map?.getProjection().name === "globe" ? "globe" : "mercator";
  }
  applyMapPreferences(p: MapPreferences): void {
    this.preferences = p;
    const map = this.map;
    if (!map) return;
    // Clear old constraints before applying a disjoint new zoom interval.
    map.setMinZoom(0);
    map.setMaxZoom(24);
    map.setMaxZoom(Math.min(24, Math.max(0, p.maxZoom)));
    map.setMinZoom(Math.min(map.getMaxZoom(), Math.max(0, p.minZoom)));
    map.setMaxPitch(Math.min(85, Math.max(0, p.maxPitch)));
    map.setMaxBounds(
      p.restrictBounds
        ? [
            [p.bounds[0], p.bounds[1]],
            [p.bounds[2], p.bounds[3]],
          ]
        : null!,
    );
    map.setRenderWorldCopies(p.renderWorldCopies);
    map.setProjection(p.projection);
    this.setTerrainEnabled(p.terrainEnabled);
  }
  syncLayers(layers: GeoLibreLayer[]): void {
    this.layers = layers;
    const map = this.map;
    this.syncPending = true;
    if (!map?.isStyleLoaded()) return;
    this.syncPending = false;
    const ids = new Set(layers.map((layer) => layer.id));
    for (const id of this.plans.keys()) if (!ids.has(id)) this.removeLayer(id);
    for (const key of this.errors.keys())
      if (key.startsWith("layer:") && !ids.has(key.slice(6))) this.errors.delete(key);
    // Store order is topmost first. Add and move in reverse so overlays agree
    // with the layer panel, including after a style swap or drag reorder.
    for (const original of [...layers].reverse()) {
      try {
        // The plugin controls own these layers and synchronizes their display
        // settings from the store. They synchronize custom renderers separately from native sources.
        if (isMapboxPluginLayer(original)) {
          this.removeLayer(original.id);
          continue;
        }
        if (!original.visible) this.errors.delete(`layer:${original.id}`);
        const opacity = this.storyOpacities.get(original.id);
        const layer = opacity === undefined ? original : { ...original, opacity };
        const plan = compileMapboxLayer(layer, { textFont: this.textFont });
        const previous = this.previous.get(layer.id);
        const oldPlan = this.plans.get(layer.id);
        const sourceChanged =
          oldPlan &&
          (JSON.stringify(oldPlan.additionalSources) !== JSON.stringify(plan.additionalSources) ||
            oldPlan.source.type !== plan.source.type ||
            (plan.source.type === "geojson" && oldPlan.source.type === "geojson"
              ? false
              : JSON.stringify(oldPlan.source) !== JSON.stringify(plan.source)));
        if (sourceChanged) this.removeLayer(layer.id);
        for (const [id, source] of Object.entries(plan.additionalSources ?? {})) {
          if (!map.getSource(id)) map.addSource(id, source);
        }
        if (!map.getSource(plan.sourceId)) map.addSource(plan.sourceId, plan.source);
        else if (
          plan.source.type === "geojson" &&
          (previous?.geojson !== layer.geojson || previous?.source !== layer.source)
        ) {
          (map.getSource(plan.sourceId) as mapboxgl.GeoJSONSource).setData(plan.source.data!);
        }
        const wanted = new Set(plan.layers.map((spec) => spec.id));
        for (const old of oldPlan?.layers ?? [])
          if (!wanted.has(old.id) && map.getLayer(old.id)) map.removeLayer(old.id);
        for (const spec of plan.layers) {
          const old = map.getLayer(spec.id);
          if (old && old.type !== spec.type) map.removeLayer(spec.id);
          if (!map.getLayer(spec.id)) map.addLayer(spec);
          else if (
            JSON.stringify(oldPlan?.layers.find((s) => s.id === spec.id)) !== JSON.stringify(spec)
          ) {
            for (const [key, value] of Object.entries(spec.paint ?? {}))
              map.setPaintProperty(spec.id, key as keyof mapboxgl.AnyPaint, value);
            for (const [key, value] of Object.entries(spec.layout ?? {}))
              map.setLayoutProperty(spec.id, key as keyof mapboxgl.AnyLayout, value);
            if ("filter" in spec) map.setFilter(spec.id, spec.filter ?? null);
            map.setLayerZoomRange(spec.id, spec.minzoom ?? 0, spec.maxzoom ?? 24);
          }
          map.moveLayer(spec.id);
        }
        this.plans.set(layer.id, plan);
        this.previous.set(layer.id, original);
        this.errors.delete(`layer:${layer.id}`);
      } catch (error) {
        this.removeLayer(original.id);
        if (original.visible)
          this.errors.set(
            `layer:${original.id}`,
            `${original.name}: ${redactMapboxError(String(error))}`,
          );
      }
    }
  }
  private removeLayer(id: string): void {
    const plan = this.plans.get(id),
      map = this.map;
    if (map && plan) {
      for (const spec of [...plan.layers].reverse())
        if (map.getLayer(spec.id)) map.removeLayer(spec.id);
      if (map.getSource(plan.sourceId)) map.removeSource(plan.sourceId);
      for (const id of Object.keys(plan.additionalSources ?? {})) {
        if (map.getSource(id)) map.removeSource(id);
      }
    }
    this.plans.delete(id);
    this.previous.delete(id);
    this.errors.delete(`layer:${id}`);
    if (plan) this.errors.delete(plan.sourceId);
    for (const id of Object.keys(plan?.additionalSources ?? {})) this.errors.delete(id);
  }
  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    this.syncLayers(layers);
  }
  async getLayerGeoJson(id: string): Promise<FeatureCollection | null> {
    return this.layers.find((l) => l.id === id)?.geojson ?? null;
  }
  getLayerRasterSource(id: string): Record<string, unknown> | null {
    const source = this.plans.get(id)?.source;
    return source?.type === "raster" || source?.type === "image" ? { ...source } : null;
  }
  setStyle(url: string): void {
    this.setResolvedStyle(url);
  }
  /** Accepts GeoLibre's expanded inline basemaps without persisting an engine-specific style. */
  setResolvedStyle(style: string | mapboxgl.StyleSpecification): void {
    const request = ++this.styleRequest;
    const apply = (prepared: string | mapboxgl.StyleSpecification) => {
      if (!this.map || request !== this.styleRequest) return;
      this.errors.clear();
      this.plans.clear();
      this.previous.clear();
      this.map.setStyle(prepared, {
        diff: false,
        localFontFamily: null,
        localIdeographFontFamily: "sans-serif",
      });
    };
    if (!isMapboxStandard(style)) {
      apply(style);
      return;
    }
    void prepareMapboxStandard(style, this.accessToken)
      .then(apply)
      .catch((error: unknown) => {
        if (this.map && request === this.styleRequest)
          this.onError({ error: error instanceof Error ? error : new Error(String(error)) });
      });
  }
  getBasemapStyleLayerIds(): string[] {
    return this.basemap.map((s) => s.id);
  }
  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemap();
  }
  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemap();
  }
  private applyBasemap(): void {
    const map = this.map;
    if (!map?.isStyleLoaded()) {
      this.basemapPending = true;
      return;
    }
    this.basemapPending = false;
    for (const imported of map.getStyle()?.imports ?? []) {
      if (!imported.data?.schema?.[STANDARD_OPACITY]) continue;
      const opacity = this.basemapVisible ? this.basemapOpacity : 0;
      const color =
        this.blankColor ??
        (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff");
      if (map.getConfigProperty(imported.id, STANDARD_OPACITY) !== opacity)
        map.setConfigProperty(imported.id, STANDARD_OPACITY, opacity);
      if (map.getConfigProperty(imported.id, STANDARD_BLANK_COLOR) !== color)
        map.setConfigProperty(imported.id, STANDARD_BLANK_COLOR, color);
    }
    for (const spec of this.basemap) {
      if (!map.getLayer(spec.id)) continue;
      map.setLayoutProperty(
        spec.id,
        "visibility",
        this.basemapVisible ? (spec.layout?.visibility ?? "visible") : "none",
      );
      const props =
        spec.type === "symbol" ? ["text-opacity", "icon-opacity"] : [`${spec.type}-opacity`];
      if (
        [
          "background",
          "fill",
          "line",
          "circle",
          "symbol",
          "raster",
          "fill-extrusion",
          "heatmap",
        ].includes(spec.type)
      ) {
        for (const prop of props)
          map.setPaintProperty(
            spec.id,
            prop as keyof mapboxgl.AnyPaint,
            arcgisOpacity(
              (spec.paint as Record<string, unknown> | undefined)?.[prop],
              this.basemapOpacity,
            ) as mapboxgl.ExpressionSpecification | number,
          );
      }
    }
  }
  setBlankBackgroundColor(color: string | null): void {
    this.blankColor = color;
    this.applyBasemap();
    if (this.map?.getLayer("geolibre-blank-background"))
      this.map.setPaintProperty(
        "geolibre-blank-background",
        "background-color",
        color ?? (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff"),
      );
  }
  setStoryLayerOpacity(id: string, opacity: number): void {
    this.storyOpacities.set(id, opacity);
    this.syncLayers(this.layers);
  }
  restoreLayerStyles(): void {
    this.storyOpacities.clear();
    this.syncLayers(this.layers);
  }
  identifyFeatures(lngLat: [number, number], layerId?: string): IdentifiedFeature[] {
    const map = this.map;
    if (!map?.isStyleLoaded()) return [];
    const ids = [...this.plans]
      .filter(([id]) => !layerId || id === layerId)
      .flatMap(([id, p]) => p.layers.map((s) => ({ id: s.id, layerId: id })));
    const byId = new Map(ids.map((s) => [s.id, s.layerId]));
    const queryIds = ids.map((s) => s.id).filter((id) => map.getLayer(id));
    if (!queryIds.length) return [];
    const seen = new Set<string>();
    return map.queryRenderedFeatures(map.project(lngLat), { layers: queryIds }).flatMap((f) => {
      const id = byId.get(f.layer?.id ?? "")!;
      const featureId = this.featureIdForLayer(id, f.id);
      const key = `${id}:${featureId ?? JSON.stringify(f.properties)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          layerId: id,
          featureId,
          properties: f.properties ?? {},
          geometry: f.geometry,
        },
      ];
    });
  }
  /**
   * Resolve a queried feature's id to the app's `String(feature.id ?? index)`
   * identity. GeoJSON sources are compiled with `generateId`, so Mapbox reports
   * the feature's index in the source data and overwrites any authored id; map
   * it back through the layer's own GeoJSON so selection and highlighting key
   * on the same value as the attribute table.
   */
  private featureIdForLayer(layerId: string, queried: string | number | undefined): string | null {
    if (queried == null) return null;
    const features = this.layers.find((l) => l.id === layerId)?.geojson?.features;
    if (!features) return String(queried);
    const index = Number(queried);
    const feature = Number.isInteger(index) ? features[index] : undefined;
    return feature ? String(feature.id ?? index) : String(queried);
  }
  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { fit?: boolean },
  ): void {
    this.clearFeatureHighlight();
    if (!layer?.geojson || featureId === null || !this.map?.isStyleLoaded()) return;
    const ids = new Set(Array.isArray(featureId) ? featureId : [featureId]);
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: layer.geojson.features.filter((f, i) => ids.has(String(f.id ?? i))),
    };
    this.map.addSource("geolibre-mapbox-highlight", { type: "geojson", data });
    this.map.addLayer({
      id: "geolibre-mapbox-highlight-line",
      type: "line",
      source: "geolibre-mapbox-highlight",
      paint: { "line-color": "#facc15", "line-width": 4 },
    });
    this.map.addLayer({
      id: "geolibre-mapbox-highlight-point",
      type: "circle",
      source: "geolibre-mapbox-highlight",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 10, "circle-color": "#facc15", "circle-opacity": 0.6 },
    });
    if (options?.fit) this.fitLayer({ ...layer, geojson: data });
  }
  clearFeatureHighlight(): void {
    for (const id of ["geolibre-mapbox-highlight-line", "geolibre-mapbox-highlight-point"])
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
    if (this.map?.getSource("geolibre-mapbox-highlight"))
      this.map.removeSource("geolibre-mapbox-highlight");
  }
  startManualPlacement(lngLat: [number, number], options: ManualPlacementOptions): () => void {
    if (!this.map) return () => {};
    const marker = new this.gl.Marker({ draggable: true }).setLngLat(lngLat).addTo(this.map);
    const content = document.createElement("div");
    const hint = document.createElement("p");
    hint.textContent = options.hint;
    const button = document.createElement("button");
    button.textContent = options.doneLabel;
    content.append(hint, button);
    marker.setPopup(new this.gl.Popup().setDOMContent(content)).togglePopup();
    marker.on("dragend", () => options.onMove(marker.getLngLat().toArray()));
    const dispose = () => {
      marker.remove();
      this.disposers.delete(dispose);
    };
    button.onclick = () => {
      options.onMove(marker.getLngLat().toArray());
      dispose();
      options.onDone?.();
    };
    this.disposers.add(dispose);
    return dispose;
  }
  drawExtent(options: ExtentDrawingOptions): () => void {
    const map = this.map;
    if (!map) return () => {};
    const stop = drawExtentOnCanvas(
      map.getCanvas(),
      (p) => map.unproject([p.x, p.y]).toArray(),
      () => this.suspendNavigation(),
      options,
    );
    const dispose = () => {
      stop();
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getViewBounds(): MapExtent | null {
    const b = this.map?.getBounds();
    return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
  }
  showExtent(extent: MapExtent): () => void {
    const map = this.map;
    if (!map?.isStyleLoaded()) return () => {};
    const id = `geolibre-mapbox-extent-${crypto.randomUUID()}`;
    const [w, s, e, n] = extent;
    map.addSource(id, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        },
      },
    });
    map.addLayer({
      id,
      type: "line",
      source: id,
      paint: { "line-color": "#f59e0b", "line-width": 3 },
    });
    const dispose = () => {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
      if (this.map?.getSource(id)) this.map.removeSource(id);
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getRenderSurface(): MapRenderSurface | null {
    return this.surface;
  }
  getRenderStatus(): { pending: string[]; errors: string[] } {
    return {
      pending: !this.map?.loaded() || !this.map.areTilesLoaded() ? ["Mapbox map loading"] : [],
      errors: [...this.errors.values()],
    };
  }
  captureImage(): Promise<Blob> {
    return captureEngineImage(this);
  }
  onCameraIdle(listener: () => void): () => void {
    const map = this.map;
    map?.on("moveend", listener);
    return () => {
      map?.off("moveend", listener);
    };
  }
  stopCamera(): void {
    this.rotating = false;
    this.map?.off("moveend", this.rotate);
    this.map?.stop();
  }
  suspendNavigation(): () => void {
    const map = this.map;
    if (!map) return () => {};
    const enabled = [
      map.boxZoom,
      map.doubleClickZoom,
      map.dragPan,
      map.dragRotate,
      map.keyboard,
      map.scrollZoom,
      map.touchZoomRotate,
      map.touchPitch,
    ].filter((h) => h.isEnabled());
    for (const handler of enabled) handler.disable();
    return () => {
      if (this.map) for (const handler of enabled) handler.enable();
    };
  }
  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    if (this.pluginControls.has(control)) return true;
    // IControl's lifecycle is shared, but its TypeScript Map parameter is
    // engine-specific. Only plugins declaring Mapbox support should mount;
    // the vector importer additionally uses its store-only source bridge.
    const adapter: mapboxgl.IControl = {
      onAdd: (map) => {
        // DOM controls locate their corner by MapLibre's CSS class names.
        // Without these aliases a top-left panel assumes top-right and opens
        // outside the map, underneath the Layers sidebar.
        for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
          map
            .getContainer()
            .querySelector(`.mapboxgl-ctrl-${corner}`)
            ?.classList.add(`maplibregl-ctrl-${corner}`);
        }
        const element = control.onAdd(map as unknown as maplibregl.Map);
        element.classList.add("mapboxgl-ctrl");
        return element;
      },
      onRemove: (map) => control.onRemove(map as unknown as maplibregl.Map),
    };
    this.map.addControl(adapter, position);
    this.pluginControls.set(control, adapter);
    return true;
  }
  removeControl(control: maplibregl.IControl): void {
    const adapter = this.pluginControls.get(control);
    if (adapter && this.map?.hasControl(adapter)) this.map.removeControl(adapter);
    this.pluginControls.delete(control);
  }
  private addNativeControl(
    id: BuiltInMapControl,
    control: mapboxgl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): void {
    this.map?.addControl(control, position);
    this.controls.set(id, { control, visible: true, position });
  }
  setBuiltInControlVisible(id: BuiltInMapControl, visible: boolean): boolean {
    const item = this.controls.get(id);
    if (!item || !this.map) return false;
    // Attribution is required by Mapbox; keep its native control present.
    if (id === "attribution" && !visible) return false;
    if (item.visible !== visible) {
      if (visible) this.map.addControl(item.control, item.position);
      else this.map.removeControl(item.control);
      item.visible = visible;
    }
    return true;
  }
  getBuiltInControlPosition(id: BuiltInMapControl): maplibregl.ControlPosition {
    return this.controls.get(id)?.position ?? "top-right";
  }
  setBuiltInControlPosition(id: BuiltInMapControl, position: maplibregl.ControlPosition): boolean {
    const item = this.controls.get(id);
    if (!item || !this.map) return false;
    if (item.visible) {
      this.map.removeControl(item.control);
      this.map.addControl(item.control, position);
    }
    item.position = position;
    return true;
  }
  setCompassLabel(label: string): void {
    const button = this.map
      ?.getContainer()
      .querySelector<HTMLButtonElement>(".mapboxgl-ctrl-compass");
    if (button) {
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  }
  setBackgroundLabel(_label: string): void {}
  setTerrainLabel(_label: string): void {}
  isTerrainEnabled(): boolean {
    return this.terrain;
  }
  setTerrainEnabled(enabled: boolean): boolean {
    this.terrain = enabled;
    const map = this.map;
    if (!map?.isStyleLoaded()) return false;
    if (enabled && !map.getSource("geolibre-mapbox-dem"))
      map.addSource("geolibre-mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      });
    map.setTerrain(
      enabled ? { source: "geolibre-mapbox-dem", exaggeration: this.exaggeration } : null,
    );
    return true;
  }
  getTerrainExaggeration(): number {
    return this.exaggeration;
  }
  setTerrainExaggeration(value: number): void {
    this.exaggeration = Math.max(0, Math.min(10, value));
    this.setTerrainEnabled(this.terrain);
  }
  getTerrainCogSource(): null {
    return null;
  }
  hasCustomTerrainSource(): boolean {
    return false;
  }
  async setTerrainCogSource(source: string | Blob | null): Promise<boolean> {
    return source === null;
  }
}
