import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { readRasterWindow } from "@geolibre/plugins";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export type ViewportStretchMethod = "minmax" | "percentile" | "stddev";

export function useRasterViewportStretch(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): void {
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const run = async (): Promise<void> => {
      const bounds = mapControllerRef.current?.getViewBounds?.();
      if (!bounds) return;
      const layers = useAppStore.getState().layers.filter((layer) => {
        const state = layer.metadata.rasterState;
        return (
          layer.metadata.sourceKind === "maplibre-gl-raster" &&
          state &&
          typeof state === "object" &&
          !Array.isArray(state) &&
          (state as Record<string, unknown>).viewportStretchAuto === true
        );
      });
      await Promise.all(layers.map((layer) => stretchLayer(layer.id, bounds, requests.current)));
    };

    const stop = mapControllerRef.current?.onCameraIdle(() => {
      void run();
    });
    void run();
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const changed = state.layers.some((layer) => {
        const before = previous.layers.find((item) => item.id === layer.id);
        return viewportStretchSettings(layer) !== viewportStretchSettings(before);
      });
      if (changed) void run();
    });

    return () => {
      stop?.();
      unsubscribe();
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
    };
  }, [mapControllerRef, mapReadyGeneration]);
}

function viewportStretchSettings(layer: { metadata: Record<string, unknown> } | undefined): string {
  const state = layer?.metadata.rasterState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  const value = state as Record<string, unknown>;
  return `${value.viewportStretchAuto === true}:${String(value.viewportStretchMethod ?? "minmax")}`;
}

async function stretchLayer(
  layerId: string,
  bounds: [number, number, number, number],
  requests: Map<string, AbortController>,
): Promise<void> {
  requests.get(layerId)?.abort();
  const controller = new AbortController();
  requests.set(layerId, controller);
  try {
    const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
    const state = layer?.metadata.rasterState;
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    const raw = state as Record<string, unknown>;
    const band = Array.isArray(raw.bands) && typeof raw.bands[0] === "number" ? raw.bands[0] : 1;
    const method =
      raw.viewportStretchMethod === "percentile" || raw.viewportStretchMethod === "stddev"
        ? raw.viewportStretchMethod
        : "minmax";
    const reading = await readRasterWindow(layerId, {
      bounds,
      band,
      width: 32,
      height: 32,
      signal: controller.signal,
    });
    if (controller.signal.aborted || !reading) return;
    const values = reading.values.filter(Number.isFinite);
    if (values.length === 0) return;
    const range = viewportRange(values, method);
    if (range[0] >= range[1]) return;
    const current = useAppStore.getState().layers.find((item) => item.id === layerId);
    if (!current || viewportStretchSettings(current) !== viewportStretchSettings(layer)) return;
    useAppStore.getState().updateLayer(layerId, {
      metadata: {
        ...current.metadata,
        rasterState: {
          ...((current.metadata.rasterState as Record<string, unknown> | undefined) ?? {}),
          rescale: [range],
        },
      },
    });
  } finally {
    if (requests.get(layerId) === controller) requests.delete(layerId);
  }
}

function viewportRange(values: number[], method: ViewportStretchMethod): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  if (method === "minmax") return [sorted[0], sorted[sorted.length - 1]];
  if (method === "percentile") return [percentile(sorted, 0.05), percentile(sorted, 0.95)];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  return [mean - 2 * deviation, mean + 2 * deviation];
}

function percentile(sorted: number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
