import type { TownLayout, TownPoi } from './types';

// The neighbourhood you walk your dog around. Streets form a grid:
// intersection (i, j) sits at x = i * pitch, z = j * pitch, for i in 0..cols and j in 0..rows.
// Block (c, r) is the square between intersections (c, r) and (c + 1, r + 1).
// North is -Z, south is +Z, east is +X, west is -X.

export const TOWN: TownLayout = {
  cols: 5,
  rows: 4,
  block: 24,
  street: 12,
  sidewalk: 2.6,
  pois: [
    { kind: 'home', col: 0, row: 1, side: 'e', name: 'Home' },
    { kind: 'park', col: 2, row: 1, side: 's', name: 'Park' },
    { kind: 'shop', col: 1, row: 2, side: 'n', name: 'Pet Supply' },
    { kind: 'gym', col: 3, row: 0, side: 's', name: 'Gym' },
    { kind: 'kennel', col: 4, row: 2, side: 'w', name: 'Kennel' },
    { kind: 'secondhand', col: 3, row: 3, side: 'n', name: 'Secondhand Shop' },
  ],
};

export function pitch(l: TownLayout = TOWN) {
  return l.block + l.street;
}

export function intersection(i: number, j: number, l: TownLayout = TOWN) {
  const p = pitch(l);
  return { x: i * p, z: j * p };
}

export function blockRect(c: number, r: number, l: TownLayout = TOWN) {
  const p = pitch(l);
  const h = l.street / 2;
  return { minX: c * p + h, maxX: (c + 1) * p - h, minZ: r * p + h, maxZ: (r + 1) * p - h };
}

/** The street edge (pair of intersections) a POI's entrance faces. */
export function poiEdge(poi: TownPoi): [[number, number], [number, number]] {
  const { col: c, row: r } = poi;
  switch (poi.side) {
    case 'n': return [[c, r], [c + 1, r]];
    case 's': return [[c, r + 1], [c + 1, r + 1]];
    case 'w': return [[c, r], [c, r + 1]];
    case 'e': return [[c + 1, r], [c + 1, r + 1]];
  }
}

/** Point on the sidewalk in front of the POI entrance. */
export function poiEntrance(poi: TownPoi, l: TownLayout = TOWN) {
  const rect = blockRect(poi.col, poi.row, l);
  const cx = (rect.minX + rect.maxX) / 2, cz = (rect.minZ + rect.maxZ) / 2;
  const s = l.sidewalk / 2;
  switch (poi.side) {
    case 'n': return { x: cx, z: rect.minZ - s };
    case 's': return { x: cx, z: rect.maxZ + s };
    case 'w': return { x: rect.minX - s, z: cz };
    case 'e': return { x: rect.maxX + s, z: cz };
  }
}

export function findPoi(kind: TownPoi['kind'], l: TownLayout = TOWN) {
  return l.pois.find((p) => p.kind === kind)!;
}
