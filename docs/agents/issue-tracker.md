# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>` (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Count open blockers**: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by` (open blockers only; 0 means startable). `gh issue view <n> --json blockedBy` also lists closed blockers, so filter it: `--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: post the explanation with `gh issue comment <number> --body "..."`, then `gh issue close <number>`. On an already-closed issue, `gh issue close --comment` drops the comment and still exits 0.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

File issues only into the user's own repo. Never file into `mattpocock/skills` (the repo these skills come from) unless the user owns it. In a fork, `gh` can default to the upstream parent, so before the first `gh issue create` of a session, check the target with `gh repo view --json nameWithOwner` and confirm it with the user if it is not their repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number>`, then `gh pr view <number> --comments` (off a TTY, `--comments` prints only the comments, not the body), and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (see **Count open blockers**, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## When a skill says "publish to the issue tracker"

Create the GitHub issue, then put it on the project board with its column and position, as described under **Adding an issue to the board**: an issue that is not on the board is not published. When publishing several issues (a spec with `to-spec`, tickets with `to-tickets`), give each one the full sequence — create, then place — before moving on to the next.

## Project board

Issues are tracked on the [paseo-plugin-envelope project](https://github.com/users/NicolasMica/projects/17), with the Status columns Backlog, Ready, In progress, In review and Done. Priority is the order of the items inside a column: the higher an item, the more important it is. The board has no priority field and its view has no sort, so the order is kept by hand, as described below.

IDs used by the commands below: project `PVT_kwHOABjIhM4Bpf7v`, Status field `PVTSSF_lAHOABjIhM4Bpf7vzhn7T7c`, Status options Backlog `7111c632`, Ready `e07aaf9b`, In progress `2950b0b1`, In review `78a27c8d`, Done `bd112fbd`.

## Writing an issue

Describe the what, not the how: the agent that implements the issue explores the codebase fresh and plans the how itself.

- Use the sections **Objective**, **Constraints** and **Expected outcome**. A bug report uses **Problem**, **Expected behavior** and **Reproduction** instead. A skill that brings its own issue template (the spec of `to-spec`, the tickets of `to-tickets`, the agent brief of `triage`) keeps its sections, written to the same standard.
- Describe behavior and contracts: what the system should do, and the interfaces, types and commands involved. Leave out file paths and line numbers, which go stale before the issue is picked up.
- Keep what you found while preparing the issue (code paths, measurements, approaches tried) as context, labelled as such, not as a prescribed solution: the implementer does not redo the investigation and stays free to choose.
- End with a **Sources** section that links everything the issue relies on: related issues and pull requests, documents, discussions, mockups. A Figma link comes with an exported image of the mockup, attached with `gh issue create --attach` or `gh issue edit --attach` (see the `github-media` skill), so the issue reads without opening Figma.

## Adding an issue to the board

Every new issue goes on the board, in its column, at the position its priority gives it. Sub-issues of an issue already on the board are added automatically but still need a column and a position. Do it right after creating the issue, without asking:

1. Add the issue and keep its item ID (for an issue already on the board, this returns its existing item ID):

   ```sh
   gh project item-add 17 --owner NicolasMica --url <issue-url> --format json --jq .id
   ```

2. Set its column: Ready when it carries `ready-for-agent` or `ready-for-human`, Backlog otherwise.

   ```sh
   gh project item-edit --project-id PVT_kwHOABjIhM4Bpf7v --field-id PVTSSF_lAHOABjIhM4Bpf7vzhn7T7c --id <item-id> --single-select-option-id <option-id>
   ```

3. Read that column top first (here Ready; replace the name in the `select` for another column):

   ```sh
   gh api graphql --paginate -f query='query($endCursor: String) { node(id: "PVT_kwHOABjIhM4Bpf7v") { ... on ProjectV2 { items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number title } ... on PullRequest { number title } ... on DraftIssue { title } } } } } } }' --jq '.data.node.items.nodes[] | select(.status.name == "Ready") | "\(.id) #\(.content.number) \(.content.title)"'
   ```

4. Put it below every item that matters more and above every item that matters less. `afterId` is the item it goes right below; leave `afterId` out to put it at the top of the column.

   ```sh
   gh api graphql -f query='mutation { updateProjectV2ItemPosition(input: { projectId: "PVT_kwHOABjIhM4Bpf7v", itemId: "<item-id>", afterId: "<item-id-above>" }) { clientMutationId } }'
   ```

5. Tell the user where you put it and why, in one sentence: "Ready, below #12 and above #15: it unblocks #15 but matters less than the regression in #12." They move it if they disagree.

Editing an issue moves it only when the edit changes its importance; then place it again from step 3.

## Starting work on an issue

When you start working on an issue, through the `implement` skill (`/implement #42`) or any other way, do this before the first change:

1. Assign it to yourself: `gh issue edit <number> --add-assignee @me`.
2. Move it to In progress on every board that contains it, not only this one. This prints one command per board; run them, or pipe the output into `sh`:

   ```sh
   gh api graphql -f query='query { repository(owner: "NicolasMica", name: "paseo-plugin-envelope") { issue(number: <number>) { projectItems(first: 20) { nodes { id project { id title status: field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } } } } }' --jq '.data.repository.issue.projectItems.nodes[] | . as $item | ($item.project.status.options[]? | select(.name == "In progress") | .id) as $option | "gh project item-edit --project-id \($item.project.id) --field-id \($item.project.status.id) --id \($item.id) --single-select-option-id \($option)"'
   ```

   A board without an In progress column prints nothing: say so to the user. When the issue is the first of its parent's children to be worked on, move the parent to In progress too, as described under **Parent issues on the board**.

3. When you open the pull request, move the issue to In review on the boards that have that column, with the same command and `In review` in place of `In progress`. On a board without an In review column, the issue stays in In progress until the merge.

## Parent issues on the board

A parent issue — the spec of `to-spec`, the map of `/wayfinder` — is published and placed like any other issue, but nobody works on it: on the board it follows its children, and only at the boundaries:

1. **First child started.** When you move an issue to In progress and its parent is not there yet, move the parent to In progress on the same boards, with the `gh project item-edit` command above.

2. **Last child closed.** When you close an issue, look at its parent's remaining open children:

   ```sh
   gh api repos/NicolasMica/paseo-plugin-envelope/issues/<parent>/sub_issues --jq '[.[] | select(.state == "open") | .number]'
   ```

   When you closed the last one, move the parent to Done on the boards that have that column. Close the parent itself only when the work it tracks is complete — a parent never closes just because its children did — and tell the user what you did either way.

These two boundaries are the only moments a parent moves: in between, children change columns without touching it.
