import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { distanceMetres } from "../src/store/sites.js";

const APR = Date.parse("2026-04-01T00:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");

// Tokyo Station and a point ~400m away.
const STATION = { lat: 35.6812, lon: 139.7671 };
const NEARBY = { lat: 35.6848, lon: 139.7671 };

let store: ReturnType<typeof env.KINTAI_STORE.getByName>;
let seq = 0;

beforeEach(() => {
  store = env.KINTAI_STORE.getByName(`sites-${seq++}`);
});

describe("distanceMetres", () => {
  it("returns zero for the same point", () => {
    expect(distanceMetres(STATION.lat, STATION.lon, STATION.lat, STATION.lon)).toBeCloseTo(0, 5);
  });

  it("measures a short north-south offset to within a few metres", () => {
    const d = distanceMetres(STATION.lat, STATION.lon, NEARBY.lat, NEARBY.lon);
    expect(d).toBeGreaterThan(380);
    expect(d).toBeLessThan(420);
  });
});

describe("matchSite", () => {
  it("matches a point inside the radius and not one outside it", async () => {
    const site = await store.createSite({
      name: "現場A", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 500, validFrom: APR,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, OCT)).toBe(site);
    expect(await store.matchSite(NEARBY.lat, NEARBY.lon, OCT)).toBe(site);
    // 5km north is outside.
    expect(await store.matchSite(STATION.lat + 0.045, STATION.lon, OCT)).toBeNull();
  });

  it("ignores a site whose validity window has closed", async () => {
    await store.createSite({
      name: "現場B", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 500, validFrom: APR, validTo: OCT,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, APR + 1)).not.toBeNull();
    expect(await store.matchSite(STATION.lat, STATION.lon, OCT + 1)).toBeNull();
  });

  it("picks the nearest when radii overlap", async () => {
    await store.createSite({
      name: "far", latitude: STATION.lat + 0.003, longitude: STATION.lon,
      radiusM: 5000, validFrom: APR,
    });
    const near = await store.createSite({
      name: "near", latitude: STATION.lat, longitude: STATION.lon,
      radiusM: 5000, validFrom: APR,
    });

    expect(await store.matchSite(STATION.lat, STATION.lon, OCT)).toBe(near);
  });
});
