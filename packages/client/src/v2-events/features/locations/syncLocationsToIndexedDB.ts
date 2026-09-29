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
import {
  decodeLocationSnapshot,
  LocationSnapshotFormatError
} from '@opencrvs/commons/client'
import { getToken } from '@client/utils/authUtils'
import { LocationRecord, offlineDb, OfflineDatabase } from './offlineDb'

const SYNC_META_KEY = 'locations'
/** Rows per bulkAdd call. All chunks run in ONE transaction (all-or-nothing). */
const BULK_CHUNK_SIZE = 10_000

export type LocationSyncErrorKind =
  | 'UNAUTHORIZED'
  | 'HTTP'
  | 'NETWORK'
  | 'ABORTED'
  | 'INVALID_PAYLOAD'
  | 'STORAGE'

export class LocationSyncError extends Error {
  readonly kind: LocationSyncErrorKind
  readonly status?: number
  readonly cause?: unknown

  constructor(
    kind: LocationSyncErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {}
  ) {
    super(message)
    this.name = 'LocationSyncError'
    this.kind = kind
    this.status = options.status
    this.cause = options.cause
  }
}

export type LocationSyncResult =
  | { status: 'unchanged'; etag: string; count: number }
  | {
      status: 'updated'
      etag: string | null
      count: number
      durationMs: number
    }

export interface SyncLocationsOptions {
  /** Defaults to the logged-in user's token. */
  token?: string
  signal?: AbortSignal
  /** Ignore the stored ETag and always download. */
  force?: boolean
  /** For tests. */
  db?: OfflineDatabase
  /** Rows per bulkAdd call (default 10,000). */
  bulkChunkSize?: number
}

/**
 * Downloads the full location list and replaces the offline copy.
 *
 * - Sends the stored ETag as If-None-Match: when nothing changed the server
 *   answers 304 with an empty body, so repeat logins cost a few bytes.
 * - The response is Brotli/gzip-encoded; the browser decompresses it
 *   transparently before res.json().
 * - Clear + insert happen in a single readwrite transaction: if anything
 *   fails, the previous offline data is kept unchanged.
 */
export async function syncLocationsToIndexedDB(
  apiEndpoint: string,
  options: SyncLocationsOptions = {}
): Promise<LocationSyncResult> {
  const db = options.db ?? offlineDb
  const chunkSize = options.bulkChunkSize ?? BULK_CHUNK_SIZE
  const started = performance.now()

  const [stored, storedCount] = await Promise.all([
    db.syncMeta.get(SYNC_META_KEY),
    db.locations.count()
  ])
  // Only trust the ETag if the table actually holds that snapshot.
  const knownEtag =
    !options.force && stored && storedCount === stored.count
      ? stored.etag
      : undefined

  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = options.token ?? getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (knownEtag) headers['If-None-Match'] = `"${knownEtag}"`

  let response: Response
  try {
    response = await fetch(apiEndpoint, {
      method: 'GET',
      headers,
      signal: options.signal,
      // We validate with ETags ourselves; don't let the HTTP cache interfere.
      cache: 'no-store'
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LocationSyncError('ABORTED', 'Location sync was aborted', {
        cause: error
      })
    }
    throw new LocationSyncError('NETWORK', 'Could not reach the server', {
      cause: error
    })
  }

  if (response.status === 304 && stored && knownEtag) {
    return { status: 'unchanged', etag: stored.etag, count: stored.count }
  }
  if (response.status === 401) {
    throw new LocationSyncError('UNAUTHORIZED', 'Session expired', {
      status: 401
    })
  }
  if (!response.ok) {
    throw new LocationSyncError(
      'HTTP',
      `Location sync failed with HTTP ${response.status}`,
      { status: response.status }
    )
  }

  let locations: LocationRecord[]
  try {
    locations = decodeLocationSnapshot(await response.json())
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LocationSyncError('ABORTED', 'Location sync was aborted', {
        cause: error
      })
    }
    const detail =
      error instanceof LocationSnapshotFormatError
        ? error.message
        : 'Response is not valid JSON'
    throw new LocationSyncError('INVALID_PAYLOAD', detail, { cause: error })
  }

  const etag =
    response.headers.get('ETag')?.replace(/^W\//, '').replace(/"/g, '') ?? null

  try {
    await db.transaction('rw', db.locations, db.syncMeta, async () => {
      await db.locations.clear()
      for (let i = 0; i < locations.length; i += chunkSize) {
        await db.locations.bulkAdd(locations.slice(i, i + chunkSize))
      }
      if (etag) {
        await db.syncMeta.put({
          key: SYNC_META_KEY,
          etag,
          count: locations.length,
          syncedAt: new Date().toISOString()
        })
      } else {
        await db.syncMeta.delete(SYNC_META_KEY)
      }
    })
  } catch (error) {
    // Dexie rolled the transaction back: the previous data is still there.
    throw new LocationSyncError(
      'STORAGE',
      `Could not save locations offline: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }

  return {
    status: 'updated',
    etag,
    count: locations.length,
    durationMs: Math.round(performance.now() - started)
  }
}
