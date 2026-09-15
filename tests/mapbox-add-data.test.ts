import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMTilesLayerControl } from "maplibre-gl-components";
import { adaptMapboxPMTilesControl } from "../packages/plugins/src/plugins/mapbox-pmtiles-control";
import { compileMapboxLayer, isMapboxSupportedLayer } from "../packages/map/src/mapbox-layers";
import { createPMTilesStoreLayer } from "../packages/map/src/pmtiles-layer";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { supportsAddDataRenderer } from "../apps/geolibre-desktop/src/lib/add-data-renderer";
import { applyTilesetAltitudeOffset } from "../packages/plugins/src/plugins/tiles-altitude-offset";

const url = "https://example.com/tiles.pmtiles";
describe("Mapbox Add Data adapters", () => {
  it("compiles selected archive layers with independent sources and editable styles", () => {
    const layer = createPMTilesStoreLayer({
      id: "roads",
      name: "Roads",
      url,
      tileType: "vector",
      sourceLayers: ["roads"],
      opacity: 0.4,
    });
    const plan = compileMapboxLayer(layer);
    assert.deepEqual(plan.source, { type: "vector", url });
    assert.equal(plan.layers.length, 3);
    assert.ok(
      plan.layers.every((spec) => "source-layer" in spec && spec["source-layer"] === "roads"),
    );
    assert.equal(plan.layers.find((spec) => spec.type === "line")?.paint?.["line-opacity"], 0.4);
    assert.ok(
      compileMapboxLayer({ ...layer, visible: false }).layers.every(
        (spec) => spec.layout?.visibility === "none",
      ),
    );
    assert.notEqual(compileMapboxLayer({ ...layer, id: "buildings" }).sourceId, plan.sourceId);
    for (const patch of [
      { source: { ...layer.source, tileType: "raster" } },
      { source: { ...layer.source, url: "blob:local" } },
    ]) {
      assert.equal(isMapboxSupportedLayer({ ...layer, ...patch }), false);
    }
  });
  it("routes the real PMTiles panel through the host without adding native layers", async () => {
    const control = new PMTilesLayerControl();
    const fitted: number[][] = [];
    const state = control.getState();
    // update() is the public entry used by programmatic imports.
    control.update({ defaultOpacity: 0.6 });
    adaptMapboxPMTilesControl(
      control,
      {
        fitBounds: (bounds) => {
          fitted.push(bounds);
        },
      },
      async () => ({
        tileType: "vector",
        sourceLayers: ["roads", "buildings"],
        bounds: [-1, -2, 3, 4],
        minZoom: 0,
        maxZoom: 14,
      }),
    );
    const events: string[] = [];
    control.on("layeradd", (event) => {
      events.push(event.layerId!);
    });
    await control.addLayer(url);
    assert.equal(events.length, 1);
    assert.equal(control.getState().layers[0].tileType, "vector");
    assert.deepEqual(control.getState().layers[0].layerIds, []);
    assert.deepEqual(fitted, [[-1, -2, 3, 4]]);
    assert.equal(state.loading, false);
    await control.addLayer("blob:unsupported");
    assert.match(control.getState().error ?? "", /remote vector/);
    assert.equal(events.length, 1);
    // Overlapping requests run one at a time, each reporting its own outcome
    // to the caller that awaits it.
    const failed = control.addLayer("blob:other");
    const added = control.addLayer(url);
    await failed;
    assert.match(control.getState().error ?? "", /remote vector/);
    await added;
    assert.equal(control.getState().error, null);
    assert.equal(events.length, 2);
  });
  it("only recognizes supported plugin source kinds, rather than all custom layers", () => {
    for (const [type, sourceKind] of [
      ["lidar", "lidar-url"],
      ["3d-tiles", "3d-tiles-url"],
    ] as const) {
      const layer = {
        ...geojsonLayer(),
        geojson: undefined,
        type,
        source: { url: "https://example.com/data" },
        metadata: { externalNativeLayer: true, sourceKind },
      };
      assert.equal(isMapboxSupportedLayer(layer), true);
      assert.equal(
        isMapboxSupportedLayer({
          ...layer,
          metadata: { externalNativeLayer: true, sourceKind: "unknown-plugin" },
        }),
        false,
      );
    }
    for (const id of ["pmtiles", "lidar", "3d-tiles"])
      assert.equal(supportsAddDataRenderer(id, "mapbox"), true);
    assert.equal(supportsAddDataRenderer("splatting", "mapbox"), false);
  });
  it("moves the tile traversal bounds along the geodetic surface normal", () => {
    let translated: number[] | undefined;
    let selected = false;
    const original = {
      clone: () => ({
        translate: (offset: number[]) => {
          translated = offset;
          return original;
        },
      }),
    };
    const tileset = {
      cartographicCenter: [0, 0, 50],
      modelMatrix: original,
      selectTiles: async () => {
        selected = true;
      },
    };
    applyTilesetAltitudeOffset(tileset, -300);
    assert.deepEqual(translated, [-300, -0, -0]);
    assert.equal(selected, true);
  });
});
