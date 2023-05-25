# Proof of Concept for SQLite event storage

Current storage can be activated by changing the setting `database:engine` to `sqlite`

When this PoC passes the tests suites, it might be documented as an option.

## To do

- [ ] Find a better way to for FTS (full text search to handle UNARY not)
  @see: https://sqlite.org/forum/forumpost/5e894702565f50331a04a4d1ec10e37ade0f17e5a57516fac935a1cdc89a0935
- [ ] Prepare migration schemas
- [ ] Remove DB logic from 'audit' and package it
- [ ] Check if it's OK to use: unsafeMode on DB
    https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/unsafe.md
  - This is useful when performing updateMany loop (read + write)
  - some refs: https://github.com/JoshuaWise/better-sqlite3/issues/203
- [ ] CloseDb and delete files and userDelete


## License

[UNLICENSED](LICENSE)


# License

[BSD-3-Clause](LICENSE)
