export const PROPOSAL_PAGE_PREFIX = 'meta/proposals/';

export const PROPOSAL_STATUSES = [
  'draft',
  'open',
  'adopted',
  'applied',
  'not_adopted',
  'withdrawn',
  'superseded',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// Statuses that record a decision, so only admins set them and they carry a
// decision note (the published rationale Governance asks for).
export const DECISION_STATUSES: readonly ProposalStatus[] = [
  'adopted',
  'applied',
  'not_adopted',
  'superseded',
];

export interface ProposalStatusInfo {
  status: ProposalStatus;
  changedAt: string;
  changedBy: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: Record<string, string>;
  appliedAt?: string;
  appliedTo?: string[];
  supersededBy?: string;
}

export const isProposalSlug = (slug: string) => slug.startsWith(PROPOSAL_PAGE_PREFIX);

export const isProposalStatus = (value: unknown): value is ProposalStatus =>
  typeof value === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(value);

export const readProposalStatus = (properties: unknown): ProposalStatusInfo | null => {
  const proposal = (properties as { proposal?: unknown } | null | undefined)?.proposal;
  if (!proposal || typeof proposal !== 'object') return null;
  const info = proposal as ProposalStatusInfo;
  return isProposalStatus(info.status) ? info : null;
};
