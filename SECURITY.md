# Security policy

## Supported versions

Security fixes go into the latest release only. Update to the newest version on the [Releases page](https://github.com/Umbra-Lab/Omnidex/releases) before reporting.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include:

- the Omnidex version and operating system,
- what an attacker can do, and what they need first (a crafted asset pack, a malicious web page, local access),
- steps or a file that reproduce it.

You will get an acknowledgement within a week. Once a fix ships, the advisory is published with credit to you unless you ask otherwise.

## Scope

In scope: the Electron main process and its IPC surface, the renderer, the `native/uasset` parser (which reads untrusted `.uasset` files), the local protocol handler, and how Omnidex stores Epic and other credentials.

Out of scope: vulnerabilities in Epic Games, Fab or Orbital Market services themselves, and issues that need an attacker who already controls your user account.
