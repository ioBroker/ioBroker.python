# Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	## **WORK IN PROGRESS**
-->
## **WORK IN PROGRESS**
* (@GermanBluefox) The central credentials (`system.credentials.*`) are available in the scripts as `SECRETS`, the same way the javascript adapter exposes them: `SECRETS.CameraPassword.key`. Editing a credential in the admin UI reaches the running scripts immediately. Can be switched off per instance.
* (@GermanBluefox) The editor offers the stored credentials after `SECRETS.` and that credential's fields after the next dot. The API stub describes `SECRETS` as well, so PyCharm, IntelliJ IDEA and VS Code complete it for scripts edited outside the tab.
* (@GermanBluefox) Requires Python SDK 0.11.0, which brings the decryption of the stored credentials with it instead of leaving it to an optional extra. py-controller rebuilds the environment once.

## 0.0.6 (2026-09-18)
* (@GermanBluefox) Better logging
* (@GermanBluefox) Requires Python SDK 0.10.0, the release that checks user permissions. An existing environment is rebuilt once by py-controller.
* (@GermanBluefox) Repaired the release pipeline, which had not published since 0.0.3: the admin sources are formatted, package.json is left to npm and the release script, io-package.json follows the version again, and the admin config matches its schema

## 0.0.2 (2026-09-06)
* (@GermanBluefox) Added prettier

## 0.1.0 (2024-09-05)
* (@GermanBluefox) Initial release