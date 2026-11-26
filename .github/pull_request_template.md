## Summary
Briefly explain the change and why it improves Aexus Code.

## Key Changes
- ...

## Verification Checklist
- [ ] `npm run valid-layers-check` & `npm run typecheck-client` pass with 0 errors
- [ ] `npx eslint --max-warnings=0` passes on all modified files
- [ ] `npm --prefix extensions/aexus-agents run compile` & `npm --prefix extensions/aexus-agents test` pass
- [ ] Relevant ADE Node / Browser unit tests added or updated and passing
- [ ] Preserves zero hidden prompt injection, mutual HMAC `ADE_AGENT_TOKEN` isolation, and `ADE ⇄ IDE` Mirror Symmetry
