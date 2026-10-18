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
  pullRequests?: string[];
  parent?: string;
}

// Links stored next to the status: the pull requests implementing the
// proposal and, optionally, the main proposal it is part of. They can be set
// before any status exists, so they are read separately.
export interface ProposalLinks {
  pullRequests: string[];
  parent: string | null;
}

export const PULL_REQUEST_REPOSITORY = 'permacommons/agpwiki';
export const PULL_REQUEST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/permacommons\/agpwiki\/pull\/([1-9][0-9]{0,6})(?:[/?#].*)?$/i;
export const MAX_PULL_REQUESTS = 20;

export const pullRequestUrl = (number: number | string) =>
  `https://github.com/${PULL_REQUEST_REPOSITORY}/pull/${number}`;

// Normalize a pull request link to its canonical URL, or null if it is not a
// pull request on the Agpedia software repository.
export const normalizePullRequestUrl = (value: string): string | null => {
  const match = PULL_REQUEST_URL_PATTERN.exec(value.trim());
  return match ? pullRequestUrl(match[1]) : null;
};

export const pullRequestNumber = (url: string): number | null => {
  const match = PULL_REQUEST_URL_PATTERN.exec(url);
  return match ? Number(match[1]) : null;
};

export const isProposalSlug = (slug: string) => slug.startsWith(PROPOSAL_PAGE_PREFIX);

export const isProposalStatus = (value: unknown): value is ProposalStatus =>
  typeof value === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(value);

const readProposalObject = (properties: unknown): Record<string, unknown> | null => {
  const proposal = (properties as { proposal?: unknown } | null | undefined)?.proposal;
  return proposal && typeof proposal === 'object' ? (proposal as Record<string, unknown>) : null;
};

export const readProposalStatus = (properties: unknown): ProposalStatusInfo | null => {
  const info = readProposalObject(properties) as unknown as ProposalStatusInfo | null;
  return info && isProposalStatus(info.status) ? info : null;
};

export const readProposalLinks = (properties: unknown): ProposalLinks | null => {
  const proposal = readProposalObject(properties);
  if (!proposal) return null;
  const pullRequests = Array.isArray(proposal.pullRequests)
    ? proposal.pullRequests.filter((item): item is string => typeof item === 'string')
    : [];
  const parent = typeof proposal.parent === 'string' && proposal.parent ? proposal.parent : null;
  return pullRequests.length || parent ? { pullRequests, parent } : null;
};
