import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { RASTER_SOURCE_KIND, readRasterWindow } from "@geolibre/plugins";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { stretchSamples, viewportRange } from "../lib/viewport-stretch";

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
          layer.metadata.sourceKind === RASTER_SOURCE_KIND &&
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

/**
 * Fingerprint of everything that changes what the auto stretch should compute:
 * whether it is on, which method it uses, and which band it reads. The store
 * subscription re-runs when this changes, and an in-flight read discards its
 * result when it no longer matches, so switching band re-reads immediately
 * instead of leaving the old band's range applied until the next camera move.
 */
function viewportStretchSettings(layer: { metadata: Record<string, unknown> } | undefined): string {
  const state = layer?.metadata.rasterState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  const value = state as Record<string, unknown>;
  return [
    value.viewportStretchAuto === true,
    String(value.viewportStretchMethod ?? "minmax"),
    readBand(value),
  ].join(":");
}

/** The band the raster state selects, defaulting to the first. */
function readBand(state: Record<string, unknown>): number {
  return Array.isArray(state.bands) && typeof state.bands[0] === "number" ? state.bands[0] : 1;
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
    const band = readBand(raw);
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
    const values = stretchSamples(reading);
    if (values.length === 0) return;
    const range = viewportRange(values, method);
    if (range[0] >= range[1]) return;
    const current = useAppStore.getState().layers.find((item) => item.id === layerId);
    if (!current || viewportStretchSettings(current) !== viewportStretchSettings(layer)) return;
    const currentState =
      (current.metadata.rasterState as Record<string, unknown> | undefined) ?? {};
    // Panning over uniform ground recomputes the same range on every camera
    // idle. Writing it back anyway would mark the project dirty and push an
    // undo entry per idle, so only commit a range that actually moved.
    if (sameRange(currentState.rescale, range)) return;
    useAppStore.getState().updateLayer(layerId, {
      metadata: {
        ...current.metadata,
        rasterState: {
          ...currentState,
          rescale: [range],
        },
      },
    });
  } finally {
    if (requests.get(layerId) === controller) requests.delete(layerId);
  }
}

/** Whether the stored rescale already holds exactly the computed range. */
function sameRange(stored: unknown, range: [number, number]): boolean {
  if (!Array.isArray(stored) || stored.length !== 1) return false;
  const first = stored[0];
  return Array.isArray(first) && first[0] === range[0] && first[1] === range[1];
}
