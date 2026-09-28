# Tasks

## 1. Mirror backend

- [x] 1.1 Add `src/runtime-mirror.ts` with platform selection, Windows junction/hard-link materialization, validated `pi-profile-mirror.json` ownership records, and actionable hard-link errors; update `src/settings-generator.ts` to use it while retaining `syncAgentSymlinks()` compatibility. Verification: cover "Windows launch requires no symbolic-link privilege", "Windows existing file is on an incompatible volume", and "Valid Windows mirror entries are reclaimable" with `npx vitest run test/runtime-mirror.test.ts test/settings-generator.test.ts`.
- [x] 1.2 Implement deferred mutable-file recording and idempotent reconciliation for absent, identical, divergent, and cross-device cases. Verification: cover "Windows missing state file remains absent before Pi writes", "Windows deferred state is reconciled after exit", and "Concurrent divergent state fails closed" with `npx vitest run test/runtime-mirror.test.ts`.

## 2. Lifecycle integration

- [x] 2.1 Update `src/launcher/spawn.ts` and `src/launcher/runtime-cleanup.ts` to reconcile on exit and stale sweep, validate manifest ownership, and preserve ambiguous state; update `test/launcher-spawn.test.ts` and `test/runtime-cleanup.test.ts`. Verification: cover "Interrupted Windows reconciliation recovers on next launch" and "Corrupt Windows manifest fails closed" with `npx vitest run test/launcher-spawn.test.ts test/runtime-cleanup.test.ts`.
- [x] 2.2 Update `src/switching/switch-profile.ts`, `src/settings-generator.ts`, `test/switch-profile.test.ts`, and `test/settings-generator-selection.test.ts` so failed reload rollback and in-place rewrites preserve hard-link identity. Verification: cover "Symlinks survive an in-place rewrite of the same instance directory" and unrestricted MCP/trust sharing with `npx vitest run test/switch-profile.test.ts test/settings-generator-selection.test.ts`.

## 3. Platform evidence

- [ ] 3.1 Add Windows-targeted tests in `test/runtime-mirror.test.ts` and update `.github/workflows/ci.yml` with a focused Windows job plus manual dispatch. Verification: the test must assert directory junction resolution, file identity, missing-file deferral, conflict retention, and no privilege-requiring symbolic-link entry; run `npx vitest run test/runtime-mirror.test.ts` locally and the same command on `windows-latest` CI.
- [x] 3.2 Run regression checks for unchanged non-Windows behavior. Verification: `npm run check && npm test` passes on the final tree.

## 4. Documentation and acceptance

- [x] 4.1 Add `docs/adr/0015-windows-linkless-instance-mirror.md`, mark the platform-specific part of `docs/adr/0010-per-launch-instance-lifecycle.md` as narrowed, and update `docs/architecture/overview.md`. Verification: `openspec validate windows-linkless-runtime --strict`; fact checklist: managed filenames and seeded path sets → `src/settings-generator.ts`, manifest shape and link mechanisms → `src/runtime-mirror.ts`, cleanup/reconciliation ordering → `src/launcher/runtime-cleanup.ts` and `src/launcher/spawn.ts`.
- [ ] 4.2 Complete `/opsx-verify`, archive the OpenSpec change, and run final checks on the archived tree. Verification: `openspec list` reports no active `windows-linkless-runtime` change, `openspec validate --strict`, `npm run check`, and `npm test` all pass.
