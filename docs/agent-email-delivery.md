# Agent email delivery: George-only controlled send

`send_email` is a deliberately narrow operational capability: it sends only
from `agent@redbtn.io` to `george@redbtn.io`.  It rejects sender overrides,
CC/BCC, reply-to values, attachments, recipient arrays, and any other attempt
to widen that boundary.  It is not a general agent mailer.

## Non-secret prerequisites

- The engine has `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, and `EMAIL_PASS` in
  its deployed secret environment.
- The engine has `REDRUN_API_URL` and `REDRUN_AGENT_EMAIL_AUDIT_KEY`; the
  latter matches RedRun's internal service key and is configured only as a
  secret.
- RedRun's `/api/agent-email/audits` route and its database are healthy.

Do not put secret values, email bodies, or subjects in graph definitions, run
notes, cards, logs, or test evidence.

## Controlled verification

1. Configure an approved graph/tool step with `to: "george@redbtn.io"` and a
   short, non-sensitive subject/body such as `Controlled delivery check`.
2. Run it once. A successful result is exactly a sanitized object containing
   `status: "accepted"`, an `auditId`, and SMTP `messageId`.
3. Confirm the non-sensitive message arrives at George's address and that the
   RedRun audit record with that `auditId` progressed from `attempted` to
   `accepted`.
4. If the result has `AUDIT_UNAVAILABLE`, `SMTP_CONFIGURATION_FAILED`,
   `SMTP_DELIVERY_FAILED`, or `SMTP_RECIPIENT_REJECTED`, do not retry blindly.
   Investigate the matching audit ID (when supplied) and the secret
   configuration outside prompts and logs.
