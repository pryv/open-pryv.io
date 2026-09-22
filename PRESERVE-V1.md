# This branch is preserved — do not delete, do not merge

`release/1.9.3` holds the final state of the **version 1** line of Pryv.io
(`1.9.3-open`). It is kept so the last v1 release stays buildable, readable and
diffable after `master` moved on to version 2.

## Do not delete it

It is the only reference to the v1 line. Tags alone are not enough: a branch is
what keeps this history visible in normal tooling and protected from garbage
collection.

## Do not merge it into `master`

Version 2 is not a continuation of this code, and nothing here should travel
forward. A merge would either do nothing or reintroduce retired v1 behaviour.

## Why automated cleanup keeps proposing it

This branch is an **ancestor of `master`** — v2 was built on top of the v1
history rather than starting from an empty tree. Any sweep along the lines of

```bash
git branch -r --merged origin/master
```

therefore lists `release/1.9.3` as "merged", which reads as "redundant, safe to
delete". It is not: the label describes ancestry, not redundancy, and the same
listing is how this branch nearly got deleted during a routine cleanup.

This file exists partly to give the branch a commit that `master` does not
contain, so it stops matching those sweeps at all. Keep it here, and keep it as
the tip.

## If you need the v1 code

```bash
git checkout release/1.9.3
```

Read `README.md` and `CHANGELOG.md` on this branch for v1 setup and history.
Version 2 lives on `master` and is documented there.
