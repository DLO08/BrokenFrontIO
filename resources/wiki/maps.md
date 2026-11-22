# Custom maps

Alongside the hand-built maps, BrokenFront can build a playable map out of real
geography from [OpenStreetMap](https://www.openstreetmap.org/).

## Generating one

```bash
npm run gen-osm-map -- --bbox=-80.5,40.4,-71.8,45.1 --name="US Northeast"
cd map-generator && go run -tags nodynamic . --maps=usnortheast
```

The first command fetches the coastline, large lakes and administrative
boundaries inside the bounding box from the Overpass API and writes a map
image plus its manifest; the second compiles it the way every stock map is
compiled.

What you get out of the real data:

- land and water from the coastline;
- **one nation per state or region**, named after it, flagged by its country,
  and placed at the point farthest inside its own borders;
- **one named tribe per county-level area**.

`--size` sets the pixels on the long side, `--nations` and `--tribes` pick
which administrative levels become nations and tribes (2 = countries,
4 = states, 6 = counties, 8 = towns), and `--category` picks the map-picker
category. Map data © OpenStreetMap contributors, under the ODbL.

Uranium deposits are derived from a map's shape, so a generated map has a
stable, learnable set of deposits like any other.

## Status

Generating a map and playing it locally works today. **Hosting a generated map
in a multiplayer lobby does not yet** — the server-side bundle store, the
custom-map route and the lobby picker for them are still to come. Until then,
custom maps are for singleplayer and for the scenario editor.

See `docs/Maps.md` and `map-generator/README.md` in the repository for the map
format itself.
