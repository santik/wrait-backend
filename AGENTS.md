# wrait-backend — Project Context

**Stack:** raw-http | prisma | typescript

5 routes | 3 models | typescript


**High-impact files** (change carefully):
- src/contracts/http.ts (shared request/auth contract for every route)
- src/lib/response.ts (shared response builder)
- src/lib/prisma.ts (database client)
- src/lib/deviceToken.ts (signed device-token sign/verify)
- src/contracts/register.ts (dual-mode registration + rate limit)

**Models:** Device, CallCount, RegistrationAttempt (`prisma/schema.prisma`)

**Required env vars:** DATABASE_URL (or DATABASE_URL_UNPOOLED), NODE_ENV,
PROXY_SECRET, DEVICE_TOKEN_SECRET (HMAC key for signed device tokens)
**Optional env vars:** MAX_REGISTRATIONS_PER_IP_PER_DAY (per-IP/UTC-day cap on
tokenless registrations, default 10); REQUIRE_DEVICE_TOKEN (default strict/true;
set to "false" during the migration window to also accept legacy X-Device-Id on
quota endpoints)
**Upstream secrets:** DEEPGRAM_API_KEY, OPENAI_API_KEY, TYPESAFE_API_KEY

---

## Additional project references

- [`docs/application-description.md`](docs/application-description.md) — what the
  service does: API surface, quota model, device identity and abuse protection.
- [`docs/agent-findings.md`](docs/agent-findings.md) — durable implementation
  constraints for future sessions (auth contract, tokens, quota, migrations).
- `specs/004-quota-abuse-protection/` — the quota-abuse-protection feature
  (spec, plan, tasks, deployment runbook, review).

---

## Instructions for Codex

### Two-Step Rule (mandatory)
**Step 1 — Orient:** Use wiki articles to find WHERE things live.
**Step 2 — Verify:** Read the actual source files listed in the wiki article BEFORE writing any code.

Wiki articles are structural summaries extracted by AST. They show routes, models, and file locations.
They do NOT show full function logic, middleware internals, or dynamic runtime behavior.
**Never write or modify code based solely on wiki content — always read source files first.**

Read in order at session start:
1. `.codesight/wiki/index.md` — orientation map (~200 tokens)
2. `.codesight/wiki/overview.md` — architecture overview (~500 tokens)
3. Domain article (e.g. `.codesight/wiki/auth.md`) → check "Source Files" section → read those files
4. `.codesight/CODESIGHT.md` — full context map for deep exploration

Routes marked `[inferred]` in wiki articles were detected via regex — verify against source before trusting.
If any source file shows ⚠ in the wiki, re-run `npx codesight --wiki` before proceeding.

Or use the codesight MCP server for on-demand queries:
   - `codesight_get_wiki_article` — read a specific wiki article by name
   - `codesight_get_wiki_index` — get the wiki index
   - `codesight_get_summary` — quick project overview
   - `codesight_get_routes --prefix /api/users` — filtered routes
   - `codesight_get_blast_radius --file src/lib/db.ts` — impact analysis before changes
   - `codesight_get_schema --model users` — specific model details

Only open specific files after consulting codesight context. This saves ~2,921 tokens per conversation.