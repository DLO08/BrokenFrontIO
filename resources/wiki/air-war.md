# Air war

Air power is a separate layer from land and sea: aircraft fly over everything,
ignore terrain, and take no territory. They break things, move troops, and
shoot each other down.

Everything in the air flies from a base with a free slot — an **Airbase** on
land or an **Aircraft Carrier** at sea. No base, no sorties.

## Airbase

|            |                                           |
| ---------- | ----------------------------------------- |
| Cost       | 1M gold, rising 1M per base, capped at 3M |
| Build time | 15s                                       |
| Placement  | Your territory, like a city               |
| Slots      | 2 per level                               |
| Upgradable | Yes                                       |

## Aircraft Carrier

|           |                                              |
| --------- | -------------------------------------------- |
| Cost      | 2M gold, rising 2M per carrier, capped at 4M |
| Health    | 2500                                         |
| Slots     | 4, whatever its level                        |
| Placement | Open water; it sails from your nearest port  |

A mobile airbase. Move it like a warship — attack-click the carrier, then
attack-click where it should go — and it cruises around that spot. It carries
**no guns of its own**: warships and bombers sink it, and its own fighters are
its only defence.

## Fighters

Fighters are not built by hand. Every base keeps a standing patrol: while it
has fewer fighters than half its slots, it launches another every 15s and pays
150k gold for it. Fighters orbit their base, chase any enemy aircraft that
comes within 40 tiles, never stray more than 80 tiles from home, and die with
their base.

|        |                                                     |
| ------ | --------------------------------------------------- |
| Health | 300                                                 |
| Damage | 120 per burst, firing every 0.5s at 2 tiles         |
| Speed  | 3 tiles/tick — faster than anything else in the air |

Fighters are the answer to enemy bombers and paradrops. They do not touch
missiles; that is what SAMs are for.

## Bombers — "Air strike"

Right-click a target and pick **Air strike**. A bomber (400k gold) takes off
from your nearest base with a free slot within 250 tiles, flies to the target,
and inside a 10-tile radius:

- every enemy structure loses a level — a level-1 structure is destroyed;
- enemy ships take 400 damage;
- the owner of the land loses 4% of their troops, up to 25,000.

**Territory does not change hands.** The bomber then flies home and frees its
slot. Bombers are slow (2 tiles/tick) and unarmed: fighters and SAMs kill them
on the way in.

## Paradrops

Right-click and pick **Paradrop**. A transport plane (250k gold) takes off from
a base within 200 tiles carrying up to 20,000 troops per base level, and drops
them on the target as a bridgehead attack — exactly like a boat landing, but
over mountains, over water, and over a defended border. **Shot down, the troops
are lost**, so escort matters.

## Air defence

| Threat                    | Answer                  |
| ------------------------- | ----------------------- |
| Bombers, transport planes | Fighters, SAM Launchers |
| Missiles                  | SAM Launchers           |
| Carriers                  | Warships, bombers       |

SAM Launchers fire at enemy aircraft in range as well as at missiles, so a SAM
behind your front line now covers two kinds of attack.
