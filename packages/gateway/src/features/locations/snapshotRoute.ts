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
import { ServerRoute } from '@hapi/hapi'
import { Location } from '@opencrvs/commons'
import { redis } from '@gateway/utils/redis'
import { api } from '@gateway/v2-events/events/service'
import {
  LocationFetcher,
  scheduleLocationSnapshotRebuild
} from './snapshotCache'
import { createGetLocationsHandler } from './snapshotHandler'

/** Reads every location (active and inactive) from the events service. */
function createFetcher(authorization: string): LocationFetcher {
  return async (): Promise<Location[]> =>
    api.locations.list.query(undefined, {
      context: { headers: { Authorization: authorization } }
    })
}

export const getLocationsHandler = createGetLocationsHandler({
  getRedis: () => redis,
  createFetcher
})

/**
 * Call after locations change (create / update / sync). Rebuilds the
 * snapshot in the background; the ETag changes, so clients download the
 * new list on their next sync.
 */
export function rebuildLocationSnapshot(authorization: string | undefined) {
  if (!authorization) return
  scheduleLocationSnapshotRebuild(
    redis,
    createFetcher(authorization),
    'locations-changed'
  )
}

export const locationSnapshotRoute: ServerRoute = {
  method: 'GET',
  path: '/locations/snapshot',
  handler: getLocationsHandler,
  options: {
    // Uses the gateway's default JWT auth: any logged-in user.
    tags: ['api'],
    description:
      'Full location list for offline use: columnar JSON, pre-compressed (br/gzip), ETag-validated'
  }
}
