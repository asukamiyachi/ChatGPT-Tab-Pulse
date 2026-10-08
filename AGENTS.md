# Contribution instructions

This project is a local-only Chrome Manifest V3 extension for chatgpt.com and chat.openai.com.

- Preserve `src/detector.js`, `src/overview.js`, and `src/notifications.js` as browser/Node compatible pure modules.
- Never log, persist, or transmit conversation body or credentials. Restrict host permissions to ChatGPT hosts.
- Never announce a completed task from an absent Stop button alone. Keep Work unknown unless there is explicit evidence.
- Notification permission must stay optional and opt-in. Avoid repeated alerts after worker suspension and duplicate content-script updates.
- Keep existing favicon/overview/badge behaviors backward compatible. Prefer small readable commits.
- Run `node --test tests/*.test.js` and both browser smoke tests when UI changes; add tests for both positive and negative alert transitions.
- Real logged-in Work mode E2E cannot be claimed based on mock DOM tests. State limitations clearly.
