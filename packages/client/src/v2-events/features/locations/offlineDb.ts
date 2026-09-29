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
import Dexie, { type EntityTable } from 'dexie'
import type { Location } from '@opencrvs/commons/client'

/** A location as stored offline: the same shape the API uses. */
export type LocationRecord = Location

export interface SyncMetaRecord {
  /** e.g. 'locations' */
  key: string
  /** ETag of the snapshot currently stored (sent back as If-None-Match). */
  etag: string
  count: number
  syncedAt: string
}

export class OfflineDatabase extends Dexie {
  locations!: EntityTable<LocationRecord, 'id'>
  syncMeta!: EntityTable<SyncMetaRecord, 'key'>

  constructor(name = 'opencrvs-offline') {
    super(name)
    this.version(1).stores({
      // &id = primary key; parentId / locationType indexed for tree lookups
      locations: '&id, parentId, locationType',
      syncMeta: '&key'
    })
  }
}

export const offlineDb = new OfflineDatabase()
