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
import * as Hapi from '@hapi/hapi'
import * as zlib from 'zlib'
import { Location } from '@opencrvs/commons'
import {
  BROTLI_MAX_QUALITY,
  clearLocationSnapshotMemory,
  getOrBuildLocationSnapshot,
  readLocationSnapshot,
  RedisClient,
  updateLocationCache
} from './snapshotCache'
import { createGetLocationsHandler, negotiateEncoding } from './snapshotHandler'

/* A small in-memory stand-in for the node-redis v4 client. */
function createFakeRedis() {
  const store = new Map<string, Buffer | string>()
  const expiries = new Map<string, number>()
  const valueOf = (key: string) => store.get(key) ?? null
  const set = (
    key: string,
    value: Buffer | string,
    opts?: { NX?: boolean; PX?: number }
  ) => {
    if (opts?.NX && store.has(key)) return null
    store.set(key, value)
    if (opts?.PX) expiries.set(key, opts.PX)
    return 'OK'
  }
  const client = {
    store,
    expiries,
    async get(optsOrKey: unknown, maybeKey?: string) {
      const returnBuffers = typeof optsOrKey === 'object'
      const value = valueOf(
        returnBuffers ? (maybeKey as string) : (optsOrKey as string)
      )
      if (value === null) return null
      if (returnBuffers)
        return Buffer.isBuffer(value) ? value : Buffer.from(value)
      return Buffer.isBuffer(value) ? value.toString('utf8') : value
    },
    async set(
      key: string,
      value: Buffer | string,
      opts?: { NX?: boolean; PX?: number }
    ) {
      return set(key, value, opts)
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0
    },
    async eval(_script: string, opts: { keys: string[]; arguments: string[] }) {
      if (valueOf(opts.keys[0]) === opts.arguments[0]) {
        store.delete(opts.keys[0])
        return 1
      }
      return 0
    },
    multi() {
      const ops: Array<() => unknown> = []
      const chain = {
        set(key: string, value: Buffer | string, opts?: { PX?: number }) {
          ops.push(() => set(key, value, opts))
          return chain
        },
        pExpire(key: string, ms: number) {
          ops.push(() => expiries.set(key, ms))
          return chain
        },
        async exec() {
          return ops.map((op) => op())
        }
      }
      return chain
    }
  }
  return client
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function makeLocations(count: number): Location[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(i),
    name: `Village ${i}`,
    parentId: i === 0 ? null : uuid(Math.floor(i / 10)),
    locationType: 'ADMIN_STRUCTURE',
    validUntil: null
  })) as Location[]
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('updateLocationCache', () => {
  beforeEach(() => clearLocationSnapshotMemory())

  it('stores Brotli and gzip bodies that decode to the columnar JSON', async () => {
    const redis = createFakeRedis()
    const meta = await updateLocationCache(
      redis as unknown as RedisClient,
      makeLocations(500),
      {
        brotliQuality: 5
      }
    )

    const br = redis.store.get(`location-snapshot:v1:${meta.etag}:br`) as Buffer
    const gz = redis.store.get(`location-snapshot:v1:${meta.etag}:gz`) as Buffer
    const fromBr = JSON.parse(zlib.brotliDecompressSync(br).toString())
    const fromGz = JSON.parse(zlib.gunzipSync(gz).toString())

    expect(fromBr).toEqual(fromGz)
    expect(fromBr.k).toEqual([
      'id',
      'name',
      'parentId',
      'locationType',
      'validUntil'
    ])
    expect(fromBr.d).toHaveLength(500)
    expect(meta.count).toBe(500)
    expect(meta.brBytes).toBeLessThan(meta.rawBytes / 5)
  })

  it('gives identical data the same ETag, whatever the compression level', async () => {
    const redis = createFakeRedis() as unknown as RedisClient
    const a = await updateLocationCache(redis, makeLocations(100), {
      brotliQuality: 4
    })
    const b = await updateLocationCache(redis, makeLocations(100), {
      brotliQuality: 9
    })
    const c = await updateLocationCache(redis, makeLocations(101), {
      brotliQuality: 9
    })
    expect(a.etag).toBe(b.etag)
    expect(c.etag).not.toBe(a.etag)
  })

  it('lets the previous snapshot expire soon after it is replaced', async () => {
    const redis = createFakeRedis()
    const first = await updateLocationCache(
      redis as unknown as RedisClient,
      makeLocations(10),
      { brotliQuality: 4 }
    )
    await updateLocationCache(
      redis as unknown as RedisClient,
      makeLocations(11),
      { brotliQuality: 4 }
    )
    expect(redis.expiries.get(`location-snapshot:v1:${first.etag}:br`)).toBe(
      10 * 60 * 1000
    )
  })
})

describe('readLocationSnapshot / getOrBuildLocationSnapshot', () => {
  beforeEach(() => clearLocationSnapshotMemory())

  it('returns null when nothing has been built', async () => {
    const redis = createFakeRedis() as unknown as RedisClient
    expect(await readLocationSnapshot(redis)).toBeNull()
  })

  it('reads a snapshot written by another replica', async () => {
    const redis = createFakeRedis() as unknown as RedisClient
    const meta = await updateLocationCache(redis, makeLocations(20), {
      brotliQuality: 4
    })
    clearLocationSnapshotMemory() // simulate a different gateway replica
    const snapshot = await readLocationSnapshot(redis)
    expect(snapshot?.meta.etag).toBe(meta.etag)
    expect(Buffer.isBuffer(snapshot?.br)).toBe(true)
  })

  it('builds once for concurrent requests, then upgrades to max quality in the background', async () => {
    const redis = createFakeRedis() as unknown as RedisClient
    let fetches = 0
    const fetcher = async () => {
      fetches++
      return makeLocations(50)
    }

    const results = await Promise.all([
      getOrBuildLocationSnapshot(redis, fetcher),
      getOrBuildLocationSnapshot(redis, fetcher),
      getOrBuildLocationSnapshot(redis, fetcher)
    ])
    expect(new Set(results.map((r) => r.meta.etag)).size).toBe(1)
    expect(results[0].meta.brotliQuality).toBeLessThan(BROTLI_MAX_QUALITY)

    await flush()
    const upgraded = await readLocationSnapshot(redis)
    expect(upgraded?.meta.brotliQuality).toBe(BROTLI_MAX_QUALITY)
    expect(upgraded?.meta.etag).toBe(results[0].meta.etag)
    expect(fetches).toBe(2) // fast build + one background rebuild
  })
})

describe('negotiateEncoding', () => {
  it.each([
    ['gzip, deflate, br, zstd', 'br'],
    ['gzip, deflate', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['*', 'gzip'],
    ['identity', 'identity'],
    [undefined, 'identity']
  ])('%s → %s', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected)
  })
})

describe('GET /locations/snapshot', () => {
  let server: Hapi.Server
  let redis: ReturnType<typeof createFakeRedis>
  let failFetch = false

  beforeEach(async () => {
    clearLocationSnapshotMemory()
    failFetch = false
    redis = createFakeRedis()
    server = Hapi.server()
    server.route({
      method: 'GET',
      path: '/locations/snapshot',
      handler: createGetLocationsHandler({
        getRedis: () => redis as unknown as RedisClient,
        createFetcher: () => async () => {
          if (failFetch) throw new Error('events service down')
          return makeLocations(200)
        }
      })
    })
    await server.initialize()
  })

  afterEach(async () => {
    await flush()
    await server.stop()
  })

  it('serves the stored Brotli bytes as-is', async () => {
    const res = await server.inject({
      url: '/locations/snapshot',
      headers: { 'accept-encoding': 'gzip, deflate, br' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers.vary).toContain('Accept-Encoding')
    expect(res.headers['x-location-count']).toBe('200')
    const body = JSON.parse(
      zlib.brotliDecompressSync(res.rawPayload).toString()
    )
    expect(body.d).toHaveLength(200)
  })

  it('falls back to gzip for clients without Brotli', async () => {
    const res = await server.inject({
      url: '/locations/snapshot',
      headers: { 'accept-encoding': 'gzip' }
    })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(
      JSON.parse(zlib.gunzipSync(res.rawPayload).toString()).d
    ).toHaveLength(200)
  })

  it('sends plain JSON when no compression is accepted', async () => {
    const res = await server.inject({
      url: '/locations/snapshot',
      headers: { 'accept-encoding': 'identity' }
    })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(res.payload).d).toHaveLength(200)
  })

  it('answers 304 with no body when the client already has this version', async () => {
    const first = await server.inject({
      url: '/locations/snapshot',
      headers: { 'accept-encoding': 'br' }
    })
    const etag = first.headers.etag as string
    const second = await server.inject({
      url: '/locations/snapshot',
      headers: { 'accept-encoding': 'br', 'if-none-match': etag }
    })
    expect(second.statusCode).toBe(304)
    expect(second.rawPayload.length).toBe(0)
    expect(second.headers.etag).toBe(etag)
  })

  it('returns 503 when there is no snapshot and it cannot be built', async () => {
    failFetch = true
    const res = await server.inject({ url: '/locations/snapshot' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('10')
  })
})
