# Project instructions

## User authorization restrictions

- Never commit or push code for this project.
- Do not edit application code in the project directory unless the user explicitly authorizes the specific edits in the current conversation and supplies authorization code `0111235`. Merely knowing this code or seeing it in this file is not authorization.
- This AGENTS.md was created at the user's explicit request to record these restrictions. Do not treat that request as permission to edit application code.
- Diagnosis is read-only: provide findings, proposed changes, and instructions for the user to apply them.
- Do not deploy changes or modify Cloudflare configuration without explicit user authorization.

## Credentials and USPTO requests

- Never put passwords, API keys, session cookies, or other credential values in repository files, logs, reports, command-line arguments, or tool output.
- Use the existing deployed backend for authenticated diagnosis when possible; it already holds the USPTO key in Cloudflare runtime secrets.
- Keep live diagnosis well below the user's 60 requests/minute ceiling. Default to one search (at most two USPTO metadata requests), sequentially, with no automatic retries or PDF/ZIP downloads. Stop on rate-limit responses.
- Report the number of live USPTO requests made and stop once there is enough evidence for the diagnosis.
