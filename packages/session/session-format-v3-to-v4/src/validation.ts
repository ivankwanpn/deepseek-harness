/** V4 header validation and target restoration: v3 rules plus the goal-limit payload contract. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, assertV3EventAdmission, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/**
 * Validate v4 logical metadata with the released-v3 rules.
 * @param header - decoded v4 Session header.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  assertReleasedV3Header({ ...header, version: 3 })
}

/**
 * V4 admission adds no envelope rules beyond v3: the change is a plugin payload
 * shape, validated by the goal fold and the persistence catalog, not the format codec.
 * @param event - event envelope whose type and admission markers are available.
 */
export function assertV4EventAdmission(event: SessionFormatEvent): void {
  assertV3EventAdmission(event)
}

/**
 * Validate a detached v4 artifact by delegating the released v3 relationship rules.
 * The private v3 view never escapes; the returned artifact and its identities are the caller's.
 * @param artifact - detached v4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  restoreReleasedV3Artifact({ ...artifact, header: { ...artifact.header, version: 3 } }, knownEventTypes)
  return artifact
}
