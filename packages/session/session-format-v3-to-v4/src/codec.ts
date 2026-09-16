/** V4 framing: the released v3 physical codec with the v4 header version. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/** V4 codec: v3 framing and validation, version 4. */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    return { ...releasedV3SessionFormatCodec.decodeHeader(v3PhysicalHeader(value)), version: 4 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV3SessionFormatCodec.createDecoder(v3PhysicalHeader(value), recovery)
    return {
      header: { ...decoder.header, version: 4 },
      decodeRow: (row, context) => {
        decoder.decodeRow(row, context)
      },
      finish: context => decoder.finish(context),
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    return { ...releasedV3SessionFormatCodec.encodeHeader({ ...header, version: 3 }, inheritedEventCount), version: 4 }
  },
  encodeEvent(event) {
    return releasedV3SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/** Present one v4 physical header to the released v3 codec as a v3 header. */
function v3PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  return { ...header, version: 3 } as SessionFormatHeader
}
