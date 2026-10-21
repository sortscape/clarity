# SortScape's fork of Microsoft Clarity

This is [microsoft/clarity](https://github.com/microsoft/clarity) with fixes to
`clarity-js` that stop it holding on to removed DOM nodes. SortScape's web app
(`sortscape/sortscape-web`) records with this build instead of the one the
hosted Clarity tag loads: see that repo's `docs/schedule-month-virtualization.md`
§ "Session recording memory (Clarity)" for why and for the measurements, and
the Clarity block in `app/views/layouts/layout_partials/_layouts_head.html.erb`
for how the build is swapped in.

## Branches and releases

- `master` follows upstream. Don't commit to it.
- `sortscape/<version>` is an upstream release commit plus our fixes, one commit
  each. `sortscape/0.8.72` starts at upstream's
  "Detect WebMCP presence (0.8.72)" (a8015d7).
- A tag `v<version>-sortscape.<n>` on that branch runs
  `.github/workflows/sortscape-release.yml`. It runs the clarity-js tests,
  packs `packages/clarity-js`, and attaches `clarity-js-<version>-sortscape.<n>.tgz`
  to a GitHub release. sortscape-web depends on that file's URL.
- The package keeps upstream's version (`package.json` and `src/core/version.ts`),
  so Clarity's servers see the version the hosted tag would report.

## The fixes

All in `packages/clarity-js/src/layout`, each with a test in
`packages/clarity-js/test/memory.test.ts` where there is behavior to test:

1. **Don't track links in removed subtrees.** `add()` let a node without a
   tracked parent through when `node.host` was set, meant for shadow roots;
   `<a>` and `<area>` have a `host` too.
2. **Don't track nodes under a parent that was removed.** `traverse()` yields
   between idle slices and could resume inside a subtree removed meanwhile.
3. **Drop the records of removed subtrees** 2 s after their removal, once the
   removal and any interaction events naming those nodes are encoded.
4. **Process the removals of throttled mutations** that Clarity drops while the
   page is idle.
5. **Release the load listener of removed images** (masked images that hadn't
   loaded).
6. **Key the mutation history by a hash** instead of joined selector paths.

They are worth offering upstream.

## Moving to a new upstream release

1. Fetch upstream (`git fetch https://github.com/microsoft/clarity master`) and
   find its release commit for the version the hosted tag now asks for.
2. `git checkout -b sortscape/<version> <commit>`, then
   `git cherry-pick a8015d7..sortscape/<previous version>`. Drop a fix that
   upstream has made, and resolve conflicts against upstream's code.
3. `yarn install`, `yarn build:js`, `yarn workspace clarity-js test`.
4. Push the branch, tag `v<version>-sortscape.1`, push the tag, and update the
   URL and the release passed to `swapClarityScript` in sortscape-web.
