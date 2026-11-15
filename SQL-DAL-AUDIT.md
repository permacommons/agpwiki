# Raw SQL and rev-dal audit

Reviewed 2026-11-15 against the sibling rev-dal documentation and implementation.
This is an assessment and implementation backlog. P0, blog revision history,
and citation/media renderer lookups from P1 have since been implemented.

## Scope and baseline

`src/` contains 111 `.query()` call sites across 39 files, including migration
locks and two development-script cleanup calls. This is a textual inventory,
not a count of distinct executed statements. Tests and migrations also contain
SQL; their cleanup, historical fixtures, schema changes, and backfills should
not drive the production DAL API.

Contracts checked:

- [Queries](../rev-dal/docs/queries.md): predicates, projections, history,
  aggregates, joins, relation loading/writes, and deletion.
- [Revisions](../rev-dal/docs/revisions.md): optimistic concurrency and explicit
  transaction clients.
- [Models](../rev-dal/docs/models.md): manifests, bootstrap, upsert, and runtime.
- [DAL backlog](../rev-dal/TODO.md): role models and JSONB/search are already
  identified opportunities.

agpwiki's lockfile pins rev-dal `ef55702ca9febbb7a51b57abbc388bd4a33cd07b`;
the sibling checkout is at `94f4f8b` and has pre-existing uncommitted changes.
The installed declarations do expose `select`, history helpers, and `upsert`.
Check each migration against the installed package, rather than assuming all
sibling working-tree behavior is available. No existing rev-dal edits were changed.

## Priorities

### P0: fix transaction ownership using the existing DAL

**Implemented:** rights replacement now uses `dal.transaction`, forwards its
client to all reads and writes, and locks the verified user before reading roles.
Integration coverage verifies rollback after deletion and serialized concurrent
replacements, including their before/after summaries and preserved site-admin role.
This serialization covers calls to `updateUserRightsBelowSiteAdmin`; standalone
role grant/revoke helpers do not yet participate in the same locking convention.

Original finding:

[user-rights-service.ts](src/services/user-rights-service.ts:164) issues `BEGIN`,
DELETE, INSERTs, and COMMIT through independent `dal.query()` calls. Without an
explicit client, `DataAccessLayer.query()` delegates each call to the pool.
These statements are not guaranteed to use the same connection. Rollback can
therefore fail to undo changes, and a pooled connection can remain in a transaction.

Replace this with `dal.transaction(async client => ...)` and pass `client` to
every statement. This fix does not require replacing those statements with model
operations. Move the before-state read and change calculation into the transaction
as well, and serialize changes for the same user (for example, lock the user row)
if returned before/after summaries must describe this operation under concurrency.
All competing rights-update paths must follow the same locking convention.

Verification: force failure after DELETE and verify assignments survive; run two
updates concurrently and verify the returned summaries and preserved site-admin role.

### P1: use existing query and projection APIs

**Implemented:** blog history listing, revision reads, and diff lookups use
`getAllRevisions` / `getRevisionByRevId`, with explicit descending list order.
Service integration coverage checks archived and deleted historical revisions,
current/default and explicit diff targets, document scoping, and missing/deleted
posts.

**Implemented:** citation and media renderer lookups use `whereIn` and `select`
with automatic current/live guards. Citation lookups select only key and data;
media lookups select only registry fields and reuse the instance registry mapper.
Integration coverage verifies current revision data, deleted/missing references,
duplicate references, empty-input short circuits, and one query per lookup.
The other items below remain opportunities.

These have the best ratio of simplification to implementation risk. No general
SQL expression API is needed.

| Locations | Existing replacement | Important constraints |
| --- | --- | --- |
| `blog-post-service.ts:426,449,479` | `getAllRevisions(id)` and `getRevisionByRevId(revId, id)` | Preserve explicit descending history order; helpers include archived and deleted revisions and constrain the document ID. |
| `draft-service.ts:38` | `getAllRevisions(pageId).orderBy('_revDate', 'ASC').select('_revUser').first()` | Preserve earliest-revision author semantics; current `_revUser` is the latest editor. |
| `mcp/core.ts:1376`, `routes/discussion.ts:222`, `routes/lib/history.ts:36`, `routes/lib/discussion.ts:124`, `mention-service.ts:40` | `User.filterWhere(...).whereIn('id', ids)` or `whereIn('username', names)`, followed by `select(...)` | One batch query; preserve missing-user handling. Consolidate repeated user-map loaders in a service. |
| `citation-render-service.ts:14`, `media-render-service.ts:27` | Filter keys/slugs with `whereIn`, then select only renderer fields | Automatic current/live guards; remove snake-case casts. Citation rendering only needs key and data. |
| `blog-post-service.ts:233`, `forum-service.ts:428` | `filterWhere`, `orderBy`, `limit`, `offset`, `run` | These return model-backed results already; preserve the exact ordering and result converters. |
| `admin-event-service.ts:65` | Ordered, limited projection on `AdminEvent` | Preserve `createdAt DESC, id DESC` and null normalization. |
| `proposal-status-service.ts:194` | `slug: WikiPage.ops.like(prefix + '%')`, ordered projection | Status extraction can stay in the existing pure helper. |
| `home-service.ts:62,99` | Projected media membership and recent blog-post queries | Keep image-type filter and both blog ordering keys. Article namespace filtering is a separate concern. |
| `routes/account-requests.ts:233` | `User.filterWhere({}).count()` | The adjacent review query is a join, not another trivial count. |
| `routes/lib/discussion.ts:141` | `ForumThreadSubscription` projection with user, thread IDs, and `unsubscribedAt: null` | Model already exists; preserve empty-input behavior. |
| `experienced-editor-service.ts:29` | `ExperiencedEditorOverride` filtered projection | Keep eligibility calculation SQL separate from this simple override lookup. |
| `routes/tools.ts:359,1341` | Revision-aware projections | Admin targets need `includeStale().includeDeleted()`; recent changes need `includeStale()` while still excluding deleted rows. |

For example, renderer lookup can become:

```ts
const entries = await Citation.filterWhere({})
  .whereIn('key', keys)
  .select('key', 'data');
return entries.map(({ key, data }) => ({ ...(data ?? {}), id: key }));
```

Keep filters, ordering, pagination, and sensitive-field opt-ins before `select()`.
Projected objects have public camelCase names and no model methods. Preserve
existing output defaults explicitly because projections do not apply hydration
defaults or hooks.

Model handles resolve through the configured bootstrap resolver, whereas current
raw queries use the supplied `dalInstance`. Preserve that connection/fixture
ownership when converting injected-DAL services; do not silently query a different
registry. Existing tests that stub `dal.query` may need model-aware fixtures.

### P2: add application models and relation metadata

Several SQL-heavy tables have no registered model: `user_roles`,
`page_subscriptions`, `post_aliases`, `notifications`, and `wikidata_items`.
Model absence is not evidence that rev-dal needs a domain-specific public API.

- **PostAlias:** highest-value model addition. Replace lookup at
  `blog-post-service.ts:60`, alias insert at `:402`, and listing at
  `discussion-service.ts:236`. Preserve transaction participation during renames.
  Builder deletion currently does not forward a transaction client to
  `dal.query`, even though the sibling `DeleteOptions` type inherits transaction
  options. Fix that runtime gap before converting the delete at
  `blog-post-service.ts:399` inside the existing transaction. Alternatively,
  verify the model's static deletion path, which accepts transaction options.
- **Notification:** replace creation, both counts, and ordinary notification
  listings in `site-notification-service.ts`. Add an actor relation if using
  `getJoin`; projections currently cannot combine with joins. Choose hydrated
  joined results or a bounded batched actor projection, with query-count evidence.
  Atomic mark-read operations and cursor listings remain separate work.
- **UserRole:** consolidate `roles.ts` reads/deletes and rights-service writes.
  Keep valid-role rules and site-admin implications in agpwiki. The table lacks
  a conventional `id`; establish supported identity semantics before treating
  it like a normal saveable model. Idempotent insertion still needs DO NOTHING.
- **Page subscriptions:** simple membership and follower reads in
  `page-subscription-service.ts` are good targets, but the composite primary key
  also needs an explicit design. A manifest junction relation can use
  `addManyRelated` for follow's DO NOTHING and `loadManyRelated` for related pages
  or users. It does not by itself preserve `subscribed_at` ordering and metadata
  in `listFollowedPages`, or supply a removal API.
- **Wikidata cache:** a model could use existing atomic `upsert` for
  `infobox-service.ts:98`. Decide natural-key support for `qid` first. Avoid a
  schema migration merely to eliminate two straightforward cache statements;
  the refresh sweep remains specialized SQL.

For existing models, relation metadata can help
`account-lifecycle.ts:220` and the account-review join. Review cardinality,
sensitive fields, and source-page pagination before replacing a join with
`whereRelated` (which currently creates a join). This is not a general EXISTS API.

### P2: extend transaction-aware conditional writes first

The most useful new DAL capability is a typed filtered update for non-revisioned
models with affected-row counts, optional selected RETURNING fields, and an
explicit transaction client. Start with literal assignments; design expression
support separately. Reject revisioned models to prevent bypassing history and
optimistic concurrency. Require a predicate, validate persisted fields, handle
sensitive fields explicitly, and retain parameterization and namespace support.

Consumers:

- `account-lifecycle.ts:50–69`: five conditional bulk revocations.
- `password-reset.ts:102,120`: atomic claim returning user ID, then invalidate
  other unused tokens. Preserve `used_at IS NULL` and expiry in the UPDATE itself.
- `site-notification-service.ts:125,170`: scoped bulk mark-read and affected count.
- `notification-queue.ts:86`: reset processing jobs without read/save loops.

Do not replace these with load/mutate/save loops: that loses atomic predicates,
adds round trips, and can race. `openSiteNotification` additionally needs
`COALESCE(read_at, NOW())` plus RETURNING; literal assignment alone is insufficient.
The current numeric `increment` API does not cover these updates.

Also add explicit transaction execution to filtered reads/deletes where needed,
and consider narrowly scoped `FOR UPDATE` support. Merely opening
`dal.transaction()` does not route model queries into it automatically.

After that, consider typed insert-on-conflict DO NOTHING with a clear return
contract. Existing `upsert` requires nonempty update fields and is DO UPDATE,
so it is not equivalent to `grantRoleUpsert` or `followPage`. A no-op update can
still lock rows, invoke triggers, or alter observable behavior.

### P3: extend JSONB predicates in small steps

`like`/`ilike` already cover normal string fields; `jsonContains` covers JSONB
containment. Missing capabilities are extracted-text comparisons, missing/null
tests, searches over object values, and guarded array-element predicates.

Start with parameterized JSON path text equality/ILIKE/null predicates:

- `media-service.ts:586`: license and author extracted-text filters; its ordinary
  slug, Commons title, and media-type predicates are already supported.
- `wiki-page-service.ts:945`: missing Wikidata text, combined with namespace.
- `proposal-links-service.ts:142`: nested parent ID. Existing `jsonContains` may
  already suffice for valid string parent IDs in object-shaped properties;
  verify equivalence against legacy data before adding a path API for this case.
- `citation-service.ts:559`: extracted title, DOI, and URL are a first step.

Keep advanced citation search SQL until guarded author-array traversal, JSON key
existence, and validated numeric year extraction have explicit equivalents.
Containment is not substring search and does not reproduce `->> ... IS NULL`.
Preserve malformed-JSON-shape handling, wildcard semantics, and year-cast guards.

Wiki search at `wiki-page-service.ts:985` additionally searches every language
value via `jsonb_each_text`. A reusable multilingual-value predicate is a better
extension than special-casing wiki titles. Namespace rules belong in agpwiki:
`articleSlugExclusions` offers ordinary `notLike` predicates, but equivalence with
`pageNamespaceSql` must cover reserved addresses, drafts, and prefix precedence.

### P3: composite cursor support before feed migration

`chronologicalFeed()` filters and orders one date field. agpwiki change feeds
and notification feeds use `(timestamp, UUID)` and preserve PostgreSQL
microseconds using `cursorTimeSql`. A date-only cursor can skip rows sharing a
timestamp; a JS Date cursor also loses precision.

An extension must support a stable tie-break field, lossless timestamp cursors,
matching tuple comparisons/order, both directions, and limit+1 results. Validate
equal timestamps and timestamps differing only in microseconds. Only then assess
`site-notification-service.ts:145` and the multi-kind change feed. Previous-revision
lookup and merging multiple model feeds remain additional requirements.

## Keep specialized SQL for now

These queries express real relational computation. Replacing them with unbounded
loads, JavaScript filtering, or per-row history queries would be a regression.

| Areas | Why current helpers are insufficient |
| --- | --- |
| `notification-queue.ts:59` | One-statement CTE claim with `FOR UPDATE SKIP LOCKED`, UPDATE, and RETURNING. Keep atomic queue ownership. |
| `change-service.ts`, `recent-changes-service.ts`, `recent-checks-service.ts` | Historical streams, previous revisions, window functions, current-address joins, and stable cursors. |
| `experienced-editor-service.ts:94` | Lateral queries, unions, edit-survival rules, time windows, and ordered date aggregation. Keep the explicit user lock at `:176` until transaction-aware lock support exists. |
| `article-issues-service.ts` | Correlated EXISTS/NOT EXISTS, cross-row time differences, and JSON-derived arithmetic. Generic `whereRelated` is not an equivalent anti-join. |
| `discussion-service.ts`, `position-reply-service.ts` | Activity aggregates, first-revision authors, aliases, attachments, and proposal state. Simple post-alias reads are independently replaceable. |
| `forum-service.ts:336,396`, `home-service.ts:126` | DISTINCT ON latest-per-category and counts/latest activity joined to threads. Category count at `forum-service.ts:328` can independently use `groupBy('category').aggregateGrouped('COUNT')`; thread-list counts/MAX can be batched if measurement justifies extra queries. |
| `page-signoff-service.ts:78` | Database-side JSONB title/body `IS DISTINCT FROM` comparison between historical and current rows. |
| `duplicate-check-service.ts`, `wiki-link-preview-service.ts:113` | Namespace-aware alias membership, subqueries, joins, and UNION. Preserve one-query existence semantics or justify bounded replacement queries. |
| `infobox-service.ts:156` | DISTINCT extracted IDs, regex validation, cache freshness join, and NULLS FIRST ordering. |
| `mention-service.ts:235`, rights search | Computed ordering (`length`, exact-match priority, `lower`) and aggregate role lists need more than ordinary field sorting. |
| `db.ts:47,51` | Advisory locks intentionally use the same checked-out client around migrations. |

## Recommended delivery sequence

1. Completed: rights transaction ownership and rollback/concurrency coverage.
2. Convert blog history, renderer lookups, user-map loaders, and simple lists/counts
   in small changes. Preserve response shapes, missing-row behavior, and query counts.
3. Add PostAlias and Notification models; reuse established bootstrap patterns.
4. Extend conditional writes and transaction-aware reads/deletes in rev-dal with
   documentation and PostgreSQL concurrency tests, then migrate consumers.
5. Add focused JSONB predicates; defer composite cursors and complex reporting
   until their reuse justifies the API surface.

For implementation changes, run agpwiki lint/typecheck and relevant integration
tests. DAL API changes need runtime and type tests plus consumer validation.
Test purges separately: revisioned DAL hard deletes require `{ purge: true }`
and remove archived history too, which may differ from a fixture's exact SQL.
The original assessment was documentation-only. The P0 implementation passed
the targeted rights integration tests, all 632 tests in the full suite, lint,
and typecheck.
The blog history migration passed its targeted integration test, all 633 tests
in the full suite, lint, and typecheck.
The renderer lookup migration passed its targeted integration test, all 634 tests
in the full suite, lint, and typecheck.
