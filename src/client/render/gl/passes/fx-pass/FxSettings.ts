/**
 * Pure (no WebGL) helpers that turn the `settings.fx` slice into per-spawn
 * FX parameters. Kept out of the passes so they can be unit-tested.
 */

import {
  UT_ATOM_BOMB,
  UT_CLUSTER_WARHEAD,
  UT_HYDROGEN_BOMB,
  UT_LARGE_NUKE,
  UT_MIRV_WARHEAD,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";

/**
 * Visual explosion radius (shockwave / debris scatter — not the gameplay
 * damage radius) for a detonating unit type, or undefined for non-nukes.
 */
export function nukeExplosionRadius(
  fx: RenderSettings["fx"],
  unitType: string,
): number | undefined {
  switch (unitType) {
    case UT_ATOM_BOMB:
    // Each cluster warhead is an atom bomb (Config.nukeMagnitudes).
    case UT_CLUSTER_WARHEAD:
      return fx.nukeRadiusAtom;
    case UT_HYDROGEN_BOMB:
      return fx.nukeRadiusHydro;
    case UT_LARGE_NUKE:
      // Sits between the atom and hydrogen bombs, as its blast does.
      return (fx.nukeRadiusAtom + fx.nukeRadiusHydro) / 2;
    case UT_MIRV_WARHEAD:
      return fx.nukeRadiusMirv;
    // The cluster nuke's carrier never detonates itself; its warheads do.
    default:
      return undefined;
  }
}
