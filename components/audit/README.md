# audit

Pryv.io audit logic.

**Make sure to read the project's main README first.**


## About configuration files (`config`)

Theses configurations files are for the test environment only.
The values exposed there should be reported in api-server config files.


## Temp notes, TODO: cleanup

For tests on Linux .. the command to watch syslog is "sudo tail -f /var/log/syslog"
Make sure user user has sudo rights


Keep track of question and tasks

- Perki: For login, I set the access.id to 'password' <= to be discussed
    Same for Account / changePassword and requestResetPassword

Hard coded ids:
  - password
  - password-reset-request
  - password-reset-token


! WTF -- api.register('auth.usernameCheck' in method / register
Was implemented in dnsLess=False but seems it was never used

!! Check that skipAudit for 'auth.usernameCheck' and 'auth.emailCheck' does not open security issue..


# License

[BSD-3-Clause](LICENSE)
