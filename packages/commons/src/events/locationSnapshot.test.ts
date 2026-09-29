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
  encodeLocationSnapshot,
  LOCATION_SNAPSHOT_KEYS,
  LocationSnapshotFormatError
} from './locationSnapshot'
import { Location } from './locations'
import { UUID } from '../uuid'

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID

const locations: Location[] = [
  {
    id: id(1),
    name: 'Central',
    parentId: null,
    locationType: 'ADMIN_STRUCTURE',
    validUntil: null
  },
  {
    id: id(2),
    name: 'Kampala',
    parentId: id(1),
    locationType: 'ADMIN_STRUCTURE',
    validUntil: null
  },
  {
    id: id(3),
    name: 'Mulago HC',
    parentId: id(2),
    locationType: 'HEALTH_FACILITY',
    validUntil: '2030-01-01T00:00:00.000Z'
  },
  {
    id: id(4),
    name: 'Legacy',
    parentId: id(2),
    locationType: null,
    validUntil: null
  }
]

describe('location snapshot codec', () => {
  it('writes each key name once and one row per location', () => {
    const snapshot = encodeLocationSnapshot(locations)
    expect(snapshot.v).toBe(1)
    expect(snapshot.k).toEqual(LOCATION_SNAPSHOT_KEYS)
    expect(snapshot.d).toHaveLength(4)
    expect(snapshot.d[2]).toEqual([
      id(3),
      'Mulago HC',
      id(2),
      'HEALTH_FACILITY',
      '2030-01-01T00:00:00.000Z'
    ])
  })

  it('round-trips through JSON without losing data', () => {
    const wire = JSON.parse(JSON.stringify(encodeLocationSnapshot(locations)))
    expect(decodeLocationSnapshot(wire)).toEqual(locations)
  })

  it('is much smaller than the object form before compression', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      ...locations[1],
      id: id(i),
      name: `Village ${i}`
    }))
    const columnar = JSON.stringify(encodeLocationSnapshot(many)).length
    const objects = JSON.stringify(many).length
    expect(columnar).toBeLessThan(objects * 0.8)
  })

  it('finds columns by name, so column order can change', () => {
    const payload = {
      v: 1,
      k: [
        'name',
        'id',
        'validUntil',
        'locationType',
        'parentId',
        'futureColumn'
      ],
      d: [['Central', id(1), null, 'ADMIN_STRUCTURE', null, 'ignored']]
    }
    expect(decodeLocationSnapshot(payload)).toEqual([locations[0]])
  })

  it.each([
    ['not an object', 'nope'],
    ['wrong version', { v: 2, k: LOCATION_SNAPSHOT_KEYS, d: [] }],
    ['missing column', { v: 1, k: ['id', 'name'], d: [] }],
    ['row not an array', { v: 1, k: LOCATION_SNAPSHOT_KEYS, d: [{}] }],
    [
      'missing id',
      { v: 1, k: LOCATION_SNAPSHOT_KEYS, d: [['', 'x', null, null, null]] }
    ],
    [
      'unknown type',
      {
        v: 1,
        k: LOCATION_SNAPSHOT_KEYS,
        d: [[id(1), 'x', null, 'PLANET', null]]
      }
    ],
    [
      'bad parentId',
      { v: 1, k: LOCATION_SNAPSHOT_KEYS, d: [[id(1), 'x', 42, null, null]] }
    ]
  ])('rejects a payload with %s', (_, payload) => {
    expect(() => decodeLocationSnapshot(payload)).toThrow(
      LocationSnapshotFormatError
    )
  })
})
