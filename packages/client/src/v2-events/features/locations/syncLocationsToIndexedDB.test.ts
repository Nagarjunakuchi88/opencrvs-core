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
import 'fake-indexeddb/auto'
import { vi } from 'vitest'
import { encodeLocationSnapshot, type Location } from '@opencrvs/commons/client'
import { OfflineDatabase } from './offlineDb'
import {
  LocationSyncError,
  syncLocationsToIndexedDB
} from './syncLocationsToIndexedDB'

vi.mock('@client/utils/authUtils', () => ({ getToken: () => 'user-token' }))

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function makeLocations(count: number, prefix = 'Village'): Location[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(i),
    name: `${prefix} ${i}`,
    parentId: i === 0 ? null : uuid(Math.floor(i / 10)),
    locationType: 'ADMIN_STRUCTURE',
    validUntil: null
  })) as Location[]
}

function jsonResponse(body: unknown, etag = 'etag-1', status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: `"${etag}"` }
  })
}

let db: OfflineDatabase
let fetchMock: ReturnType<typeof vi.fn>
let dbCounter = 0

beforeEach(() => {
  db = new OfflineDatabase(`test-offline-${dbCounter++}`)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await db.delete()
})

describe('syncLocationsToIndexedDB', () => {
  it('unpacks the columnar payload and stores every location', async () => {
    const locations = makeLocations(250)
    fetchMock.mockResolvedValue(jsonResponse(encodeLocationSnapshot(locations)))

    const result = await syncLocationsToIndexedDB('/locations/snapshot', {
      db,
      bulkChunkSize: 100 // exercise several bulkAdd calls in one transaction
    })

    expect(result).toMatchObject({
      status: 'updated',
      etag: 'etag-1',
      count: 250
    })
    expect(await db.locations.count()).toBe(250)
    expect(await db.locations.get(uuid(123))).toEqual(locations[123])
    expect(await db.locations.where('parentId').equals(uuid(1)).count()).toBe(
      10
    )
  })

  it('sends the token and the stored ETag, and skips the download on 304', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(10)))
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const result = await syncLocationsToIndexedDB('/locations/snapshot', { db })

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer user-token')
    expect(headers['If-None-Match']).toBe('"etag-1"')
    expect(result).toEqual({ status: 'unchanged', etag: 'etag-1', count: 10 })
    expect(await db.locations.count()).toBe(10)
  })

  it('replaces old data completely with the new snapshot', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(30, 'Old')), 'v1')
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(20, 'New')), 'v2')
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    expect(await db.locations.count()).toBe(20)
    expect((await db.locations.get(uuid(5)))?.name).toBe('New 5')
    expect((await db.syncMeta.get('locations'))?.etag).toBe('v2')
  })

  it('keeps the previous data if the new payload is invalid', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(15)))
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ v: 99, k: [], d: [] }, 'bad')
    )
    await expect(
      syncLocationsToIndexedDB('/locations/snapshot', { db, force: true })
    ).rejects.toMatchObject({ kind: 'INVALID_PAYLOAD' })

    expect(await db.locations.count()).toBe(15)
  })

  it('rolls back the whole transaction if an insert fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(15)))
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    // Duplicate id in the third chunk: the first two chunks were already added
    const withDuplicate = makeLocations(60)
    withDuplicate[45] = { ...withDuplicate[45], id: withDuplicate[0].id }
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(withDuplicate), 'dup')
    )
    await expect(
      syncLocationsToIndexedDB('/locations/snapshot', {
        db,
        force: true,
        bulkChunkSize: 20
      })
    ).rejects.toMatchObject({ kind: 'STORAGE' })

    expect(await db.locations.count()).toBe(15)
    expect((await db.syncMeta.get('locations'))?.etag).toBe('etag-1')
  })

  it('downloads again if the table does not match the stored ETag', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(10)))
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })
    await db.locations.clear() // e.g. storage partly evicted

    fetchMock.mockResolvedValueOnce(
      jsonResponse(encodeLocationSnapshot(makeLocations(10)))
    )
    await syncLocationsToIndexedDB('/locations/snapshot', { db })

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(headers['If-None-Match']).toBeUndefined()
    expect(await db.locations.count()).toBe(10)
  })

  it.each([
    [401, 'UNAUTHORIZED'],
    [500, 'HTTP'],
    [503, 'HTTP']
  ])('reports HTTP %i as %s', async (status, kind) => {
    fetchMock.mockResolvedValue(new Response('', { status }))
    const error = await syncLocationsToIndexedDB('/x', { db }).catch((e) => e)
    expect(error).toBeInstanceOf(LocationSyncError)
    expect(error).toMatchObject({ kind, status })
  })

  it('reports network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(syncLocationsToIndexedDB('/x', { db })).rejects.toMatchObject({
      kind: 'NETWORK'
    })
  })

  it('reports an aborted sync', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(syncLocationsToIndexedDB('/x', { db })).rejects.toMatchObject({
      kind: 'ABORTED'
    })
  })
})
