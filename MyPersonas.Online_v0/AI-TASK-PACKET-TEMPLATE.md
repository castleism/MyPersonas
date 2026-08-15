# AI task packet template

Use one packet per bounded handoff. Store no secret value, OTP, browser cookie, personal recovery data, or production dump.

```yaml
task_id: YYYYMMDD-project-short-name-001
project: mypersonas-rnd
owner: human account owner
writer: one named tool/model
reviewer: different named tool/model or human
created_at: ISO-8601
deadline: ISO-8601

objective: one concrete outcome
business_reason: why this outranks the backlog
current_state:
  local: exact evidence
  pushed: exact evidence or false
  deployed: exact evidence or false
  verified_live: exact evidence or false

inputs:
  allowed:
    - exact public or approved source
  forbidden:
    - credentials, OTPs, cookies, recovery material
    - unapproved private canon or personal data
    - payment or production-write authority

scope:
  repositories: []
  files_or_areas: []
  external_systems_read_only: []
  external_mutations: []

constraints:
  max_iterations: 3
  max_tool_calls: 40
  max_wall_minutes: 90
  max_cost_usd: 0
  max_model_hops: 2
  network_data_class: public
  one_writer: true

acceptance:
  - measurable requirement
tests:
  - command or manual check
negative_tests:
  - forbidden behavior that must fail

owner_gates:
  - exact action requiring confirmation
stop_conditions:
  - unexpected charge, secret exposure, ambiguous external result
rollback_or_revocation:
  - exact safe reversal

deliverables:
  - file, diff, report, or artifact
evidence_record:
  sources: []
  commit: null
  test_run: null
  deployment: null
  live_verification: null
  provider_objects: []
  cost_usd: 0
  reviewer_decision: pending
  owner_decision: pending
```

## Handoff rule

The next model receives the packet plus referenced artifacts, not the previous model's hidden chain of thought. It independently checks the evidence. A reviewer may recommend a deploy, post, purchase, or permission, but cannot grant itself authority to perform it.
