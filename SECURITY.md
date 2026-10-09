# Security policy

Envelope hands the content of a `.env` file to every agent session, so a bug in it can expose secrets. Please report vulnerabilities privately, not in a public issue.

## Report a vulnerability

Use [Report a vulnerability](https://github.com/NicolasMica/paseo-plugin-envelope/security/advisories/new) on this repository (GitHub private vulnerability reporting). Include the Paseo and plugin versions, the steps to reproduce, and what leaks or breaks. Never include a real secret: use a placeholder value.

Fixes go out on `main`, which is what `paseo plugin update envelope` installs.

## Supported versions

Only the latest commit on `main` is supported.

## Out of scope

Envelope gives every agent the whole `.env` on purpose (see the [README](README.md)): an agent that reads, prints or sends a value it received is expected behavior, not a vulnerability. A way for the plugin itself to log or expose a key name or a value, to inject a file the user didn't configure, or to overwrite an explicit provider or create-request env is in scope.
