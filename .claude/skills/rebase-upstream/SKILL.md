---
name: rebase-upstream
description:
  Only use this when explicitly asked for. This skill rebases the current branch onto the upstream
  branch, then runs some deployment commands.
user-invocable: true
---

- first, check if the current branch is up to date with the upstream branch. If not, rebase the
  current branch onto the upstream branch.
- then run these commands
  - (from root of project) `npm run build -w @open-inspect/shared`
  - then cd to `./terraform/environments/production`
  - then run `terraform apply -auto-approve`. this will take a while, like 5-10 minutes, so be
    patient, wait for output.
  - tf apply usually fails the first time with a message about "inconsistent final plan". it pretty
    much always works the second time though.
