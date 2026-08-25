export type NewSite = {
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  validFrom: number;
  validTo?: number;
};

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres (haversine). Exported so it can be tested directly. */
export function distanceMetres(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function createSite(sql: SqlStorage, input: NewSite): number {
  const row = sql
    .exec<{ id: number }>(
      `INSERT INTO sites (name, latitude, longitude, radius_m, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      input.name, input.latitude, input.longitude, input.radiusM,
      input.validFrom, input.validTo ?? null,
    )
    .one();
  return row.id;
}

/**
 * The nearest site whose radius contains the point at `at`, or null.
 *
 * Sites are few (one per 現場) so this scans the valid set rather than maintaining a spatial
 * index. Revisit only if site counts reach the thousands.
 */
export function matchSite(
  sql: SqlStorage,
  latitude: number,
  longitude: number,
  at: number,
): number | null {
  const candidates = sql
    .exec<{ id: number; latitude: number; longitude: number; radius_m: number }>(
      `SELECT id, latitude, longitude, radius_m FROM sites
       WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
      at, at,
    )
    .toArray();

  let best: { id: number; distance: number } | null = null;
  for (const site of candidates) {
    const distance = distanceMetres(latitude, longitude, site.latitude, site.longitude);
    if (distance > site.radius_m) continue;
    if (!best || distance < best.distance) best = { id: site.id, distance };
  }
  return best ? best.id : null;
}
