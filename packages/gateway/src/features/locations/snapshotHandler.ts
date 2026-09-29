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
import { promisify } from 'util'
import { gunzip as gunzipCb } from 'zlib'
import { logger } from '@opencrvs/commons'
import {
  getOrBuildLocationSnapshot,
  LocationFetcher,
  LocationSnapshotBodies,
  RedisClient
} from './snapshotCache'

const gunzip = promisify(gunzipCb)

export type ResponseEncoding = 'br' | 'gzip' | 'identity'

/**
 * Picks the best encoding the client accepts. Honours "q=0" (explicitly
 * refused). Browsers send "gzip, deflate, br[, zstd]" over HTTPS.
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined
): ResponseEncoding {
  const accepted = new Set<string>()
  for (const part of (acceptEncoding ?? '').split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';')
    if (!token) continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    if (q !== undefined && Number(q.slice(2)) === 0) continue
    accepted.add(token)
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip'
  return 'identity'
}

/** ETag comparison per RFC 9110 (weak comparison, list and "*" allowed). */
function matchesIfNoneMatch(header: string | undefined, etag: string) {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(`"${etag}"`)
}

export interface GetLocationsHandlerDeps {
  getRedis: () => RedisClient
  /** Builds the fetcher with the caller's credentials. */
  createFetcher: (authorization: string) => LocationFetcher
}

/**
 * GET /locations/snapshot
 *
 * Serves the pre-compressed columnar location list exactly as stored:
 * no JSON parsing, serialisation or compression on the request path.
 *   200 + Content-Encoding: br|gzip   full snapshot
 *   304                               client's copy (If-None-Match) is current
 */
export function createGetLocationsHandler(
  deps: GetLocationsHandlerDeps
): Hapi.Lifecycle.Method {
  return async function getLocationsHandler(
    request: Hapi.Request,
    h: Hapi.ResponseToolkit
  ) {
    const authorization = request.headers.authorization ?? ''

    let snapshot: LocationSnapshotBodies
    try {
      snapshot = await getOrBuildLocationSnapshot(
        deps.getRedis(),
        deps.createFetcher(authorization)
      )
    } catch (error) {
      logger.error(
        `Serving location snapshot failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`
      )
      return h
        .response({ error: 'Location snapshot is temporarily unavailable' })
        .code(503)
        .header('Retry-After', '10')
    }

    const { meta } = snapshot
    const common = (response: Hapi.ResponseObject) =>
      response
        .header('ETag', `"${meta.etag}"`)
        .header('Vary', 'Accept-Encoding')
        // Always revalidate: a 304 costs a few bytes, and the ETag changes
        // as soon as any location changes.
        .header('Cache-Control', 'private, no-cache')
        .header('X-Location-Count', String(meta.count))

    if (matchesIfNoneMatch(request.headers['if-none-match'], meta.etag)) {
      return common(h.response().code(304))
    }

    const encoding = negotiateEncoding(request.headers['accept-encoding'])

    if (encoding === 'identity') {
      // Rare (no mainstream browser); decompress the stored gzip once.
      const body = await gunzip(snapshot.gz)
      return common(
        h.response(body).code(200).type('application/json; charset=utf-8')
      )
    }

    const body = encoding === 'br' ? snapshot.br : snapshot.gz
    return common(
      h
        .response(body)
        .code(200)
        .type('application/json; charset=utf-8')
        // With Content-Encoding already set, hapi sends the bytes as-is and
        // skips its own compression (lib/compression.js).
        .header('Content-Encoding', encoding)
    )
  }
}
