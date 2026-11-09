# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainer sees the report.

Include what you found, the steps to reproduce it, and the browser and version. This is a one-person project, so fixes come as quickly as the problem allows, and you'll be told when one ships.

## What counts

The app is static files that run in your browser, so the useful reports are about:

- the release's content security policy, headers or packaging (see `docs/packaging-security.md`)
- anything that sends data to a host other than the app, the GTFS-RT archive or the basemap
- script injection through feed data, such as agency names, route names or CSV exports
- tampering with the pinned DuckDB extensions, or a gap in the build's checks on them
- dependencies with a known vulnerability that affects the shipped app

## Supported versions

Only the latest release on `main` gets fixes.
