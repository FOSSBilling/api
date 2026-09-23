# RFC 0001 — Extensions v2 contract tidy (breaking, still v2)

- Status: **implemented** (API + site co-migrated; see contract.test.ts).
- Scope: contract-only. No D1 schema change in this RFC unless flagged `migration?`.
- Constraint: only caller is the `extensions` site; API + site land in one coordinated release. Base path stays `/extensions/v2`. No v3.
- Style: **action-oriented, normalized** — not REST-ified into generic `PATCH {status}` (see §0).

## 0. Style decision (locked)

Resource CRUD stays REST (`POST/GET /extensions`, `PUT /extensions/{id}`, `DELETE` withdraw, `PUT /developers/me`, `PATCH /users/me`). Workflow transitions stay explicit verbs (`POST …/approve|reject|delist|relist|claim|cancel|transfer|revoke|accept|reverify`). Rationale: each verb owns distinct auth, validation, atomicity, and side-effects (mail + `revalidateCatalogue()`); merging into one `PATCH` forces role-conditional bodies and a branched handler that is harder to document, generate clients for, and review. A unified `PATCH` was evaluated and rejected.

## 1. Inventory (current, 29 operations)

Extensions:

- `GET /extensions?scope=public|mine|all` (+`type,developer_id|status,q,limit,cursor`) — cursor `{next_cursor,has_more}`
- `GET /extensions/{id}` — role-aware union (published vs `OwnedExtension`)
- `POST /extensions` → 201 pending — `ExtensionCreateSchema`
- `PUT /extensions/{id}` → 202 pending — `ExtensionUpdateSchema`, owner-only
- `DELETE /extensions/{id}` — withdraw unpublished only
- `GET /extensions/{id}/revisions` — owner-or-moderator history, cursor, newest-first
- `GET /revisions?status` — moderator queue, cursor, oldest-first
- `POST /extensions/{id}/revisions/{revisionId}/approve` (note optional) / `reject` (note required) — `?notify=false` opt-out, `{…, notified}`
- `POST /extensions/{id}/delist` (`{reason}` required) — no inverse (gap)
- `GET /moderation/counts`

Developers / ownership / users:

- `GET /developers?status=all|unapproved` — **offset** `{limit,offset,has_more}`, tag `Moderation`
- `GET /developers/me`, `PUT /developers/me`, `DELETE /developers/me`, `POST /developers/me/reverify?check_url`, `GET /developers/{id}` (role-aware)
- `POST /developers/{id}/claim`, `POST /developers/claims/{id}/cancel`, `GET /developers/claims?scope=mine|pending` — **offset**; `scope=pending` ignores `status` filter
- `POST /developers/claims/{id}/approve|reject`, `POST /developers/{id}/approve`, `GET /developers/{id}/history` — **offset**
- `POST /developers/{id}/transfer`, `POST /developers/{id}/transfer/revoke`, `POST /developers/transfers/accept {token}`
- `PUT /users/me/identity` (assertion scope only), `GET /users/me`, `PATCH /users/me`, `DELETE /users/me`

Inconsistencies: two pagination envelopes; three `scope`/`status` vocabularies; `cancel`/`revoke` as `POST` (kept deliberately, see §3); tags mixed by role vs resource (`listDevelopers` under `Moderation`); `?notify` + `notified` copy-pasted per handler; four error mappers (`statusFromErrorCode`, `statusFromWriteErrorCode`, `statusFromOwnershipErrorCode`, `statusFromGithubErrorCode`); no `relist`; reservation rules in comments + migration `0020` only.

## 2. Pagination — cursor everywhere

- Retire offset envelope (`OffsetPaginationSchema`, `offsetPageFromQuery`, `offsetPaginationFrom`) for v2 lists. Single envelope `PaginationSchema {next_cursor, has_more}` + `limit (1-100, default 50)` + opaque `cursor`.
- Applies to: `GET /developers`, `GET /developers/claims`, `GET /developers/{id}/history`. Queue ordering preserved (admin lists: newest-first default unless queue semantics say oldest-first).
- Frontend replaces `fetchWholeList` offset walker (`extensions/src/lib/api/client.ts`) with cursor walker (same shape as `listMyExtensions`).
- `migration?` No.

## 3. Verbs — canonical `POST /{resources}/{id}/{verb}`

- Keep `POST` for all transitions, including `cancel` and `revoke`. `DELETE` means "row gone" (`DELETE /extensions/{id}` withdraw, `DELETE /developers/me`, `DELETE /users/me`) — `cancel`/`revoke` leave history rows, so `POST …/cancel|revoke` is correct, not an accident.
- No renames except additions below. `transfers/accept` stays `POST /developers/transfers/accept {token}` (token is the address, not an id — nesting under `{id}` would leak existence).
- **Add `POST /extensions/{id}/relist`** (moderator-only): inverse of `delist`, requires `{note?}` (optional, trimmed, max 2000), clears `delisted_at/delist_reason`, `revalidateCatalogue()`, same `?notify` + `notified` shape, 409 when not delisted / unpublished. `migration?` No.
- `migration?` No.

## 4. Scope — one pattern

- `?scope` selects projection; `?status` narrows within it; mismatched combos 422 (extend the rule already enforced in `routes/public-extensions.ts`).
- `GET /developers?scope=all|unapproved` (replaces `?status=`; `status` param removed). Default `all`.
- `GET /developers/claims?scope=mine|pending` kept; `status` narrows `mine` only, ignored-with-422 on `pending` (today silently ignored — tighten to 422).
- `GET /extensions?scope=public|mine|all` unchanged.
- `migration?` No.

## 5. Notify + result envelope — one helper, same wire

- Keep `?notify=false` query (checkbox-checked default sends). Do not move to body — avoids touching every form handler in `extensions/src/pages/account/admin/**`.
- Add a shared `NotifiedSchema` fragment for the `notified: boolean` field ("recipient resolved and send dispatched, delivery async") and use it in all seven moderation transitions in `routes/moderation.ts` + `routes/ownership.ts` instead of the hand-restated descriptions.
- `migration?` No.

## 6. Errors + tags — one mapper, tags by resource

- Collapse `routes/errors.ts` to `statusFromErrorCode` (reads: 404/500 + github 422/429/503) + `statusFromWriteErrorCode` (writes: 403/404/409/500). Delete `statusFromOwnershipErrorCode` (fold into write mapper). No per-handler ternaries beyond github codes.
- Tags by resource: `Extensions` (all `/extensions*`, `/revisions`, `/moderation/counts` moves to `Extensions`? keep `Moderation` only for `/moderation/counts` + queue reads — **decision:** `GET /revisions`, `GET /moderation/counts` stay `Moderation`; everything else by resource: `listDevelopers` moves `Moderation` → `Developers`; claim approve/reject move `Moderation` → `Developers`). Scalar grouping then matches paths.
- Document status-code rule: `201` created (claim, extension create), `202` accepted-pending (propose edit), else `200`. `422` = zod/contract failure via `defaultHook`; `409` = guarded-write no-op with diagnosed reason.
- `migration?` No.

## 7. Path reservations + registration order — contract test

- Reserve `me`, `claims`, `transfers` under `/developers`; `mine` needs no reservation (ordinary id now). Keep registration order: static before `/{id}` (`index.ts` comments become test assertions).
- Add `test/services/extensions/v2/contract.test.ts`: reserved ids unreachable as data ids (mirrors migration `0020` logic), static routes win over param routes, `?scope` misuse matrix 422s, pagination envelope shape per route.
- `migration?` No.

## Annex A — Reviewer identity (bot, no special treatment)

`FOSSBilling Bot` is an existing account row with `is_moderator=1`. No reserved id, no new verifier, no migration. Auto-worker mints standard 60s HS256 assertions (`sub=<bot id>`, existing `bearerAssertionVerifier`) and calls canonical approve/reject. Machine-readable audit via note prefix `[auto policy=<name>/<ver> score=<0-1>] …` (fits existing `ReviewNote*` max 2000). Presentation maps bot `sub` → "FOSSBilling Bot (automatic)"; ops rule: never `DELETE /users/me` as the bot (avoids `display_name` nulling via `deleteAccount`). Shadow-mode logging (`would_approve`) precedes live auto-approve; rollout limited to readme-only diffs first (classifiable via `revision-diff`).

## Annex B — Deferred follow-up: `moderator-correct` (preview, not in this epic)

Built after this RFC lands, on canonical verbs: `POST /extensions/{id}/moderator-correct` (moderator-only, `ExtensionUpdateSchema.strict()` + `{correction_note: trim min(1) max(2000)}`, no `?notify`/mail, 404 unknown, 409 pending-exists/unpublished/delisted, single `batch()` inserting `status='approved'` row with `submitted_by=reviewer_id=moderator` + publishing + `published_revision_id`, `revalidateCatalogue()`). Frontend `account/admin/extensions/[id]/edit.astro` reusing `ExtensionForm` + preview, blocked-state when pending, `purgeCatalogue()` + flash (no-mail copy).
