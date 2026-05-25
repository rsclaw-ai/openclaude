# /provider Wizard Simplification

Status: Draft (awaiting approval)
Author: derived from chat session 2026-05-26
Scope: `/provider` Add/Edit flow only — does not touch model picker, OAuth flows, or first-run auto-detect.

## Goal

Collapse the current 8-field `FORM_STEPS` wizard into 3 hard steps + 1 optional collapsed "Advanced" section. Move auth-header construction from a user-facing form field to a derived value driven by a single `api_type` selector.

## Problem

The current OpenAI-compatible Add-Provider flow shows 7 sequential steps (name → baseUrl → model → apiFormat → authHeader → authHeaderValue → apiKey → customHeaders). Three of those steps (`apiFormat`, `authHeader`, `authHeaderValue`) leak implementation details users should not have to reason about:

- `apiFormat` (chat_completions vs responses) is OpenAI-internal — meaningless for Anthropic / Gemini / Ollama.
- `authHeader` + `authHeaderValue` (two steps!) exist purely to support gateways that use non-default header names (e.g. `api-key:` instead of `Authorization: Bearer`). For the 95% case where the provider follows the canonical pattern of its protocol family, both steps are noise.

These knobs need to exist for power users, but should not be in the default linear flow.

## Design

### 3 hard steps + 1 optional advanced section

```
Step 1 of 3: API type     [openai | openai-responses | anthropic | gemini | ollama]
Step 2 of 3: API URL      (placeholder derived from api_type)
Step 3 of 3: API key      (skippable when api_type=ollama)

Advanced ▸ (collapsed by default)
  · auth_scheme override   (default derived from api_type)
  · custom_headers         (subsumes user_agent + arbitrary headers)
```

Provider `name` is auto-derived as `${api_type}@${hostname(baseUrl)}` on save. Users edit it after creation if they want a different label. (Currently the wizard forces every user to invent a name — this is friction the new flow avoids.)

Model selection stays where it is today: in the `/model` picker, not provider config. Each profile stores a primary-model hint, but it's not part of the Add wizard.

### Why drop `apiFormat` as a step

It's binary OpenAI shim metadata (`chat_completions` vs `responses`). Fold into `api_type`:
- `openai` → chat_completions transport
- `openai-responses` → responses transport
- Other api_types ignore it

This is symmetric to how `gemini` and `anthropic` are their own api_types — they implicitly carry their own transport conventions.

### Why drop `authHeader` + `authHeaderValue` as steps

Replace with `auth_scheme` (single field, advanced-only):

```
auth_scheme:
  bearer              → Authorization: Bearer ${api_key}
  x-api-key           → x-api-key: ${api_key}
  x-goog-api-key      → x-goog-api-key: ${api_key}
  header:NAME         → custom header name, raw value
  none                → no auth header sent
```

Default per `api_type`:

| api_type           | default auth_scheme |
|---|---|
| openai             | bearer              |
| openai-responses   | bearer              |
| anthropic          | x-api-key           |
| gemini             | x-goog-api-key      |
| ollama             | none                |

This solves the "domestic Anthropic-compatible gateway uses Bearer" case (e.g. Aliyun Bailian TokenPlan — addressed separately by the `aliyun-tokenplan` preset, but a generic user can pick `api_type=anthropic` + override `auth_scheme=bearer`).

### Why one `auth_scheme` enum beats current `authHeader` + `authHeaderValue` pair

The current schema lets users set arbitrary `(headerName, headerValue)` pairs for auth, which is more flexible but:

1. Sends the api_key in some derived form (e.g. `Bearer ${key}`) that the user has to construct mentally and re-type at edit time.
2. Doesn't catch typos — `Authoriztion` silently fails.
3. Conflates "which header" with "how to format the value", which are independent concerns.

The new `auth_scheme` enum encodes both as a single named convention with the api_key value injected at request time.

## What NOT to do

- **Do not auto-send `Authorization: Bearer ${key}` AND `x-api-key: ${key}` simultaneously** as a "compatibility" measure. Two reasons:
  1. Some gateways (Cloudflare AI Gateway, Azure variants) reject requests with multiple auth headers as a fingerprinting risk.
  2. Native SDKs never do this; doing so reveals the request as proxied/automated.

  Always send exactly one auth header, derived from `auth_scheme`.

- **Do not delete `authHeader` / `authHeaderValue` from the persisted schema**. Existing profiles in user `config.json` files use them. Migration must read them and translate to `auth_scheme = header:${authHeader}` on read; the new schema field becomes the source of truth going forward. Deletion can happen 2-3 releases later once profiles have been migrated on access.

## File-by-file change list

### Schema + validation
- `src/utils/providerProfile.ts` (likely; verify exact location of `ProviderProfile` interface)
  - Add `apiType: ApiType` field. Type: `'openai' | 'openai-responses' | 'anthropic' | 'gemini' | 'ollama'`.
  - Keep `authScheme` (already exists as `'bearer' | 'raw'`); extend to: `'bearer' | 'x-api-key' | 'x-goog-api-key' | { header: string } | 'none'`.
- `src/utils/providerProfiles.ts` (~1347 lines)
  - `sanitizeProfile`: read `authHeader`/`authHeaderValue`/`apiFormat` from input; on every read, derive `apiType` + `authScheme` if absent. Migration is *read-time*, no separate migration job needed.
  - `sanitizeAuthScheme` (line ~130): extend to new enum.
  - `toProfile`: pipe through new fields.

### Transport / request layer
- Wherever auth header is currently attached: replace lookups of `profile.authHeader` + `profile.authHeaderValue` with derivation from `(profile.apiType, profile.authScheme, profile.apiKey)`.
  - Likely sites: search for `authHeader` and `OPENAI_AUTH_HEADER` / `OPENAI_AUTH_SCHEME` references in `providerProfiles.ts:524, 634, 951`.
- `src/utils/providerProfiles.ts:583-588` (anthropic env emit): the `getAnthropicCredentialEnvVar()` helper added in the TokenPlan PR is the first step in this direction. Generalize to `getAuthEnvVar(apiType, authScheme)` returning the right env-var name.

### UI wizard
- `src/components/ProviderManager.tsx:151-205` — `FORM_STEPS` array
  - Replace 8 entries with: `apiType`, `baseUrl`, `apiKey`, then conditionally show advanced sub-form for `authScheme` and `customHeaders`.
  - Remove `name`, `apiFormat`, `authHeader`, `authHeaderValue`, `customHeaders` from main flow.
- `src/components/ProviderManager.tsx` `apiType` step: new `OptionWithDescription<ApiType>[]` with the 5 enum values + per-type description.
- `src/components/ProviderManager.tsx` `baseUrl` step: pull placeholder from a new `getDefaultBaseUrlForApiType(apiType)` helper.
- `src/components/ProviderManager.tsx` `apiKey` step: skip if `apiType === 'ollama'`.
- New Advanced section component: simple two-field form (auth_scheme dropdown, custom_headers textarea) shown via a "▸ Advanced" toggle.

### Descriptor metadata changes
- `src/integrations/descriptors.ts` — add `apiType` field to `OpenAIShimTransportConfig` (or similar) for self-description. NOT required for refactor but useful for preset templating.
- `src/integrations/vendors/*.ts` — most are fine; verify no descriptor relies on `authHeader` being interactively set.

### Tests
- `src/components/ProviderManager.test.tsx` (~708 LOC) — `PRESET_ORDER` may need updates. New tests:
  - Adding an OpenAI provider asks 3 steps (currently asks 7).
  - Default `auth_scheme` derives from `api_type` correctly.
  - Advanced section is hidden by default.
  - Editing a legacy profile (`authHeader` set, no `apiType`) reads back as the equivalent new-shape profile.
- `src/utils/providerProfiles.test.ts` — round-trip tests for legacy → new schema migration.
- `src/integrations/compatibility.test.ts` — should pass without changes.

### Codegen artifacts
- `src/integrations/generated/integrationArtifacts.generated.ts` — regenerate after vendor descriptor changes.
- No manual edits expected.

## Migration strategy

Schema migration is **read-time only**. No bulk rewrite of stored profiles. On each `sanitizeProfile` call:

```
if (profile.apiType === undefined) {
  profile.apiType = inferApiTypeFromProvider(profile.provider)
  // e.g. provider='openai' → 'openai', provider='anthropic' → 'anthropic'
}
if (profile.authScheme === undefined && profile.authHeader !== undefined) {
  profile.authScheme = inferAuthSchemeFromLegacyHeader(profile.authHeader)
  // 'Authorization' → 'bearer'
  // 'x-api-key' → 'x-api-key'
  // anything else → { header: profile.authHeader }
}
```

After migration on read, downstream code (transport, UI display, env emit) uses ONLY `apiType` + `authScheme`. Writes always produce the new shape; legacy fields are retained in storage for one major version, then removed.

## Out of scope

- Model selection inside provider config — stays in `/model`.
- OAuth flows (Codex, xAI) — already special-cased in ProviderManager.tsx and unaffected.
- First-run auto-detect — unaffected; produces profiles in the new shape natively.
- Multi-profile UI (selecting active, deleting, etc.) — unaffected.

## Acceptance criteria

- [ ] Adding a fresh OpenAI provider requires entering 3 fields (was 7).
- [ ] Adding an Anthropic-compatible provider with Bearer auth (e.g. Aliyun TokenPlan use case) requires only changing `auth_scheme` in Advanced — no `authHeader` form step.
- [ ] All existing provider profiles (read from `config.json` with legacy `authHeader` etc.) continue to work without user intervention.
- [ ] `bun test` passes (existing 158+ integration tests).
- [ ] `bun run integrations:check` reports artifacts current.
- [ ] No new auth headers sent simultaneously — exactly one auth header per request, derived from `authScheme`.

## Estimated scope

- ~10-15 files touched
- ~600-900 LOC net change (split roughly 30% schema/transport, 50% UI, 20% tests)
- ~1 working day of focused implementation + verification
- Should ship as its own PR; do not bundle with unrelated work
