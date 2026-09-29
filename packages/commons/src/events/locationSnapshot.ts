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
import type { UUID } from '../uuid'
import type { Location, LocationType } from './locations'

/**
 * Compact, columnar wire format for the full location list.
 *
 * Instead of 100k objects that each repeat every key name:
 *   [{ "id": "…", "name": "…", "parentId": "…", … }, …]
 * the payload lists the keys once and sends each location as a row:
 *   { "v": 1, "k": ["id","name","parentId","locationType","validUntil"],
 *     "d": [["…","…","…","ADMIN_STRUCTURE",null], …] }
 *
 * Shared by the gateway (encoder) and the client (decoder) so both sides
 * always agree on the format. Bump LOCATION_SNAPSHOT_VERSION on any
 * breaking change.
 */
export const LOCATION_SNAPSHOT_VERSION = 1 as const

export const LOCATION_SNAPSHOT_KEYS = [
  'id',
  'name',
  'parentId',
  'locationType',
  'validUntil'
] as const

export type LocationSnapshotKey = (typeof LOCATION_SNAPSHOT_KEYS)[number]

/** One location as a tuple, in LOCATION_SNAPSHOT_KEYS order. */
export type LocationSnapshotRow = [
  id: string,
  name: string,
  parentId: string | null,
  locationType: LocationType | null,
  validUntil: string | null
]

export interface LocationSnapshot {
  v: typeof LOCATION_SNAPSHOT_VERSION
  k: readonly LocationSnapshotKey[]
  d: LocationSnapshotRow[]
}

const LOCATION_TYPES: ReadonlySet<string> = new Set<LocationType>([
  'ADMIN_STRUCTURE',
  'CRVS_OFFICE',
  'HEALTH_FACILITY'
])

export class LocationSnapshotFormatError extends Error {
  constructor(message: string) {
    super(`Invalid location snapshot: ${message}`)
    this.name = 'LocationSnapshotFormatError'
  }
}

/** Server side: objects → columnar payload. */
export function encodeLocationSnapshot(
  locations: ReadonlyArray<Location>
): LocationSnapshot {
  const d: LocationSnapshotRow[] = new Array(locations.length)
  for (let i = 0; i < locations.length; i++) {
    const location = locations[i]
    d[i] = [
      location.id,
      location.name,
      location.parentId,
      location.locationType,
      location.validUntil
    ]
  }
  return { v: LOCATION_SNAPSHOT_VERSION, k: LOCATION_SNAPSHOT_KEYS, d }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Client side: columnar payload → objects.
 *
 * Columns are looked up by name (not position), so the server can reorder
 * or append columns without breaking older clients. Rows are validated
 * with cheap type checks rather than a schema library, which keeps
 * decoding 100k+ rows fast.
 */
export function decodeLocationSnapshot(payload: unknown): Location[] {
  if (!isObject(payload)) {
    throw new LocationSnapshotFormatError('payload is not an object')
  }
  if (payload.v !== LOCATION_SNAPSHOT_VERSION) {
    throw new LocationSnapshotFormatError(
      `unsupported version ${String(payload.v)}`
    )
  }
  const keys = payload.k
  const rows = payload.d
  if (!Array.isArray(keys) || !Array.isArray(rows)) {
    throw new LocationSnapshotFormatError('"k" and "d" must be arrays')
  }

  const column = (key: LocationSnapshotKey): number => {
    const index = keys.indexOf(key)
    if (index === -1) {
      throw new LocationSnapshotFormatError(`missing column "${key}"`)
    }
    return index
  }
  const idCol = column('id')
  const nameCol = column('name')
  const parentCol = column('parentId')
  const typeCol = column('locationType')
  const validUntilCol = column('validUntil')

  const locations: Location[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const row: unknown = rows[i]
    if (!Array.isArray(row)) {
      throw new LocationSnapshotFormatError(`row ${i} is not an array`)
    }
    const id: unknown = row[idCol]
    const name: unknown = row[nameCol]
    const parentId: unknown = row[parentCol] ?? null
    const locationType: unknown = row[typeCol] ?? null
    const validUntil: unknown = row[validUntilCol] ?? null

    if (typeof id !== 'string' || id.length === 0) {
      throw new LocationSnapshotFormatError(`row ${i} has no id`)
    }
    if (typeof name !== 'string') {
      throw new LocationSnapshotFormatError(`row ${i} (${id}) has no name`)
    }
    if (!isNullableString(parentId) || !isNullableString(validUntil)) {
      throw new LocationSnapshotFormatError(`row ${i} (${id}) is malformed`)
    }
    if (
      locationType !== null &&
      (typeof locationType !== 'string' || !LOCATION_TYPES.has(locationType))
    ) {
      throw new LocationSnapshotFormatError(
        `row ${i} (${id}) has unknown locationType "${String(locationType)}"`
      )
    }

    locations[i] = {
      id: id as UUID,
      name,
      parentId: parentId as UUID | null,
      locationType: locationType as LocationType | null,
      validUntil
    }
  }
  return locations
}
