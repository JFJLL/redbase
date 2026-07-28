/**
 * Lightweight brand-data invalidation channel.
 *
 * Brand / personal-IP CRUD success paths call notifyBrandDataChanged(); data
 * consumers (the insights store used by trends/ideas) snapshot the version
 * when they cache a brand detail and drop the cache once the version moved,
 * so re-entering the trends page always re-fetches GET /api/brands/:id with
 * the latest knowledgeBase / product info / logo / persona fields.
 */

let counter = 0;
/** Version at the last "all brands" invalidation (no brandId provided). */
let allBrandsVersion = 0;
const brandVersions = new Map<number, number>();

/** Mark one brand (or all brands when id is missing) as changed. */
export function notifyBrandDataChanged(brandId?: number | null): void {
  counter += 1;
  const id = Number(brandId || 0);
  if (id > 0) {
    brandVersions.set(id, counter);
  } else {
    allBrandsVersion = counter;
  }
}

/**
 * Current invalidation version. Without a brandId this is the global counter
 * (used to snapshot "fresh as of now"); with a brandId it is the version of
 * the last change affecting that brand.
 */
export function getBrandDataVersion(brandId?: number | null): number {
  const id = Number(brandId || 0);
  if (!id) return counter;
  return Math.max(brandVersions.get(id) ?? 0, allBrandsVersion);
}

/** Test helper / account-switch reset. */
export function resetBrandDataVersions(): void {
  counter = 0;
  allBrandsVersion = 0;
  brandVersions.clear();
}
