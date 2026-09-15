import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let layerControlPosition: GeoLibreMapControlPosition = "top-right";

export const maplibreLayerControlPlugin: GeoLibrePlugin = {
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.16.0",
  // The control itself only needs the shared style API, and both 2D engines
  // host it through the same LayerControlHost (packages/map). Left at the
  // MapLibre-only default, the plugin manager would deactivate this plugin on
  // a swap to Mapbox, which removes the control there and greys out this
  // entry under Plugins.
  engines: ["maplibre", "mapbox"],
  activeByDefault: true,
  activate: (app: GeoLibreAppAPI) => app.setBuiltInMapControlVisible("layer-control", true),
  deactivate: (app: GeoLibreAppAPI) => {
    app.setBuiltInMapControlVisible("layer-control", false);
  },
  getMapControlPosition: () => layerControlPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    layerControlPosition = position;
    return app.setBuiltInMapControlPosition("layer-control", position);
  },
};
