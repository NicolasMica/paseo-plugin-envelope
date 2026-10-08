# Workflow

- Read `docs/design.md` before planning anything.
- Pick the next step from the board, as described in [Project board](#project-board): anything In Progress first, then the first Todo item in board order. Move it to In Progress when you start.
- Work one step at a time: plan only the next step, and discover the rest as we go.
- Track deferred work as GitHub issues in `NicolasMica/paseo-plugin-envelope`, never in TODO files or code comments. Give each issue a semantic title prefix (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`), add it to the Envelope project with `Priority` and `Version` set, and move it to its place in the Todo column.
- When a step finishes, close its issue from the PR (`Closes #N`) and update `docs/design.md` if a decision changed.

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
