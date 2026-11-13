---
# General-purpose child, aligned with opencode's built-in `general` subagent
# (packages/core/src/plugin/agent.ts:63): same trigger sentence, no system
# prompt, and no `tools:` line so it inherits pi's default set (read, bash, edit,
# write) plus the parent's model and thinking — opencode's general likewise
# inherits everything. Its two extra denials have no line here: pi has no
# `question` tool for children, and recursion is already blocked because a child
# pi runs with PI_SUBAGENT_CHILD=1, where this extension never registers.
description: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.
---
