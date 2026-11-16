import { createHash } from 'crypto';

/** SHA-256 hex of a claim token; the formula V452 and V461 use in SQL. */
export function agentWorkClaimTokenDigest(claimToken: string): string {
  return createHash('sha256').update(claimToken, 'utf8').digest('hex');
}

/**
 * The stored claim digest to compare in SQL. V463 backfills old claims so the
 * V461 fallback can be removed before a later release revokes raw-token reads.
 */
export function claimDigestSql(alias?: string): string {
  return alias ? `${alias}.claim_token_digest` : 'claim_token_digest';
}
