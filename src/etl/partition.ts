/**
 * Which slice a place belongs to, decided once and agreed by both ends.
 *
 * The merge cannot hold the whole database in a 128MB isolate, so it works in
 * slices. That only helps if the *writer* slices the same way the *reader* does —
 * and the first version did not.
 *
 * ## What it cost to get this wrong
 *
 * `StageSources` wrote name files in the order it read them, and each
 * `BuildDatabase` partition then read **every** file and threw away nine tenths.
 * Ten partitions over 32.2MB of input meant 322MB of JSON parsed to do 32MB of
 * work — a tenfold waste, entirely invisible until the input grew.
 *
 * It stayed invisible because the first successful run was against a *limited*
 * stage: about 3MB of names, three seconds a partition. The full stage produced
 * 26.2MB, and the same code hit the **30-second CPU wall** and had its requests
 * killed. Two of them, with 416 subrequests across seven abandoned requests,
 * which is how the Product Owner found it in the dashboard.
 *
 * Now the writer partitions and the reader reads one file. The waste factor is 1.
 *
 * ## Why a hash of the id and not something more obvious
 *
 * Country would be uneven — India and the United States would each be a slice ten
 * times the size of the smallest. File offset would not be stable between runs, so
 * a resumed Workflow would redo work it had already done. Sequential id ranges
 * would clump, because GeoNames ids are allocated in blocks by region.
 *
 * A hash is even, stable across runs, and knowable without reading anything first
 * — which is what lets the writer and the reader agree without coordinating.
 */

/**
 * Ten slices.
 *
 * 69,700 cities and roughly a million names divide into ten pieces of a few
 * megabytes, comfortably inside a 128MB isolate with room for the JSON churn.
 *
 * A constant rather than a parameter, because it is baked into the object keys
 * the stage writes and the build reads. Changing it means restaging: a build that
 * partitioned differently from the stage would silently read the wrong slice and
 * produce a database missing nine tenths of its names.
 */
export const PARTITIONS = 10

/**
 * FNV-1a over the numeric part of the id.
 *
 * Chosen over `id % n` because GeoNames ids are allocated in regional blocks, so
 * the low digits clump — Thailand's ids share prefixes and would land unevenly.
 * A hash spreads them, and the measured slices come out within 4% of each other.
 */
export function partitionOf(placeId: string, partitions: number = PARTITIONS): number {
  const id = placeId.slice(placeId.indexOf(":") + 1)
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % partitions
}

/**
 * Where a partition's names live.
 *
 * One directory per run rather than one file per partition, because a stage
 * processes the source in slices of its own and each writes its share of every
 * partition. The build reads the whole prefix for its partition and nothing else.
 */
export const namesPrefix = (partition: number) => `stage/names/p${partition}/`
export const namesKey = (partition: number, sequence: number) =>
  `${namesPrefix(partition)}${String(sequence).padStart(3, "0")}.ndjson`
