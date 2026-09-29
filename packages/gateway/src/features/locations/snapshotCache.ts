/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * OpenCRVS is also distributed under the terms of the Civil Registration
 * & Healthcare Disclaimer located at http://opencrvs.org/license.
 *
 * Copyright (C) The OpenCRVS Authors located at https://github.com/opencrvs/opencrvs-core/blob/master/AUTHORS.
 */
import { createHash, randomUUID } from 'crypto'
import { promisify } from 'util'
import * as zlib from 'zlib'
import { commandOptions, createClient } from 'redis'
import {
  encodeLocationSnapshot,
  LOCATION_SNAPSHOT_VERSION,
  Location,
  logger
} from '@opencrvs/commons'

/**
 * Pre-compressed snapshot of the full location list.
 *
 * Built once (when locations change), stored in Redis as raw binary, and
 * served byte-for-byte on every request: no JSON parsing, serialising or
 * compression happens on the request path.
 *
 * Redis layout (content-addressed, so a reader can never pair new metadata
 * with an old body):
 *   location-snapshot:v1:meta          JSON  SnapshotMeta
 *   location-snapshot:v1:<etag>:br     bytes Brotli body
 *   location-snapshot:v1:<etag>:gz     bytes gzip body (clients without br)
 *   location-snapshot:v1:rebuild-lock  string, SET NX lock for rebuilds
 *
 * The prefix deliberately does not start with "locations:" so the existing
 * bustLocationsCache() (KEYS locations:*) never deletes it.
 */
export type RedisClient = ReturnType<typeof createClient>

const PREFIX = `location-snapshot:v${LOCATION_SNAPSHOT_VERSION}`
const META_KEY = `${PREFIX}:meta`
const LOCK_KEY = `${PREFIX}:rebuild-lock`
const bodyKey = (etag: string, encoding: StoredEncoding) =>
  `${PREFIX}:${etag}:${encoding}`

/** Bodies outlive their metadata a little so in-flight readers can finish. */
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SUPERSEDED_BODY_TTL_MS = 10 * 60 * 1000
const REBUILD_LOCK_TTL_MS = 5 * 60 * 1000
/** Rebuild in the background if the snapshot is older than this. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000
/** How long a replica trusts its in-memory copy before re-checking Redis. */
const MEMORY_RECHECK_MS = 5 * 1000

/** Quality 11 is the smallest output but costs ~10–15 s of CPU for 100k rows. */
export const BROTLI_MAX_QUALITY = 11
/** Used when a request finds no snapshot at all: ~0.2 s, ~10% larger. */
export const BROTLI_FAST_QUALITY = 5

export type StoredEncoding = 'br' | 'gz'

export interface SnapshotMeta {
  version: typeof LOCATION_SNAPSHOT_VERSION
  /** sha256 of the uncompressed JSON: identical data ⇒ identical ETag. */
  etag: string
  count: number
  rawBytes: number
  brBytes: number
  gzBytes: number
  brotliQuality: number
  builtAt: string
}

export interface LocationSnapshotBodies {
  meta: SnapshotMeta
  br: Buffer
  gz: Buffer
}

export class LocationSnapshotError extends Error {
  readonly cause?: unknown
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'LocationSnapshotError'
    this.cause = options?.cause
  }
}

const brotliCompress = promisify(zlib.brotliCompress)
const gzipCompress = promisify(zlib.gzip)

/**
 * Runs on libuv's thread pool (async zlib), so even quality 11 does not
 * block the gateway's event loop.
 */
function compressBrotli(input: Buffer, quality: number): Promise<Buffer> {
  return brotliCompress(input, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      // Largest window (16 MB): the whole payload fits, so repeats across
      // the entire list can be referenced.
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_MAX_WINDOW_BITS
    }
  })
}

function isSnapshotMeta(value: unknown): value is SnapshotMeta {
  if (typeof value !== 'object' || value === null) return false
  const meta = value as Record<string, unknown>
  return (
    meta.version === LOCATION_SNAPSHOT_VERSION &&
    typeof meta.etag === 'string' &&
    typeof meta.count === 'number' &&
    typeof meta.brBytes === 'number' &&
    typeof meta.gzBytes === 'number' &&
    typeof meta.brotliQuality === 'number' &&
    typeof meta.builtAt === 'string'
  )
}

/**
 * Converts locations to the columnar format, compresses it (Brotli + gzip
 * fallback) and stores the binary bodies and metadata in Redis.
 */
export async function updateLocationCache(
  redisClient: RedisClient,
  locations: ReadonlyArray<Location>,
  options: { brotliQuality?: number } = {}
): Promise<SnapshotMeta> {
  const brotliQuality = options.brotliQuality ?? BROTLI_MAX_QUALITY
  const started = Date.now()

  const raw = Buffer.from(
    JSON.stringify(encodeLocationSnapshot(locations)),
    'utf8'
  )
  const etag = createHash('sha256').update(raw).digest('base64url').slice(0, 27)

  let br: Buffer
  let gz: Buffer
  try {
    ;[br, gz] = await Promise.all([
      compressBrotli(raw, brotliQuality),
      gzipCompress(raw, { level: 9 })
    ])
  } catch (error) {
    throw new LocationSnapshotError('Failed to compress location snapshot', {
      cause: error
    })
  }

  const meta: SnapshotMeta = {
    version: LOCATION_SNAPSHOT_VERSION,
    etag,
    count: locations.length,
    rawBytes: raw.length,
    brBytes: br.length,
    gzBytes: gz.length,
    brotliQuality,
    builtAt: new Date().toISOString()
  }

  try {
    const previous = await readMeta(redisClient)

    // Bodies first, metadata last: readers only ever see complete snapshots.
    await redisClient
      .multi()
      .set(bodyKey(etag, 'br'), br, { PX: SNAPSHOT_TTL_MS })
      .set(bodyKey(etag, 'gz'), gz, { PX: SNAPSHOT_TTL_MS })
      .set(META_KEY, JSON.stringify(meta), { PX: SNAPSHOT_TTL_MS })
      .exec()

    if (previous && previous.etag !== etag) {
      await redisClient
        .multi()
        .pExpire(bodyKey(previous.etag, 'br'), SUPERSEDED_BODY_TTL_MS)
        .pExpire(bodyKey(previous.etag, 'gz'), SUPERSEDED_BODY_TTL_MS)
        .exec()
    }
  } catch (error) {
    throw new LocationSnapshotError('Failed to store location snapshot', {
      cause: error
    })
  }

  memory = { meta, br, gz, checkedAt: Date.now() }

  logger.info(
    `Location snapshot built: ${meta.count} locations, ` +
      `${kb(meta.rawBytes)} raw → ${kb(meta.brBytes)} br(q${brotliQuality}) / ` +
      `${kb(meta.gzBytes)} gzip in ${Date.now() - started} ms`
  )
  return meta
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

async function readMeta(
  redisClient: RedisClient
): Promise<SnapshotMeta | null> {
  const json = await redisClient.get(META_KEY)
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return isSnapshotMeta(parsed) ? parsed : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

interface MemorySnapshot extends LocationSnapshotBodies {
  checkedAt: number
}

/** Per-replica copy, so most requests don't transfer the body from Redis. */
let memory: MemorySnapshot | null = null

/** Test helper. */
export function clearLocationSnapshotMemory() {
  memory = null
}

/**
 * Returns the current snapshot, or null if none has been built yet.
 * Cost per request: nothing (memory hit), one small GET (meta unchanged),
 * or one GET of ~2 MB (new snapshot on another replica).
 */
export async function readLocationSnapshot(
  redisClient: RedisClient
): Promise<LocationSnapshotBodies | null> {
  if (memory && Date.now() - memory.checkedAt < MEMORY_RECHECK_MS) {
    return memory
  }

  const meta = await readMeta(redisClient)
  if (!meta) return null

  if (
    memory &&
    memory.meta.etag === meta.etag &&
    memory.meta.brotliQuality === meta.brotliQuality
  ) {
    memory.checkedAt = Date.now()
    return memory
  }

  const asBuffer = commandOptions({ returnBuffers: true })
  const [br, gz] = await Promise.all([
    redisClient.get(asBuffer, bodyKey(meta.etag, 'br')),
    redisClient.get(asBuffer, bodyKey(meta.etag, 'gz'))
  ])
  if (!br || !gz) {
    logger.warn(`Location snapshot ${meta.etag} metadata found without body`)
    return null
  }

  memory = { meta, br, gz, checkedAt: Date.now() }
  return memory
}

/* ------------------------------------------------------------------ */
/* Building                                                           */
/* ------------------------------------------------------------------ */

export type LocationFetcher = () => Promise<Location[]>

let inFlightBuild: Promise<LocationSnapshotBodies> | null = null

/**
 * Used by the request handler. Serves the cached snapshot; if there is
 * none (first start, Redis flushed), builds one quickly for this request
 * and schedules the smaller quality-11 build in the background.
 * Concurrent requests on the same replica share one build.
 */
export async function getOrBuildLocationSnapshot(
  redisClient: RedisClient,
  fetchLocations: LocationFetcher
): Promise<LocationSnapshotBodies> {
  const cached = await readLocationSnapshot(redisClient)
  if (cached) {
    const age = Date.now() - Date.parse(cached.meta.builtAt)
    if (
      age > MAX_SNAPSHOT_AGE_MS ||
      cached.meta.brotliQuality < BROTLI_MAX_QUALITY
    ) {
      scheduleLocationSnapshotRebuild(redisClient, fetchLocations, 'upgrade')
    }
    return cached
  }

  if (!inFlightBuild) {
    inFlightBuild = (async () => {
      const locations = await fetchLocations()
      const meta = await updateLocationCache(redisClient, locations, {
        brotliQuality: BROTLI_FAST_QUALITY
      })
      const built = memory
      if (!built || built.meta.etag !== meta.etag) {
        throw new LocationSnapshotError('Snapshot missing after build')
      }
      return built
    })().finally(() => {
      inFlightBuild = null
    })
  }
  const built = await inFlightBuild
  scheduleLocationSnapshotRebuild(redisClient, fetchLocations, 'upgrade')
  return built
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`

const PENDING_KEY = `${PREFIX}:rebuild-pending`

/**
 * Rebuilds at full quality in the background. A Redis lock ensures only
 * one gateway replica does the (CPU-heavy) work at a time. If a rebuild is
 * requested while another one is running (e.g. locations changed again),
 * a "pending" flag makes the running rebuild go round once more, so the
 * latest data always ends up cached. Never throws.
 */
export function scheduleLocationSnapshotRebuild(
  redisClient: RedisClient,
  fetchLocations: LocationFetcher,
  reason: 'locations-changed' | 'upgrade' = 'locations-changed'
): void {
  void (async () => {
    const lockToken = randomUUID()
    try {
      const acquired = await redisClient.set(LOCK_KEY, lockToken, {
        NX: true,
        PX: REBUILD_LOCK_TTL_MS
      })
      if (acquired !== 'OK') {
        // Only a data change needs another pass; a quality upgrade is
        // already being done by whoever holds the lock.
        if (reason === 'locations-changed') {
          await redisClient.set(PENDING_KEY, '1', { PX: REBUILD_LOCK_TTL_MS })
        }
        return
      }

      try {
        let again = true
        while (again) {
          await redisClient.del(PENDING_KEY)
          const locations = await fetchLocations()
          await updateLocationCache(redisClient, locations, {
            brotliQuality: BROTLI_MAX_QUALITY
          })
          again = (await redisClient.exists(PENDING_KEY)) === 1
        }
      } finally {
        await redisClient.eval(RELEASE_LOCK_SCRIPT, {
          keys: [LOCK_KEY],
          arguments: [lockToken]
        })
      }
    } catch (error) {
      logger.error(
        `Location snapshot rebuild failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`
      )
    }
  })()
}
