# Workflow

- Read `docs/design.md` before planning anything.
- Pick the next step from the board, as described in [Project board](#project-board): anything In Progress first, then the first Todo item in board order. Move it to In Progress when you start.
- Work one step at a time: plan only the next step, and discover the rest as we go.
- Prefer a maintained package over our own code when one covers the need, to avoid maintenance. Write custom code only for what no package covers.
- Track deferred work as GitHub issues in `NicolasMica/paseo-plugin-envelope`, never in TODO files or code comments. Give each issue a semantic title prefix (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`), add it to the Envelope project with `Priority` and `Version` set, and move it to its place in the Todo column.
- When a step finishes, close its issue from the PR (`Closes #N`) and update `docs/design.md` if a decision changed.

# Quality gates

Every change keeps 100% test coverage and passes the strict gates: `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`. The pre-commit hook runs these same commands on the working tree; CI runs them on the pushed commit and is the authority. Branch protection isn't available on this private repo, so never merge a PR whose checks are red or pending, and never push straight to `main`. Fix the code or the tests; never lower a threshold, exclude a file, turn a rule off or add a suppression (`oxlint-disable`, `@ts-expect-error`, `v8 ignore`) to make a check pass. A suppression is only for code that genuinely can't satisfy a rule, with its reason on the same line (`// oxlint-disable-next-line <rule> -- <reason>`).

# Project board

Work is tracked on the GitHub project `Envelope` (https://github.com/users/NicolasMica/projects/4, project number 4, owner `NicolasMica`).

## Order is priority

The manual order of the Todo column is the priority: the top item is the next one to work on. The `Priority` field (P0, P1, P2) is only a label and does not decide the order.

To pick the next task, take the first Todo item in board order, after anything already In Progress.

## Reading the order

Use the GraphQL API with `orderBy: {field: POSITION}`. `gh project item-list` returns creation order, not board order, so do not use it to find the next task.

```sh
gh api graphql -f query='{user(login:"NicolasMica"){projectV2(number:4){items(first:50,orderBy:{field:POSITION,direction:ASC}){nodes{status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} content{... on Issue{number title}}}}}}}'
```

## Changing the order

Use the `updateProjectV2ItemPosition` mutation with the project id (`gh project view 4 --owner NicolasMica --format json --jq .id`), the item id to move, and `afterId` set to the item it must follow (omit `afterId` to move to the top). Read the order back with the query above to check the result, and re-check after a batch of moves.
